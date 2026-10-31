#!/usr/bin/env node
// Verificação completa antes de cada commit: `npm run check`.
// Roda em sequência e para no primeiro erro (exit != 0): sintaxe JS e shell, .env/data/
// fora do git, testes com cobertura (inclui test/seguranca/) e npm audit do runtime.
// Se um teste falhar, a saída completa fica em .check/ultima-falha.log (fora do git) e o
// relatório diz o nome de cada teste que falhou (#25).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Raiz do projeto e os scripts shell conferidos com `bash -n`.
const SHELL_SCRIPTS = ['dashboard', 'scripts/node-runtime.sh', 'scripts/askpass.sh', 'scripts/completar.bash', 'scripts/e2e-instalacao/rodar.sh'];
// Saída completa da última suíte vermelha. Uma falha rara (teste instável) só pode ser
// investigada se a saída inteira sobreviver ao terminal e ao relatório resumido.
export const LOG_FALHA = path.join('.check', 'ultima-falha.log');

/** Roda um comando na raiz (sem shell) e devolve o resultado do spawnSync. */
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

/** Todos os .js/.mjs de uma pasta, recursivamente (caminhos relativos à raiz). */
function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(rel));
    else if (/\.(m?js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * Nomes dos testes que falharam, lidos da seção "failing tests" do reporter spec do
 * node --test (cada falha começa com ✖ e termina com a duração entre parênteses).
 */
export function testesQueFalharam(out) {
  const inicio = String(out).indexOf('✖ failing tests:');
  if (inicio < 0) return [];
  const nomes = [];
  for (const linha of String(out).slice(inicio).split('\n').slice(1)) {
    const m = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(linha.trim());
    if (m) nomes.push(m[1]);
  }
  return [...new Set(nomes)];
}

/** Grava a saída completa de uma suíte vermelha (0700/0600: pode citar caminhos locais). */
function guardarFalha(out) {
  const file = path.join(ROOT, LOG_FALHA);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, out, { mode: 0o600 });
}

// Os passos, na ordem: cada um devolve { ok, detail } para a linha do relatório.
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
    name: 'segredos fora do git (.env, data/ e .atualizacao/)',
    fn() {
      // O .env e o data/ nunca podem estar no git (segredos e telemetria da rede interna), e o
      // log da atualização cita caminhos da máquina.
      const r = run('git', ['ls-files', '--', '.env', 'data', '.atualizacao']);
      const tracked = (r.stdout || '').trim();
      return { ok: r.status === 0 && tracked === '', detail: tracked ? `rastreados: ${tracked}` : 'nada rastreado' };
    },
  },
  {
    name: 'testes + cobertura (node --test)',
    fn() {
      // Testes e auxiliares ficam fora da conta de cobertura (só o código do painel conta).
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
      const cov = total ? ` · cobertura linhas ${total[1]}% · ramos ${total[2]}% · funções ${total[3]}%` : '';
      let falhas = '';
      if (r.status !== 0) {
        process.stdout.write(out);
        guardarFalha(out);
        const nomes = testesQueFalharam(out);
        falhas = `${nomes.length ? `\n    falharam: ${nomes.join(' | ')}` : ''}\n    saída completa: ${LOG_FALHA}`;
      }
      return {
        ok: r.status === 0,
        detail: `${pick('pass') ?? '?'} ok · ${pick('fail') ?? '?'} falhas · ${pick('todo') ?? 0} todo${cov}${falhas}`,
      };
    },
  },
  {
    name: 'dependências de runtime (npm audit)',
    fn() {
      // Só o runtime importa (que hoje não tem dependência); devDependencies ficam de fora.
      const r = run('npm', ['audit', '--omit=dev', '--audit-level=moderate']);
      const line = `${r.stdout}`.trim().split('\n').pop();
      return { ok: r.status === 0, detail: line };
    },
  },
];

// Para no primeiro passo vermelho: nenhum commit com a verificação falhando. Só roda
// chamado pela linha de comando (os testes importam testesQueFalharam sem rodar o check).
const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) {
  let failed = false;
  for (const step of steps) {
    const { ok, detail } = step.fn();
    console.log(`${ok ? '✓' : '✗'} ${step.name} — ${detail}`);
    if (!ok) { failed = true; break; }
  }
  console.log(failed ? '\nCHECK FALHOU — não faça commit.' : '\nCHECK OK');
  process.exit(failed ? 1 : 0);
}
