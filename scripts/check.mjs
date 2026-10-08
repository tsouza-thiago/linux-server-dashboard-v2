#!/usr/bin/env node
// Verificação completa antes de cada commit: `npm run check`.
// Roda em sequência e para no primeiro erro (exit != 0).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_SCRIPTS = ['dashboard', 'scripts/node-runtime.sh'];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(rel));
    else if (/\.(m?js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const steps = [
  {
    name: 'sintaxe JavaScript (node --check)',
    fn() {
      const files = [...listJs('server'), ...listJs('public/js'), ...listJs('scripts')];
      const bad = files.filter((f) => run(process.execPath, ['--check', f]).status !== 0);
      return { ok: bad.length === 0, detail: bad.length ? `falhou: ${bad.join(', ')}` : `${files.length} arquivos` };
    },
  },
  {
    name: 'sintaxe shell (bash -n)',
    fn() {
      const bad = SHELL_SCRIPTS.filter((f) => run('bash', ['-n', f]).status !== 0);
      return { ok: bad.length === 0, detail: bad.length ? `falhou: ${bad.join(', ')}` : `${SHELL_SCRIPTS.length} scripts` };
    },
  },
  {
    name: 'segredos fora do git (.env e data/)',
    fn() {
      const r = run('git', ['ls-files', '--', '.env', 'data']);
      const tracked = (r.stdout || '').trim();
      return { ok: r.status === 0 && tracked === '', detail: tracked ? `rastreados: ${tracked}` : 'nada rastreado' };
    },
  },
  {
    name: 'testes + cobertura (node --test)',
    fn() {
      const r = run(process.execPath, [
        '--test',
        '--experimental-test-coverage',
        '--test-coverage-exclude=test/**',
        '--test-coverage-exclude=test-support/**',
        '--test-reporter=spec',
      ]);
      const out = `${r.stdout}${r.stderr}`;
      const pick = (label) => (out.match(new RegExp(`ℹ ${label} (\\d+)`)) || [])[1];
      const total = out.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
      if (r.status !== 0) process.stdout.write(out);
      const cov = total ? ` · cobertura linhas ${total[1]}% · ramos ${total[2]}% · funções ${total[3]}%` : '';
      return {
        ok: r.status === 0,
        detail: `${pick('pass') ?? '?'} ok · ${pick('fail') ?? '?'} falhas · ${pick('todo') ?? 0} todo${cov}`,
      };
    },
  },
  {
    name: 'dependências de runtime (npm audit)',
    fn() {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = run(npm, ['audit', '--omit=dev', '--audit-level=moderate']);
      const line = `${r.stdout}`.trim().split('\n').pop();
      return { ok: r.status === 0, detail: line };
    },
  },
];

let failed = false;
for (const step of steps) {
  const { ok, detail } = step.fn();
  console.log(`${ok ? '✓' : '✗'} ${step.name} — ${detail}`);
  if (!ok) { failed = true; break; }
}
console.log(failed ? '\nCHECK FALHOU — não faça commit.' : '\nCHECK OK');
process.exit(failed ? 1 : 0);
