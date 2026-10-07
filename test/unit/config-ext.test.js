import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadEnvFile, env, sanitizeToken, isPlaceholderHost, clampInt, clampPathToData,
} from '../../server/config.js';

function tempFile(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-cfg-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, content);
  return { dir, file };
}

test('loadEnvFile parseia linhas com aspas, comentários e espaços', () => {
  const { dir, file } = tempFile([
    'SSH_HOST=meu-host',
    'POLL_INTERVAL="60000"',
    "DASH_TOKEN='segredo123'",
    '# comentário ignorado',
    '',
    '   ESPACADO = valor  ',
    'LINHA_SEM_IGUAL',
    '=só valor',
  ].join('\n'));
  try {
    const out = loadEnvFile(file);
    assert.equal(out.SSH_HOST, 'meu-host');
    assert.equal(out.POLL_INTERVAL, '60000');
    assert.equal(out.DASH_TOKEN, 'segredo123');
    assert.equal(out.ESPACADO, 'valor');
    assert.equal(out['LINHA_SEM_IGUAL'], undefined);
    assert.equal(out[''], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEnvFile retorna vazio para arquivo inexistente', () => {
  assert.deepEqual(loadEnvFile('/nao/existe/.env'), {});
});

test('env: process.env tem precedência sobre arquivo', () => {
  process.env.DASH_TEST_PREC = 'abc';
  assert.equal(env('DASH_TEST_PREC', 'def'), 'abc');
  delete process.env.DASH_TEST_PREC;
  assert.equal(env('DASH_TEST_PREC', 'def'), 'def');
});

test('env: valor vazio cai no default', () => {
  process.env.DASH_TEST_VAZIO = '';
  assert.equal(env('DASH_TEST_VAZIO', 'fallback'), 'fallback');
  delete process.env.DASH_TEST_VAZIO;
});

test('sanitizeToken rejeita tokens iniciando com hífen', () => {
  assert.deepEqual(sanitizeToken('-x'), []);
  assert.deepEqual(sanitizeToken('-rf /etc sda'), ['/etc', 'sda']);
});

test('sanitizeToken aceita caracteres de path e interface', () => {
  assert.deepEqual(sanitizeToken('enp0s7:0 /mnt/a.b-c/d'), ['enp0s7:0', '/mnt/a.b-c/d']);
});

test('isPlaceholderHost detecta usuario@ip', () => {
  assert.equal(isPlaceholderHost('usuario@ip'), true);
  assert.equal(isPlaceholderHost('seu-host'), true);
  assert.equal(isPlaceholderHost('meu-host'), false);
});

test('clampInt trata floats, negativos e NaN', () => {
  assert.equal(clampInt('60000.5', 60000, 10000, 3600000), 60000);
  assert.equal(clampInt('-5', 60000, 10000, 3600000), 60000);
  assert.equal(clampInt('9999999999', 60000, 10000, 3600000), 60000);
  assert.equal(clampInt('Infinity', 60000, 10000, 3600000), 60000);
});

test('clampInt aceita limites válidos', () => {
  assert.equal(clampInt('10000', 60000, 10000, 3600000), 10000);
  assert.equal(clampInt('3600000', 60000, 10000, 3600000), 3600000);
});

test('clampPathToData bloqueia escape via ..', () => {
  const p = clampPathToData('../fora.json', 'history.json');
  assert.ok(p.endsWith(path.join('data', 'history.json')));
});

test('clampPathToData aceita caminho vazio com fallback', () => {
  const p = clampPathToData('', 'custom.json');
  assert.ok(p.endsWith(path.join('data', 'custom.json')));
});