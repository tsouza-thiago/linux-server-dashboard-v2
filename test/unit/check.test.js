// O npm run check diz qual teste falhou e guarda a saída completa fora do git (#25): uma
// falha rara, que não se repete, só pode ser investigada se o nome e o log sobreviverem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

// Projeto mínimo numa pasta temporária, com uma cópia do check.mjs: os passos de sintaxe e de
// segredos passam, e a suíte tem 1 teste que escreve muito e falha.
function projetoComSuiteGrande() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-pipe-'));
  for (const pasta of ['server', 'public/js', 'scripts/e2e-instalacao', 'test']) {
    fs.mkdirSync(path.join(dir, pasta), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'check.mjs'), path.join(dir, 'scripts', 'check.mjs'));
  // O passo do bash -n confere estes 5 scripts: vazios, passam.
  for (const sh of ['dashboard', 'scripts/node-runtime.sh', 'scripts/askpass.sh', 'scripts/completar.bash', 'scripts/e2e-instalacao/rodar.sh']) {
    fs.writeFileSync(path.join(dir, sh), '');
  }
  // 300 KB no stdout do teste: bem mais que os 64 KiB que o pipe guarda.
  fs.writeFileSync(path.join(dir, 'test', 'grande.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('escreve muito e falha', () => {",
    "  for (let i = 0; i < 3000; i += 1) console.log('linha de enchimento '.repeat(5));",
    "  assert.equal('obtido', 'esperado', 'ERRO-DO-TESTE-QUE-FALHOU');",
    '});',
  ].join('\n'));
  const git = spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(git.status, 0, 'git init falhou');
  return dir;
}

test('check: num pipe, a saída de mais de 64 KiB sai inteira e o código é 1 (#134)', () => {
  const dir = projetoComSuiteGrande();
  try {
    // Sem o NODE_TEST_CONTEXT, o node --test de dentro não fala com este runner.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // spawnSync liga o stdout do filho a um pipe, como o CI.
    const r = spawnSync(process.execPath, ['scripts/check.mjs'], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(r.stdout.length > 64 * 1024, `saída curta demais para o teste valer: ${r.stdout.length} bytes`);
    assert.equal(r.status, 1, `código de saída ${r.status}`);
    // O erro do teste, a lista de falhas e o resumo vêm depois dos 300 KB.
    assert.match(r.stdout, /ERRO-DO-TESTE-QUE-FALHOU/);
    assert.match(r.stdout, /falharam: escreve muito e falha/);
    assert.match(r.stdout, /CHECK FALHOU — não faça commit\.\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
