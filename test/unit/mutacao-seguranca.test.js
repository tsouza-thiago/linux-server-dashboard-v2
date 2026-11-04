// A mutação dos guardas (scripts/mutacao-seguranca.mjs) nomeia o teste que prende uma rodada
// (#128): o `--test-timeout` derruba o teste, e o nome dele sai do relatório do reporter spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testesPresos } from '../../scripts/mutacao-seguranca.mjs';

test('mutação: o teste derrubado pelo --test-timeout sai com o nome; o que falhou por asserção, não', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-presos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.test.mjs'), [
    "import test from 'node:test';",
    "test('espera um temporizador real', () => new Promise((r) => setTimeout(r, 2000)));",
    "test('falha por asserção', () => { throw new Error('não'); });",
    "test('passa', () => {});",
  ].join('\n'));
  // Sem NODE_TEST_CONTEXT: o filho é um `node --test` próprio, não um subteste deste.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-timeout=300', 'a.test.mjs'], { cwd: dir, encoding: 'utf8', env, timeout: 30000 });
  assert.deepEqual(testesPresos(`${r.stdout}${r.stderr}`), ['espera um temporizador real']);
});

test('mutação: saída sem teste preso devolve lista vazia', () => {
  assert.deepEqual(testesPresos('✔ passa (1.2ms)\n✖ falha (3ms)\n  Error: não\n'), []);
});
