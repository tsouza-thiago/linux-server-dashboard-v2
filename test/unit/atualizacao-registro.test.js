// Atualização pelo botão (ADR 0031): log, estado e trava em .atualizacao/ e o executor fora do
// serviço. As rotas ficam em test/integration/atualizacao.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  abrirRegistro, donoDaTrava, emAndamento, garantirPasta, lerEstado, lerRegistro, pegarTrava, prepararRegistro, registrarFalha, soltarTrava,
} from '../../server/atualizacao/registro.js';
import { executarForaDoServico, modoDoExecutor } from '../../server/atualizacao/executor.js';

function pasta(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-registro-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// /proc de mentira: `pid` roda `cmdline`.
function proc(root, pid, cmdline) {
  const dir = path.join(root, 'proc');
  fs.mkdirSync(path.join(dir, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid), 'cmdline'), cmdline.join('\0'));
  return dir;
}
const ATUALIZAR = ['/opt/node', '/opt/painel/server/cli/index.js', 'atualizar', '--registro'];

test('pasta: 0700, e corrige a permissão de uma pasta aberta', (t) => {
  const root = pasta(t);
  fs.mkdirSync(path.join(root, '.atualizacao'), { mode: 0o755 });
  garantirPasta(root);
  assert.equal(fs.statSync(path.join(root, '.atualizacao')).mode & 0o777, 0o700);
});

test('estado e log: nascem 0600; o começo zera o log da atualização anterior', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1', agora: 1000 });
  const r = abrirRegistro(root);
  r.stream.write('linha antiga\n');
  r.fim(0);
  for (const f of ['estado.json', 'ultima.log']) assert.equal(fs.statSync(path.join(root, '.atualizacao', f)).mode & 0o777, 0o600, f);
  prepararRegistro(root, { alvo: 'v2.6.0', de: 'v2.5.0', agora: 2000 });
  assert.equal(lerRegistro(root).texto, '');
  assert.deepEqual(lerEstado(root), { fase: 'iniciando', alvo: 'v2.6.0', de: 'v2.5.0', inicio: new Date(2000).toISOString(), fim: null, resultado: null });
});

test('fim: o código decide o resultado, menos quando o resultado já foi marcado', (t) => {
  const root = pasta(t);
  const ok = abrirRegistro(root);
  ok.fim(0);
  assert.equal(lerEstado(root).resultado, 'atualizado');
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  const ruim = abrirRegistro(root);
  ruim.fim(1);
  assert.equal(lerEstado(root).resultado, 'falhou');
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  const volta = abrirRegistro(root);
  volta.marcar({ resultado: 'voltou' });
  volta.fim(1);
  assert.equal(lerEstado(root).resultado, 'voltou');
  assert.equal(lerEstado(root).fase, 'fim');
});

test('trava: 2 atualizações não andam juntas; a de um processo morto sai sozinha', (t) => {
  const root = pasta(t);
  const procDir = proc(root, 500, ATUALIZAR);
  assert.equal(pegarTrava(root, { pid: 500, procDir }), true);
  assert.equal(donoDaTrava(root, procDir), 500);
  assert.equal(pegarTrava(root, { pid: 600, procDir }), false, 'a outra espera');
  assert.equal(emAndamento(root, { procDir }), true);
  fs.rmSync(path.join(procDir, '500'), { recursive: true });
  assert.equal(emAndamento(root, { procDir }), false, 'processo morto não segura nada');
  assert.equal(pegarTrava(root, { pid: 600, procDir }), true);
  soltarTrava(root);
  assert.equal(donoDaTrava(root, procDir), null);
});

test('trava: PID reaproveitado por outro programa não segura a trava', (t) => {
  const root = pasta(t);
  const procDir = proc(root, 500, ['/usr/bin/vim', 'atualizar']);
  pegarTrava(root, { pid: 500, procDir });
  assert.equal(donoDaTrava(root, procDir), null);
});

test('em andamento: o pedido da tela conta só até o executor ter tempo de subir', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1', agora: 1000 });
  assert.equal(emAndamento(root, { agora: 1000 + 59000 }), true);
  assert.equal(emAndamento(root, { agora: 1000 + 61000 }), false);
});

test('registro: entrega só o pedaço novo, em linhas inteiras', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  const r = abrirRegistro(root);
  r.stream.write('✓ primeira\n');
  const a = lerRegistro(root, 0);
  assert.equal(a.texto, '✓ primeira\n');
  r.stream.write('✓ segunda\n✗ metade');
  const b = lerRegistro(root, a.proximo);
  assert.equal(b.texto, '✓ segunda\n', 'a linha sem fim fica para a próxima leitura');
  r.stream.write(' da linha\n');
  assert.equal(lerRegistro(root, b.proximo).texto, '✗ metade da linha\n');
  r.fim(1);
});

test('registro: log grande vem em pedaços, sem partir caractere', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  const r = abrirRegistro(root);
  const linha = `${'ç'.repeat(99)}\n`;
  for (let i = 0; i < 1000; i += 1) r.stream.write(linha);
  let desde = 0;
  let texto = '';
  for (let i = 0; i < 10; i += 1) {
    const p = lerRegistro(root, desde);
    assert.ok(!p.texto.includes('\ufffd'));
    assert.ok(Buffer.byteLength(p.texto) <= 64 * 1024);
    texto += p.texto;
    desde = p.proximo;
  }
  assert.equal(texto, linha.repeat(1000));
  r.fim(0);
});

test('registro: depois de um log mais curto, lê do começo; sem nada, responde vazio', (t) => {
  const root = pasta(t);
  assert.deepEqual(lerRegistro(root, 0), { texto: '', proximo: 0, fase: null, alvo: null, de: null, inicio: null, fim: null, resultado: null, rodando: false });
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  const r = abrirRegistro(root);
  r.stream.write('curta\n');
  assert.equal(lerRegistro(root, 99999).texto, 'curta\n');
  r.fim(0);
});

test('registro: executor que morreu no meio aparece como interrompida', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1', agora: 1000 });
  const r = abrirRegistro(root);
  r.marcar({ fase: 'trocando' });
  const lido = lerRegistro(root, 0, { agora: 1000 });
  assert.equal(lido.resultado, 'interrompida');
  assert.equal(lido.fase, 'fim');
  assert.equal(lido.rodando, false);
  fs.closeSync(r.fd);
});

test('falha ao iniciar: fica no log e encerra o estado', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  registrarFalha(root, 'não subiu');
  const r = lerRegistro(root);
  assert.equal(r.texto, 'não subiu\n');
  assert.equal(r.resultado, 'falhou');
});

// Filho falso: anota o que foi pedido e termina como o teste mandar.
function espiao(fim) {
  const chamadas = [];
  const spawnFn = (cmd, args, opts) => {
    chamadas.push({ cmd, args, opts });
    const filho = new EventEmitter();
    filho.unref = () => { chamadas.at(-1).unref = true; };
    setImmediate(() => fim(filho));
    return filho;
  };
  return { chamadas, spawnFn };
}

test('executor: serviço → unidade própria do systemd, com o comando em lista e sem shell', async () => {
  const { chamadas, spawnFn } = espiao((f) => f.emit('close', 0));
  assert.deepEqual(await executarForaDoServico({ root: '/opt/painel', modo: 'systemd', spawnFn }), { ok: true });
  assert.equal(chamadas[0].cmd, 'systemd-run');
  assert.deepEqual(chamadas[0].args, ['--user', '--unit=server-dashboard-atualizar', '--collect', '--quiet', '--working-directory=/opt/painel', '/opt/painel/dashboard', 'atualizar', '--registro']);
  assert.equal(chamadas[0].opts.shell, undefined);
});

test('executor: systemd-run que falha não cai para um processo solto dentro do serviço', async () => {
  const { chamadas, spawnFn } = espiao((f) => f.emit('close', 1));
  assert.deepEqual(await executarForaDoServico({ root: '/opt/painel', modo: 'systemd', spawnFn }), { ok: false });
  assert.equal(chamadas.length, 1);
  const erro = espiao((f) => f.emit('error', new Error('sem systemd-run')));
  assert.deepEqual(await executarForaDoServico({ root: '/opt/painel', modo: 'systemd', spawnFn: erro.spawnFn }), { ok: false });
});

test('executor: segundo plano → sessão própria e sem prender o painel', async () => {
  const { chamadas, spawnFn } = espiao((f) => f.emit('spawn'));
  assert.deepEqual(await executarForaDoServico({ root: '/opt/painel', modo: 'segundo-plano', spawnFn }), { ok: true });
  assert.equal(chamadas[0].cmd, '/opt/painel/dashboard');
  assert.deepEqual(chamadas[0].args, ['atualizar', '--registro']);
  assert.equal(chamadas[0].opts.detached, true);
  assert.equal(chamadas[0].opts.stdio, 'ignore');
  assert.equal(chamadas[0].opts.cwd, '/opt/painel');
  assert.equal(chamadas[0].unref, true);
  const erro = espiao((f) => f.emit('error', new Error('sem arquivo')));
  assert.deepEqual(await executarForaDoServico({ root: '/opt/painel', modo: 'segundo-plano', spawnFn: erro.spawnFn }), { ok: false });
});

test('modo: serviço só com a unidade instalada e o systemd do usuário de pé', (t) => {
  const home = pasta(t);
  const comSystemd = () => ({ status: 0, stdout: '' });
  assert.equal(modoDoExecutor({ home, run: comSystemd }), 'segundo-plano');
  const unit = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(unit, { recursive: true });
  fs.writeFileSync(path.join(unit, 'server-dashboard.service'), '[Unit]\n');
  assert.equal(modoDoExecutor({ home, run: comSystemd }), 'systemd');
  assert.equal(modoDoExecutor({ home, run: () => ({ status: 1 }) }), 'segundo-plano');
});
