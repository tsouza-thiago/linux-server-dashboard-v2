// Peças do `dashboard reconfigurar --pela-tela` (ADR 0034): o código de uso único em
// data/reconfigurar.json e a cópia do que o assistente regrava antes do fim.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_PELA_TELA, criarCodigoPelaTela, lerResultadoPelaTela, retirarCodigoPelaTela } from '../../server/setup/pela-tela.js';
import { guardarConfiguracao } from '../../server/setup/local.js';

function pasta(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-tela-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('código da tela: em disco só o hash, com 0600', (t) => {
  const dir = pasta(t);
  const codigo = criarCodigoPelaTela(dir, { now: 1000 });
  assert.match(codigo, /^[0-9A-F]{32}$/);
  // Permissão e conteúdo pelo mesmo descritor: os 2 vêm do mesmo arquivo (CodeQL js/file-system-race).
  const fd = fs.openSync(path.join(dir, 'reconfigurar.json'), 'r');
  t.after(() => fs.closeSync(fd));
  assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
  const texto = fs.readFileSync(fd, 'utf8');
  const salvo = JSON.parse(texto);
  assert.deepEqual(Object.keys(salvo).sort(), ['exp', 'hash']);
  assert.equal(salvo.hash, crypto.createHash('sha256').update(codigo).digest('hex'));
  assert.ok(!texto.includes(codigo));
});

test('código da tela: sai do disco ao ser lido e não vale de novo', (t) => {
  const dir = pasta(t);
  criarCodigoPelaTela(dir, { now: 1000, ttlMs: 500 });
  assert.equal(retirarCodigoPelaTela(dir, { now: 1200 }).exp, 1500);
  assert.equal(fs.existsSync(path.join(dir, 'reconfigurar.json')), false);
  assert.equal(retirarCodigoPelaTela(dir, { now: 1200 }), null);
});

test('código da tela: vencido ou malformado é recusado e sai do disco', (t) => {
  const dir = pasta(t);
  const file = path.join(dir, 'reconfigurar.json');
  criarCodigoPelaTela(dir, { now: 1000, ttlMs: 500 });
  assert.equal(retirarCodigoPelaTela(dir, { now: 1500 }), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  for (const lixo of ['{', 'null', '{"hash":"abc","exp":9e15}', `{"hash":"${'a'.repeat(64)}"}`]) {
    fs.writeFileSync(file, lixo);
    assert.equal(retirarCodigoPelaTela(dir, { now: 1000 }), null, lixo);
    assert.deepEqual(fs.readdirSync(dir), [], lixo);
  }
});

test('configuração guardada: volta o .env e o data/ssh, e some o que não existia', (t) => {
  const root = pasta(t);
  const ssh = path.join(root, 'data', 'ssh');
  fs.mkdirSync(ssh, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=antigo\n', { mode: 0o600 });
  fs.writeFileSync(path.join(ssh, 'known_hosts'), 'antigo\n', { mode: 0o600 });
  const restaurar = guardarConfiguracao(root);
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=novo\n');
  fs.writeFileSync(path.join(ssh, 'known_hosts'), 'novo\n');
  fs.writeFileSync(path.join(ssh, 'config'), 'novo\n');
  restaurar();
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SSH_HOST=antigo\n');
  assert.equal(fs.readFileSync(path.join(ssh, 'known_hosts'), 'utf8'), 'antigo\n');
  assert.equal(fs.existsSync(path.join(ssh, 'config')), false);
  assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
});

// Etapa 5 da F8: a tela mostra o motivo de uma recusa ou de uma volta, e nada além das falhas.
test('resultado para a tela: só as linhas de falha, curtas e poucas, com o instante do log', (t) => {
  const dir = pasta(t);
  assert.equal(lerResultadoPelaTela(dir), null, 'sem log, nada a dizer');
  const file = path.join(dir, LOG_PELA_TELA);
  fs.writeFileSync(file, [
    '→ assistente no ar, esperando o navegador',
    '✓ painel em http://127.0.0.1:3000 (só nesta máquina)',
    '  O que aconteceu: detalhe da máquina que não vai para a tela',
    '✗ o painel não subiu com a configuração nova (o painel não respondeu)',
    '✓ painel de volta com a configuração anterior',
    `✗ ${'x'.repeat(500)}`,
    ...Array.from({ length: 6 }, (_, i) => `✗ falha ${i}`),
    '',
  ].join('\n'));
  const quando = new Date('2026-11-04T12:00:00.000Z');
  fs.utimesSync(file, quando, quando);
  const r = lerResultadoPelaTela(dir);
  assert.equal(r.em, quando.toISOString());
  assert.deepEqual(r.motivos.slice(0, 1), ['o painel não subiu com a configuração nova (o painel não respondeu)']);
  assert.equal(r.motivos[1].length, 300, 'linha longa é cortada');
  assert.equal(r.motivos.length, 5, 'no máximo 5 linhas');
  assert.ok(!r.motivos.join('\n').includes('127.0.0.1') && !r.motivos.join('\n').includes('O que aconteceu'));
  fs.writeFileSync(file, '→ assistente no ar, esperando o navegador\n▲ assistente cancelado\n');
  assert.deepEqual(lerResultadoPelaTela(dir).motivos, [], 'cancelar não é falha');
});
