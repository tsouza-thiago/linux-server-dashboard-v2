// Peças do `dashboard reconfigurar --pela-tela` (ADR 0034): o código de uso único em
// data/reconfigurar.json e a cópia do que o assistente regrava antes do fim.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { criarCodigoPelaTela, retirarCodigoPelaTela } from '../../server/setup/pela-tela.js';
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
  const file = path.join(dir, 'reconfigurar.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const salvo = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(salvo).sort(), ['exp', 'hash']);
  assert.equal(salvo.hash, crypto.createHash('sha256').update(codigo).digest('hex'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes(codigo));
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
  assert.equal(fs.existsSync(file), false);
  for (const lixo of ['{', 'null', '{"hash":"abc","exp":9e15}', `{"hash":"${'a'.repeat(64)}"}`]) {
    fs.writeFileSync(file, lixo);
    assert.equal(retirarCodigoPelaTela(dir, { now: 1000 }), null, lixo);
    assert.equal(fs.existsSync(file), false, lixo);
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
