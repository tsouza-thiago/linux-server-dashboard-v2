// Comando `dashboard` (F7): controle do painel sem systemd (segundo plano com PID
// conferido), status, link de uso único e rotação do log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  isOurProcess, readPid, runningPid, panelStatus, panelPort, startPanel, stopPanel, portFree, waitForPort, openBrowser, hasSystemdUser,
} from '../../server/cli/servico.js';
import { createLoginCode, consumeLoginCode } from '../../server/http/entrar.js';
import { rotateIfNeeded, createLogFile } from '../../server/logfile.js';
import { main, isConfigured, panelUrl } from '../../server/cli/index.js';

const noSystemd = () => ({ error: new Error('sem systemctl') });

function fakeRoot(t, { env = '', script = 'setInterval(() => {}, 1000);' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-cli-'));
  fs.mkdirSync(path.join(root, 'server'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'server', 'index.js'), script);
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"9.9.9"}');
  if (env) fs.writeFileSync(path.join(root, '.env'), env);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function memOut() {
  const lines = [];
  const stream = { isTTY: false, write: (s) => { lines.push(s); return true; } };
  return { lines, stream, text: () => lines.join('') };
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('servico: reconhece só o processo que roda o server/index.js desta pasta', async (t) => {
  const root = fakeRoot(t);
  const ours = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { ours.kill('SIGKILL'); other.kill('SIGKILL'); });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(isOurProcess(ours.pid, root), true);
  assert.equal(isOurProcess(other.pid, root), false);
  assert.equal(isOurProcess(1, root), false, 'nunca o PID 1');
  assert.equal(isOurProcess(NaN, root), false);
  assert.equal(readPid(root), null, 'sem arquivo de PID');
  fs.writeFileSync(path.join(root, 'data', 'dashboard.pid'), 'lixo');
  assert.equal(readPid(root), null);
  fs.writeFileSync(path.join(root, 'data', 'dashboard.pid'), `${ours.pid}\n`);
  assert.equal(runningPid(root), ours.pid);
  const st = panelStatus({ root, home: root, run: noSystemd });
  assert.deepEqual([st.mode, st.running, st.pid, st.port], ['processo', true, ours.pid, 3000]);

  const r = await stopPanel({ root, home: root, run: noSystemd });
  assert.deepEqual([r.ok, r.wasRunning, r.mode, r.forced], [true, true, 'processo', false]);
  assert.equal(fs.existsSync(path.join(root, 'data', 'dashboard.pid')), false);
  assert.equal((await stopPanel({ root, home: root, run: noSystemd })).wasRunning, false, 'parar de novo não faz nada');
});

test('servico: processo que ignora o SIGTERM é forçado depois do prazo', async (t) => {
  const root = fakeRoot(t, { script: "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);" });
  const ours = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { stdio: 'ignore' });
  t.after(() => ours.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 150));
  fs.writeFileSync(path.join(root, 'data', 'dashboard.pid'), String(ours.pid));
  const r = await stopPanel({ root, home: root, run: noSystemd, graceMs: 300 });
  assert.equal(r.forced, true);
});

test('servico: iniciar em segundo plano grava o PID (0600) e espera a porta responder', async (t) => {
  const port = await freePort();
  const root = fakeRoot(t, {
    env: `PORT=${port}\n`,
    script: `require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1');`,
  });
  // O script falso é CommonJS: o package.json da pasta falsa não tem "type": "module".
  const r = await startPanel({ root, home: root, run: noSystemd });
  t.after(() => { if (r.pid) try { process.kill(r.pid, 'SIGKILL'); } catch { /* já saiu */ } });
  assert.equal(r.ok, true, r.error);
  assert.equal(readPid(root), r.pid);
  assert.equal(fs.statSync(path.join(root, 'data', 'dashboard.pid')).mode & 0o777, 0o600);
  assert.equal((await startPanel({ root, home: root, run: noSystemd })).already, true, 'não sobe 2 vezes');
  assert.equal(await portFree(port), false);
  await stopPanel({ root, home: root, run: noSystemd });
});

test('servico: porta ocupada por outro programa não é "tomada"', async (t) => {
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  t.after(() => blocker.close());
  const { port } = blocker.address();
  const root = fakeRoot(t, { env: `PORT=${port}\n` });
  assert.equal(panelPort(root), port);
  const r = await startPanel({ root, home: root, run: noSystemd });
  assert.equal(r.ok, false);
  assert.match(r.error, /já está em uso/);
  assert.equal(readPid(root), null);
  assert.equal(await waitForPort(await freePort(), { timeoutMs: 300 }), false);
});

test('servico: systemd de usuário quando o serviço está instalado', async (t) => {
  const root = fakeRoot(t);
  const unitDir = path.join(root, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'server-dashboard.service'), '[Unit]\n');
  const calls = [];
  let active = 'inactive';
  const run = (cmd, args) => {
    calls.push(args.join(' '));
    if (args[1] === 'is-active') return { status: 0, stdout: `${active}\n` };
    if (args[1] === 'is-enabled') return { status: 0, stdout: 'enabled\n' };
    if (args[1] === 'stop') { active = 'inactive'; return { status: 0, stdout: '' }; }
    return { status: 0, stdout: '' };
  };
  assert.equal(hasSystemdUser({ run }), true);
  const st = panelStatus({ root, home: root, run });
  assert.deepEqual([st.mode, st.running, st.enabled], ['servico', false, true]);
  assert.equal((await stopPanel({ root, home: root, run })).wasRunning, false);
  active = 'active';
  const r = await stopPanel({ root, home: root, run });
  assert.deepEqual([r.ok, r.wasRunning, r.mode], [true, true, 'servico']);
  assert.ok(calls.includes('--user stop server-dashboard.service'));
  const failing = (cmd, args) => (args[1] === 'start' ? { status: 1, stdout: '', stderr: 'Unit failed' } : run(cmd, args));
  active = 'inactive';
  const s = await startPanel({ root, home: root, run: failing });
  assert.equal(s.ok, false);
  assert.match(s.error, /Unit failed/);
});

test('servico: navegador só abre com sessão gráfica e xdg-open', () => {
  const spawned = [];
  const spawnFn = (cmd, args) => { spawned.push([cmd, ...args]); return { on() {}, unref() {} }; };
  assert.equal(openBrowser('http://x', { env: {}, spawnFn }), false, 'sem DISPLAY/WAYLAND_DISPLAY');
  assert.equal(openBrowser('http://x', { env: { DISPLAY: ':0' }, spawnFn, run: () => ({ status: 1 }) }), false, 'sem xdg-open');
  assert.equal(openBrowser('http://x', { env: { WAYLAND_DISPLAY: 'w' }, spawnFn, run: () => ({ status: 0 }) }), true);
  assert.deepEqual(spawned, [['xdg-open', 'http://x']]);
});

test('entrar: código de uso único vale uma vez, no prazo, e em disco fica só o hash', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-entrar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = createLoginCode(dir, { now: 1000 });
  const file = path.join(dir, 'entrar.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(code), 'o código não fica gravado');
  assert.equal(consumeLoginCode(dir, 'x'.repeat(32), { now: 1000 }), false);
  assert.equal(consumeLoginCode(dir, code, { now: 1000 + 121e3 }), false, 'vencido');
  const code2 = createLoginCode(dir, { now: 1000 });
  assert.equal(consumeLoginCode(dir, code2, { now: 2000 }), true);
  assert.equal(consumeLoginCode(dir, code2, { now: 2000 }), false, 'segunda vez não');
  assert.equal(consumeLoginCode(dir, undefined), false);
  for (let i = 0; i < 7; i += 1) createLoginCode(dir, { now: 3000 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 5, 'guarda no máximo 5 pendentes');
});

test('log: gira em dashboard.log.1 ao passar do limite', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'dashboard.log');
  assert.equal(rotateIfNeeded(file, 10), false, 'sem arquivo');
  fs.writeFileSync(file, 'x'.repeat(20));
  assert.equal(rotateIfNeeded(file, 10), true);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8').length, 20);
  const log = createLogFile(file, { maxBytes: 50 });
  for (let i = 0; i < 12; i += 1) log.write(`linha ${i} ${'y'.repeat(10)}`);
  log.close();
  assert.ok(fs.statSync(file).size <= 50, 'o atual recomeçou depois de girar');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /linha/);
});

test('cli: ajuda, versão, comando desconhecido e "ainda não instalado"', async (t) => {
  const root = fakeRoot(t);
  const run = async (...argv) => { const o = memOut(); const code = await main(argv, { out: makeOut(o), root }); return { code, text: o.text() }; };
  const { makeOutput } = await import('../../server/cli/saida.js');
  const makeOut = (o) => makeOutput({ stream: o.stream, env: {} });
  assert.match((await run()).text, /Uso: \.\/dashboard <comando>/);
  assert.match((await run('versao')).text, /Server Dashboard 9\.9\.9/);
  const bad = await run('explodir');
  assert.equal(bad.code, 2);
  assert.match(bad.text, /comando desconhecido: explodir/);
  assert.equal(isConfigured(root), false);
  for (const cmd of ['iniciar', 'abrir']) {
    const r = await run(cmd);
    assert.equal(r.code, 1);
    assert.match(r.text, /ainda não instalado/);
  }
  const st = await run('status');
  assert.match(st.text, /ainda não instalado/);
  assert.match(st.text, /painel parado/);
  assert.equal((await run('parar')).code, 0);
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=servidor\nDASH_TOKEN=abc\n');
  assert.equal(isConfigured(root), true);
  const link = panelUrl(root, 3000);
  assert.equal(link.oneTime, true);
  assert.match(link.url, /^http:\/\/127\.0\.0\.1:3000\/entrar\?codigo=[\w-]{32}$/);
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=servidor\n');
  assert.deepEqual(panelUrl(root, 3001), { url: 'http://127.0.0.1:3001/', oneTime: false });
});

test('saída: símbolos sem cor fora do terminal; com cor num TTY', () => {
  return import('../../server/cli/saida.js').then(({ makeOutput }) => {
    const o = memOut();
    const out = makeOutput({ stream: o.stream, env: {} });
    out.title('Server Dashboard · teste');
    out.ok('tudo certo', 'detalhe');
    out.warn('atenção');
    out.fail('falhou');
    out.step('seguindo');
    out.explain('o disco sumiu', 'rode dashboard reconfigurar');
    assert.equal(out.color, false);
    assert.match(o.text(), /✓ tudo certo \(detalhe\)\n▲ atenção\n✗ falhou\n→ seguindo/);
    assert.match(o.text(), /O que aconteceu: o disco sumiu\n {2}Como resolver: rode dashboard reconfigurar/);
    const tty = memOut();
    tty.stream.isTTY = true;
    makeOutput({ stream: tty.stream, env: {} }).ok('x');
    assert.match(tty.text(), /\x1b\[32m✓/);
    const noColor = memOut();
    noColor.stream.isTTY = true;
    assert.equal(makeOutput({ stream: noColor.stream, env: { NO_COLOR: '1' } }).color, false);
  });
});
