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
  for (const script of ['install.sh', 'install-lib.sh', 'start.sh', 'stop.sh']) {
    const file = path.join(ROOT, script);
    assert.doesNotThrow(
      () => execFileSync('bash', ['-n', file], { stdio: 'pipe' }),
      `${script} deveria passar no bash -n`,
    );
  }
});

test('install-lib.sh valida entradas (segurança)', () => {
  const lib = path.join(ROOT, 'install-lib.sh');
  const run = (expr) => execFileSync(
    'bash',
    ['-c', `source "$1"; { ${expr}; } || true`, 'bash', lib],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

  const cases = [
    // host válido
    ['valid_host 192.0.2.10 && echo ok', 'ok'],
    ['valid_host meu-servidor && echo ok', 'ok'],
    ['valid_host localhost && echo ok', 'ok'],
    // host inválido (injeção)
    ['valid_host "-evil" && echo ok', ''],
    ['valid_host "evil;rm -rf" && echo ok', ''],
    ['valid_host "a b" && echo ok', ''],
    ['valid_host "a/b" && echo ok', ''],
    ['valid_host "" && echo ok', ''],
    // usuário
    ['valid_user root && echo ok', 'ok'],
    ['valid_user "root\\nHost evil" && echo ok', ''],
    // porta
    ['valid_port 22 && echo ok', 'ok'],
    ['valid_port 65535 && echo ok', 'ok'],
    ['valid_port 0 && echo ok', ''],
    ['valid_port 70000 && echo ok', ''],
    ['valid_port abc && echo ok', ''],
    ['valid_port "" && echo ok', ''],
    // alias
    ['valid_alias dash-192_168_100_75 && echo ok', 'ok'],
    ['valid_alias meu-servidor && echo ok', 'ok'],
    ['valid_alias "-x" && echo ok', ''],
    ['valid_alias "" && echo ok', ''],
    // placeholder
    ['is_placeholder_host seu-host && echo ok', 'ok'],
    ['is_placeholder_host seu_host_ou_alias_ssh && echo ok', 'ok'],
    ['is_placeholder_host SEU-HOST && echo ok', 'ok'],
    ['is_placeholder_host dash-192_168_100_75 && echo ok', ''],
    ['is_placeholder_host 192.0.2.10 && echo ok', ''],
  ];
  for (const [expr, expected] of cases) {
    assert.equal(run(expr), expected, `falhou: ${expr}`);
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
    'install.sh', 'install-lib.sh', 'start.sh', 'stop.sh', '.env.example', 'public/index.html',
    'public/js/main.js', 'public/js/router.js', 'public/js/charts.js',
    'public/js/sections.js', 'public/js/analysis.js',
  ];
  for (const rel of required) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} deveria existir`);
  }
});