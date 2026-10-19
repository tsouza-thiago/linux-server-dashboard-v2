// O npm run check diz qual teste falhou e guarda a saída completa fora do git (#25): uma
// falha rara, que não se repete, só pode ser investigada se o nome e o log sobreviverem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testesQueFalharam, LOG_FALHA } from '../../scripts/check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Trecho real do reporter spec do node --test 24 numa suíte com 2 falhas.
const SAIDA = [
  '✔ sse.js: formato do evento e leitura do Last-Event-ID (0.6ms)',
  '✖ SSE: limite de conexões simultâneas responde 503 (1520.3ms)',
  'ℹ tests 465',
  'ℹ fail 2',
  '',
  '✖ failing tests:',
  '',
  'test at test/integration/api-sse.test.js:71:1',
  '✖ SSE: limite de conexões simultâneas responde 503 (1520.3ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '',
  'test at test/seguranca/invariantes-estaticas.test.js:107:1',
  '✖ CWE-1333: new RegExp só com texto escapado ou fixo (sem ReDoS nem injeção de regex) (214.404988ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
].join('\n');

test('check: lê o nome de cada teste que falhou na seção "failing tests"', () => {
  assert.deepEqual(testesQueFalharam(SAIDA), [
    'SSE: limite de conexões simultâneas responde 503',
    'CWE-1333: new RegExp só com texto escapado ou fixo (sem ReDoS nem injeção de regex)',
  ]);
});

test('check: suíte verde ou saída sem a seção não inventa falha', () => {
  assert.deepEqual(testesQueFalharam('✔ um teste (1ms)\nℹ fail 0\n'), []);
  assert.deepEqual(testesQueFalharam(''), []);
});

test('check: o log da falha fica numa pasta que o git ignora', () => {
  assert.equal(LOG_FALHA, path.join('.check', 'ultima-falha.log'));
  const r = spawnSync('git', ['check-ignore', '--no-index', '-q', LOG_FALHA], { cwd: ROOT });
  assert.equal(r.status, 0, `${LOG_FALHA} não está no .gitignore`);
});
