// `dashboard instalar` (server/cli/instalar.js): conferências antes do assistente e o ciclo
// completo do assistente pela rede (abre, recebe o código, conclui, fecha, liga o painel).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyVendor, parseFlags, preflight, runWizard, instalar } from '../../server/cli/instalar.js';
import { makeOutput } from '../../server/cli/saida.js';
import { request } from '../../test-support/request.js';
import { makeInstalacao } from '../../test-support/instalacao-fake.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function memOut() {
  const chunks = [];
  const out = makeOutput({ stream: { isTTY: false, write: (s) => { chunks.push(s); return true; } }, env: {} });
  return { out, text: () => chunks.join('') };
}

function copyVendor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-pre-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, 'public', 'vendor'), path.join(root, 'public', 'vendor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public', 'fonts'), path.join(root, 'public', 'fonts'), { recursive: true });
  return root;
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('instalar: uPlot e fontes conferidos pelo SHA-256 do vendor.json', (t) => {
  const real = verifyVendor(ROOT);
  assert.equal(real.ok, true, real.bad.join(', '));
  assert.ok(real.count >= 6);
  const root = copyVendor(t);
  fs.appendFileSync(path.join(root, 'public', 'vendor', 'uplot', 'uPlot.iife.min.js'), '\n/* alterado */');
  assert.deepEqual(verifyVendor(root).bad, ['public/vendor/uplot/uPlot.iife.min.js']);
  assert.deepEqual(verifyVendor(path.join(root, 'nada')).bad, ['public/vendor/vendor.json']);
});

test('instalar: opções da linha de comando', () => {
  assert.deepEqual(parseFlags(['--terminal', '--servidor', '192.0.2.10', '--porta=2222', '--sem-assinatura', 'x']), {
    _: ['x'], terminal: true, servidor: '192.0.2.10', porta: '2222', 'sem-assinatura': true,
  });
});

test('instalar: sem assinatura conferida, recusa; com --sem-assinatura, avisa e segue', (t) => {
  const root = copyVendor(t);
  const noSsh = (cmd) => (cmd === 'ssh' ? { error: new Error('ENOENT') } : { status: 0, stdout: '' });
  const a = memOut();
  assert.equal(preflight({ out: a.out, root, flags: {} }), false);
  assert.match(a.text(), /✗ esta pasta não veio de um git clone/);
  assert.match(a.text(), /Como resolver: não use esta cópia/);
  const b = memOut();
  assert.equal(preflight({ out: b.out, root, flags: { 'sem-assinatura': true }, env: { DASHBOARD_NODE_ORIGEM: 'baixado' } }), true);
  assert.match(b.text(), /▲ esta pasta não veio de um git clone.*--sem-assinatura/);
  assert.match(b.text(), /✓ Node\.js 24 — baixado para \.runtime\/ e conferido \(SHA-256\)/);
  assert.match(b.text(), /✓ nada para instalar com npm/);
  assert.match(b.text(), /✓ pasta de dados data\/ criada \(só você lê · 0700\)/);
  assert.equal(fs.statSync(path.join(root, 'data')).mode & 0o777, 0o700);
  const c = memOut();
  assert.equal(preflight({ out: c.out, root, flags: { 'sem-assinatura': true }, run: noSsh }), false);
  assert.match(c.text(), /falta o SSH nesta máquina/);
  assert.match(c.text(), /sudo apt install openssh-client/);
  fs.writeFileSync(path.join(root, 'public', 'vendor', 'uplot', 'LICENSE.txt'), 'trocado');
  const d = memOut();
  assert.equal(preflight({ out: d.out, root, flags: { 'sem-assinatura': true } }), false);
  assert.match(d.text(), /arquivos de terceiros não conferem/);
});

test('instalar: assistente abre na porta, aceita o código, conclui, fecha e liga o painel', async (t) => {
  const fake = makeInstalacao({ systemd: false });
  t.after(fake.cleanup);
  const port = await freePort();
  const opened = [];
  const o = memOut();
  const running = runWizard({ out: o.out, root: fake.root, inst: fake.inst, port, open: (url) => { opened.push(url); return true; } });
  await new Promise((r) => setTimeout(r, 100));
  const code = /código de uso único: ([A-Z0-9-]+)/.exec(o.text())[1];
  assert.match(opened[0], new RegExp(`^http://127\\.0\\.0\\.1:${port}/configurar#codigo=${code.replace('-', '')}$`));
  const page = await request(port, { path: '/configurar' });
  const csrf = [].concat(page.headers['set-cookie']).find((c) => c.startsWith('dash_csrf=')).split(';')[0];
  let cookie = csrf;
  const post = async (p, body) => {
    const r = await request(port, { method: 'POST', path: `/api/configurar/${p}`, body, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Cookie: cookie } });
    const set = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('dash_setup='));
    if (set) cookie = `${csrf}; ${set.split(';')[0]}`;
    return r;
  };
  assert.equal((await post('entrar', { codigo: code })).status, 200);
  await post('servidor', { host: '192.0.2.10', user: 'maria' });
  await post('identidade', {});
  await post('conectar', { senha: 'certa', confirmo: true });
  await post('escolhas', { mounts: ['/'], smart: [], netIf: '', services: [] });
  await post('plano', { from: false });
  assert.equal((await post('preparar', {})).json.ok, true);
  assert.equal((await post('concluir', { iniciarComComputador: true, atalho: false })).status, 200);
  assert.equal(await running, 0);
  assert.match(o.text(), /✓ assistente concluído e desligado/);
  assert.match(o.text(), /✓ painel rodando em segundo plano/);
  assert.match(o.text(), /Tudo pronto\. Pode fechar esta janela\./);
  await assert.rejects(() => request(port, { path: '/configurar' }), 'o assistente não existe mais');
});

test('instalar: assistente parado por 1 hora fecha sozinho', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const o = memOut();
  const code = await runWizard({ out: o.out, root: fake.root, inst: fake.inst, port: await freePort(), open: () => false, idleMs: 150 });
  assert.equal(code, 1);
  assert.match(o.text(), /Abra o endereço acima no navegador/);
  assert.match(o.text(), /assistente fechado depois de 1 hora parado/);
});

test('instalar: painel já rodando → sugere reconfigurar; porta ocupada → explica', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const root = copyVendor(t);
  const port = await freePort();
  fs.writeFileSync(path.join(root, '.env'), `PORT=${port}\n`);
  const blocker = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  t.after(() => blocker.close());
  const o = memOut();
  const code = await instalar({ out: o.out, root, args: ['--sem-assinatura'], deps: { inst: fake.inst } });
  assert.equal(code, 1);
  assert.match(o.text(), new RegExp(`a porta ${port} está em uso por outro programa`));
});
