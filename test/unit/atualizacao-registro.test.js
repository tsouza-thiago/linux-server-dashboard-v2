// Atualização pelo botão (ADR 0031): log, estado e trava em .atualizacao/ e o executor fora do
// serviço. As rotas ficam em test/integration/atualizacao.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  abrirRegistro, cancelarPre, donoDaTrava, emAndamento, garantirPasta, lerEstado, lerRegistro, liberarPre, pegarTrava, preLiberada, prepararRegistro, registrarFalha, soltarTrava,
} from '../../server/atualizacao/registro.js';
import { executarForaDoServico, modoDoExecutor, reconfigurarForaDoServico } from '../../server/atualizacao/executor.js';
import { espiao } from '../../test-support/falsos.js';

function pasta(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-registro-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A instalação cria .atualizacao/painel/ antes do serviço subir; o painel não cria (ADR 0051).
  garantirPasta(root);
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

// O executor como o `dashboard atualizar --registro` o faz: abre o registro e pega a trava, o que
// marca o início dele e passa na frente do pedido da tela.
function executor(root, pid = 700) {
  const procDir = proc(root, pid, ATUALIZAR);
  const r = abrirRegistro(root);
  assert.equal(r.pegarTrava({ pid, procDir }), true);
  return { r, procDir };
}

test('pasta: 0700, e corrige a permissão de uma pasta aberta', (t) => {
  const root = pasta(t);
  fs.chmodSync(path.join(root, '.atualizacao'), 0o755);
  fs.chmodSync(path.join(root, '.atualizacao', 'painel'), 0o755);
  garantirPasta(root);
  assert.equal(fs.statSync(path.join(root, '.atualizacao')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, '.atualizacao', 'painel')).mode & 0o777, 0o700);
});

test('estado e log: nascem 0600; o executor, ao pegar a trava, zera o log e o estado da anterior', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1', agora: 1000 });
  const a = executor(root);
  a.r.stream.write('linha antiga\n');
  a.r.fim(0);
  for (const f of ['estado.json', 'ultima.log']) assert.equal(fs.statSync(path.join(root, '.atualizacao', f)).mode & 0o777, 0o600, f);
  assert.equal(fs.statSync(path.join(root, '.atualizacao', 'painel', 'pedido.json')).mode & 0o777, 0o600);
  prepararRegistro(root, { alvo: 'v2.6.0', de: 'v2.5.0', agora: Date.now() + 5000 });
  assert.equal(lerRegistro(root).texto, '', 'o pedido novo esconde o log velho');
  const b = executor(root);
  assert.equal(lerRegistro(root).texto, '', 'o log da anterior foi zerado');
  assert.deepEqual({ ...lerEstado(root), inicio: undefined }, { fase: 'iniciando', inicio: undefined, fim: null, resultado: null });
  b.r.fim(0);
});

test('o painel só escreve em .atualizacao/painel/ (ADR 0051)', (t) => {
  const root = pasta(t);
  const antes = fs.readdirSync(path.join(root, '.atualizacao')).sort();
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  registrarFalha(root, 'não subiu');
  assert.deepEqual(fs.readdirSync(path.join(root, '.atualizacao')).sort(), antes, 'nenhum arquivo novo fora de painel/');
  assert.deepEqual(fs.readdirSync(path.join(root, '.atualizacao', 'painel')), ['pedido.json']);
  assert.equal(preLiberada(root), false);
});

test('sem painel/ (serviço antigo, pasta sem escrita): prepararRegistro lança e não cria nada', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-registro-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(path.join(root, '.atualizacao')), false);
});

test('fim: o código decide o resultado, menos quando o resultado já foi marcado', (t) => {
  const root = pasta(t);
  executor(root).r.fim(0);
  assert.equal(lerEstado(root).resultado, 'atualizado');
  executor(root).r.fim(1);
  assert.equal(lerEstado(root).resultado, 'falhou');
  const volta = executor(root).r;
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
  const { r } = executor(root);
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
  const { r } = executor(root);
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
  const { r } = executor(root);
  r.stream.write('curta\n');
  assert.equal(lerRegistro(root, 99999).texto, 'curta\n');
  r.fim(0);
});

test('registro: executor que morreu no meio aparece como interrompida', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1', agora: 1000 });
  const { r, procDir } = executor(root);
  r.marcar({ fase: 'trocando' });
  fs.rmSync(path.join(procDir, '700'), { recursive: true }); // o executor morreu
  const lido = lerRegistro(root, 0, { agora: 1000, procDir });
  assert.equal(lido.resultado, 'interrompida');
  assert.equal(lido.fase, 'fim');
  assert.equal(lido.rodando, false);
  fs.closeSync(r.fd);
});

test('registro: executor que termina entre as 2 leituras não vira interrompida (#130)', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1', agora: 1000 });
  const { r, procDir } = executor(root);
  r.marcar({ fase: 'ligando' });
  // A corrida fica fixa: o executor termina logo depois da 1ª leitura do estado.
  const original = fs.readFileSync;
  let terminou = false;
  t.mock.method(fs, 'readFileSync', (arq, ...resto) => {
    const lido = original(arq, ...resto);
    if (!terminou && String(arq).endsWith('estado.json')) {
      terminou = true;
      r.fim(0);
    }
    return lido;
  });
  const lido = lerRegistro(root, 0, { agora: 1000, procDir });
  assert.equal(terminou, true);
  assert.notEqual(lido.resultado, 'interrompida');
  assert.equal(lido.rodando, true);
  // A leitura seguinte, com a trava solta, já acha o estado final.
  const depois = lerRegistro(root, 0, { agora: 1000, procDir });
  assert.equal(depois.resultado, 'atualizado');
  assert.equal(depois.fase, 'fim');
  assert.equal(depois.rodando, false);
});

test('trava pelo registro: o fim grava o estado e só então solta (#130)', (t) => {
  const root = pasta(t);
  const procDir = proc(root, 700, ATUALIZAR);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  const r = abrirRegistro(root);
  assert.equal(r.pegarTrava({ pid: 700, procDir }), true);
  const original = fs.rmSync;
  const faseAoSoltar = [];
  t.mock.method(fs, 'rmSync', (arq, ...resto) => {
    if (String(arq).endsWith('trava.pid')) faseAoSoltar.push(lerEstado(root).fase);
    return original(arq, ...resto);
  });
  r.fim(0);
  assert.deepEqual(faseAoSoltar, ['fim']);
  assert.equal(donoDaTrava(root, procDir), null);
});

test('trava pelo registro: quem não pegou a trava não solta a dos outros', (t) => {
  const root = pasta(t);
  const procDir = proc(root, 700, ATUALIZAR);
  assert.equal(pegarTrava(root, { pid: 700, procDir }), true);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  const r = abrirRegistro(root);
  assert.equal(r.pegarTrava({ pid: 701, procDir }), false);
  r.fim(1);
  assert.equal(donoDaTrava(root, procDir), 700);
});

test('falha ao iniciar: a linha aparece como log e o estado encerra como falha', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1' });
  registrarFalha(root, 'não subiu');
  const r = lerRegistro(root);
  assert.equal(r.texto, 'não subiu\n');
  assert.equal(r.resultado, 'falhou');
  assert.equal(r.fase, 'fim');
  assert.equal(emAndamento(root), false);
  assert.equal(lerRegistro(root, r.proximo).texto, '');
});

test('pedido que o executor nunca pegou vira interrompida depois da espera', (t) => {
  const root = pasta(t);
  prepararRegistro(root, { alvo: 'v2.5.0', de: 'v2.4.1', agora: 1000 });
  const r = lerRegistro(root, 0, { agora: 1000 + 61000 });
  assert.equal(r.resultado, 'interrompida');
  assert.equal(r.fase, 'fim');
});
