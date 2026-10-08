import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

function listJs(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));
}

test('scripts shell têm sintaxe válida (bash -n)', () => {
  for (const script of ['dashboard', 'scripts/node-runtime.sh']) {
    const file = path.join(ROOT, script);
    assert.doesNotThrow(
      () => execFileSync('bash', ['-n', file], { stdio: 'pipe' }),
      `${script} deveria passar no bash -n`,
    );
  }
  assert.ok(fs.statSync(path.join(ROOT, 'dashboard')).mode & 0o100, './dashboard é executável');
  for (const old of ['install.sh', 'install-lib.sh', 'start.sh', 'stop.sh']) {
    assert.equal(fs.existsSync(path.join(ROOT, old)), false, `${old} foi substituído pelo ./dashboard`);
  }
});

test('arquivos do servidor passam no node --check', () => {
  for (const file of listJs(path.join(ROOT, 'server'))) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
      `${path.basename(file)} deveria ter sintaxe válida`,
    );
  }
});

test('arquivos de frontend passam no node --check', () => {
  for (const file of listJs(path.join(ROOT, 'public', 'js'))) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
      `${path.basename(file)} deveria ter sintaxe válida`,
    );
  }
});

test('arquivos essenciais existem (regressão de estrutura)', () => {
  const required = [
    'server/config.js', 'server/security.js', 'server/csv.js', 'server/index.js',
    'server/poller.js', 'server/storage/index.js', 'server/stores.js',
    'dashboard', 'scripts/node-runtime.sh', 'server/cli/index.js', '.env.example', 'public/index.html',
    'public/js/main.js', 'public/js/core/html.js', 'public/js/core/router.js',
    'public/js/charts/timeseries.js', 'public/js/views/visao-geral.js', 'public/vendor/uplot/uPlot.iife.min.js',
  ];
  for (const rel of required) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} deveria existir`);
  }
});