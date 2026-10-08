// A documentação bate com o código (critério de saída da F8). Cada fato que a documentação
// afirma e que dá para conferir sozinho é conferido aqui: links, arquivos citados, comandos e
// opções do ./dashboard, scripts do npm, variáveis do .env (nomes, padrões e faixas), rotas
// da API, versões das bibliotecas, o exemplo do comando de coleta e os IPs de exemplo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_NAMES } from '../../server/cli/index.js';
import { UNIT_NAME } from '../../server/cli/servico.js';
import { V1_UNIT } from '../../server/cli/importar-v1.js';
import { buildScript } from '../../server/collector/builder.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MAIN_DOCS = ['README.md', 'TUTORIAL.md', 'AGENTS.md', 'SECURITY.md'];
const ADRS = fs.readdirSync(path.join(ROOT, 'docs', 'adr')).filter((f) => f.endsWith('.md')).map((f) => `docs/adr/${f}`);

function allMarkdown(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'data', '.runtime', '.backups'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allMarkdown(p, out);
    else if (e.name.endsWith('.md')) out.push(path.relative(ROOT, p));
  }
  return out;
}

/** Texto fora dos blocos de código cercados (```). */
function prose(md) {
  let inFence = false;
  return md.split('\n').map((l) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return ''; }
    return inFence ? '' : l;
  }).join('\n');
}

/** Âncoras que o GitHub gera para os títulos (com -1, -2… nos repetidos). */
function anchors(md) {
  const seen = new Map();
  const out = new Set();
  for (const line of prose(md).split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const text = m[1].replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]{2}/g, '');
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

const cliSource = ['server/cli', 'server/setup']
  .flatMap((d) => fs.readdirSync(path.join(ROOT, d)).map((f) => read(`${d}/${f}`)))
  .join('\n');

test('docs: links relativos e âncoras apontam para o que existe', () => {
  const problems = [];
  for (const file of allMarkdown()) {
    const text = prose(read(file));
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [rel, anchor] = target.split('#');
      const dest = rel ? path.join(path.dirname(path.join(ROOT, file)), decodeURI(rel)) : path.join(ROOT, file);
      if (!fs.existsSync(dest)) { problems.push(`${file}: ${target} (arquivo não existe)`); continue; }
      if (anchor && dest.endsWith('.md') && !anchors(fs.readFileSync(dest, 'utf8')).has(decodeURIComponent(anchor))) {
        problems.push(`${file}: ${target} (âncora não existe)`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('docs: arquivos e pastas citados existem', () => {
  const problems = [];
  const repoPath = /^(?:(?:server|public|scripts|test|test-support|docs)\/[A-Za-z0-9_.\/-]*|[A-Z]+\.md|\.env\.example|package\.json|LICENSE)$/;
  for (const file of [...MAIN_DOCS, ...ADRS]) {
    for (const [, token] of prose(read(file)).matchAll(/`([^`\s]+)`/g)) {
      if (repoPath.test(token) && !fs.existsSync(path.join(ROOT, token))) problems.push(`${file}: ${token}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('docs: subcomandos e opções do ./dashboard existem', () => {
  const problems = [];
  const knownFlag = (f) => cliSource.includes(`--${f}`) || cliSource.includes(`flags['${f}']`) || new RegExp(`flags\\.${f}\\b`).test(cliSource);
  for (const file of [...MAIN_DOCS, ...ADRS, 'docs/PLANO_V2.md']) {
    for (const [, sub, rest] of read(file).matchAll(/\.\/dashboard(?:[ \t]+([a-z][a-z0-9-]*))?([^`|\n#]*)/g)) {
      if (sub && !COMMAND_NAMES.includes(sub)) problems.push(`${file}: ./dashboard ${sub}`);
      for (const [, flag] of rest.matchAll(/--([a-z][a-z0-9-]*)/g)) {
        if (!knownFlag(flag)) problems.push(`${file}: ./dashboard ${sub ?? ''} --${flag}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('docs: scripts do npm citados existem no package.json', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  const problems = [];
  for (const file of MAIN_DOCS) {
    for (const [, name] of read(file).matchAll(/npm (?:run )?([a-z][a-z0-9:-]*)/g)) {
      if (['install', 'audit', 'ci'].includes(name)) continue;
      if (!scripts[name]) problems.push(`${file}: npm ${name}`);
    }
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------- variáveis do .env

const configSource = read('server/config.js');
const ENV_KEYS = [
  ...[...configSource.matchAll(/^ {2}([A-Z][A-Z_]+):/gm)].map((m) => m[1]).filter((k) => k !== 'ALERTS'),
  ...new Set([...configSource.matchAll(/'(ALERT_[A-Z_]+)'/g)].map((m) => m[1])),
].sort();
const ALERT_FIELD = { ALERT_DISK_PCT: 'diskPct', ALERT_RAM_PCT: 'ramPct', ALERT_TEMP_C: 'tempC', ALERT_HYSTERESIS: 'hysteresis', ALERT_OFFLINE_AFTER: 'offlineAfter' };

/** Linhas da tabela "Configuração" do AGENTS: { KEY: { padrao, faixa } }. */
function agentsEnvTable() {
  const md = read('AGENTS.md');
  const start = md.indexOf('## Configuração');
  const section = md.slice(start, md.indexOf('\n## ', start + 3));
  const rows = {};
  for (const line of section.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const key = cells[0]?.match(/^`([A-Z][A-Z_]+)`$/)?.[1];
    if (key) rows[key] = { padrao: cells[1], faixa: cells[2] };
  }
  return rows;
}

/** A configuração que o painel monta com estes valores no ambiente (num processo à parte). */
function loadConfig(values) {
  const envVars = { ...process.env };
  for (const k of ENV_KEYS) envVars[k] = values[k] ?? '';
  const code = `import('./server/config.js').then(({ config, ROOT }) => {
    const rel = (p) => (typeof p === 'string' && p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p);
    const out = {};
    for (const [k, v] of Object.entries(config)) out[k] = Array.isArray(v) ? v.join(' ') : rel(v);
    console.log(JSON.stringify(out));
  })`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: envVars, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  for (const [k, field] of Object.entries(ALERT_FIELD)) c[k] = c.ALERTS[field];
  return c;
}

test('docs: as variáveis do .env são as mesmas no código, no AGENTS e no .env.example', () => {
  assert.ok(ENV_KEYS.length >= 18, `achei só ${ENV_KEYS.length} variáveis no config.js`);
  assert.deepEqual(Object.keys(agentsEnvTable()).sort(), ENV_KEYS, 'tabela "Configuração" do AGENTS');
  // Linha comentada vale (SMART_DEVS: presente e vazia desligaria o SMART de quem copiar o modelo).
  const example = [...read('.env.example').matchAll(/^(?:# )?([A-Z][A-Z_]+)=/gm)].map((m) => m[1]).sort();
  assert.deepEqual(example, ENV_KEYS, '.env.example');
  // Nenhum nome de variável desta família citado nos outros docs fica de fora do código.
  const family = /^(SSH_[A-Z]+|POLL_INTERVAL|PORT|HISTORY_[A-Z]+|LOG_FILE|NET_IF|DISK_[A-Z]+|SMART_[A-Z]+|SERVICES|DASH_[A-Z]+|ALERT_[A-Z_]+)$/;
  for (const file of [...MAIN_DOCS, ...ADRS]) {
    for (const [, token] of read(file).matchAll(/`([A-Z][A-Z_]+)`/g)) {
      if (family.test(token)) assert.ok(ENV_KEYS.includes(token), `${file}: \`${token}\` não existe no config.js`);
    }
  }
});

test('docs: padrões e faixas da tabela de configuração do AGENTS são os do código', () => {
  const rows = agentsEnvTable();
  const defaults = loadConfig({});
  for (const [key, { padrao }] of Object.entries(rows)) {
    const literal = padrao.match(/^`([^`]*)`$/)?.[1];
    if (literal !== undefined) assert.equal(String(defaults[key]), literal, `${key}: padrão`);
    else if (/vazio/.test(padrao)) assert.equal(defaults[key], '', `${key}: padrão vazio`);
  }
  // Faixas "mín–máx": no limite vale, um passo fora volta ao padrão.
  const ranged = Object.entries(rows)
    .map(([key, r]) => [key, r.faixa.match(/^`?(\d+)`?[–-]`?(\d+)`?$/)])
    .filter(([, m]) => m)
    .map(([key, m]) => ({ key, min: Number(m[1]), max: Number(m[2]) }));
  assert.ok(ranged.length >= 8, 'faixas documentadas');
  const pick = (fn) => Object.fromEntries(ranged.map((r) => [r.key, String(fn(r))]));
  const atMin = loadConfig(pick((r) => r.min));
  const atMax = loadConfig(pick((r) => r.max));
  const below = loadConfig(pick((r) => r.min - 1));
  const above = loadConfig(pick((r) => r.max + 1));
  for (const { key, min, max } of ranged) {
    assert.equal(atMin[key], min, `${key}=${min} vale`);
    assert.equal(atMax[key], max, `${key}=${max} vale`);
    assert.equal(below[key], defaults[key], `${key}=${min - 1} volta ao padrão`);
    assert.equal(above[key], defaults[key], `${key}=${max + 1} volta ao padrão`);
  }
});

// ---------------------------------------------------------------- API, versões e nomes

test('docs: rotas da API documentadas existem e toda rota do painel está no AGENTS', () => {
  const routes = (file) => [...read(file).matchAll(/app\.(get|post|delete|put)\('(\/[^']*)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  const panel = routes('server/index.js');
  const wizard = routes('server/setup/web.js');
  const paths = new Set([...panel, ...wizard].map((r) => r.split(' ')[1]));
  const agents = read('AGENTS.md');
  const table = new Set();
  for (const line of agents.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const p = cells[0]?.match(/^`(\/[^`?\s]*)/)?.[1];
    if (!p || !/^[A-Z/ ]+$/.test(cells[1] || '')) continue;
    for (const method of cells[1].split('/').map((m) => m.trim())) table.add(`${method} ${p}`);
  }
  for (const r of panel) assert.ok(table.has(r), `rota ${r} fora da tabela da API do AGENTS`);
  for (const file of MAIN_DOCS) {
    for (const [, p] of read(file).matchAll(/`((?:\/api|\/entrar|\/configurar)[^`?\s]*)/g)) {
      const ok = p.endsWith('/*') ? [...paths].some((x) => x.startsWith(p.slice(0, -1))) : paths.has(p);
      assert.ok(ok, `${file}: ${p} não é uma rota`);
    }
  }
});

test('docs: versões citadas são as do pacote', () => {
  const vendor = JSON.parse(read('public/vendor/vendor.json'));
  const node = read('scripts/node-runtime.sh').match(/^NODE_VERSION="([^"]+)"/m)[1];
  const checks = [
    [/uPlot\s+(\d+\.\d+\.\d+)/g, vendor.uplot.version],
    [/Geist(?: \+ Geist Mono| Mono)?\s+(\d+\.\d+\.\d+)/g, vendor.geist.version],
    [/Node(?:\.js)?\s+(\d+\.\d+\.\d+)/g, node],
  ];
  for (const file of MAIN_DOCS) {
    for (const [re, want] of checks) {
      for (const [, got] of read(file).matchAll(re)) assert.equal(got, want, `${file}: ${re.source}`);
    }
  }
  assert.equal(JSON.parse(read('package.json')).engines.node, `>=${node.split('.')[0]}`);
});

test('docs: nome do serviço systemd e arquivo do sudoers são os do código', () => {
  const unit = UNIT_NAME.replace(/\.service$/, '');
  const units = new Set([unit, V1_UNIT.replace(/\.service$/, '')]);
  const sudoers = read('server/setup/preparo.js').match(/const SUDOERS = '([^']+)'/)[1];
  for (const file of [...MAIN_DOCS, 'public/js/views/ajuda.js']) {
    const text = read(file);
    for (const [, name] of text.matchAll(/(?:systemctl --user [a-z-]+(?: --now)?|journalctl --user -u) ([a-z][a-z0-9-]*)/g)) {
      assert.ok(units.has(name), `${file}: serviço ${name}`);
    }
    for (const [p] of text.matchAll(/\/etc\/sudoers\.d\/[a-z0-9_-]+/g)) assert.equal(p, sudoers, `${file}: ${p}`);
  }
});

test('docs: exemplos usam só IPs de documentação (RFC 5737) ou de loopback', () => {
  const allowed = /^(127\.0\.0\.1|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
  for (const file of [...MAIN_DOCS, ...ADRS, '.env.example', 'public/js/views/ajuda.js', 'public/js/configurar/main.js']) {
    for (const [ip] of read(file).matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g)) {
      assert.match(ip, allowed, `${file}: ${ip}`);
    }
  }
});

test('docs: o exemplo do comando de coleta no AGENTS é o que o builder gera', () => {
  const md = read('AGENTS.md');
  const start = md.indexOf('## Comando SSH de coleta');
  assert.ok(start > 0, 'seção "Comando SSH de coleta" no AGENTS');
  const block = md.slice(start).match(/```sh\n([\s\S]*?)```/)[1];
  // Os parâmetros que o próprio texto do exemplo diz usar.
  const intro = md.slice(start, md.indexOf('```sh', start));
  for (const v of ['NET_IF=enpXsY', 'DISK_MOUNTS=/ /mnt/disco1', 'DISK_DEVS=sda sdb', 'SERVICES=smbd nmbd']) {
    assert.ok(intro.includes(v), `o exemplo diz usar ${v}`);
  }
  const { script } = buildScript({ netIf: 'enpXsY', mounts: ['/', '/mnt/disco1'], devs: ['sda', 'sdb'], services: ['smbd', 'nmbd'] }, 'smart');
  for (const raw of block.split('\n').filter((l) => l.trim())) {
    const line = raw.trim().replace(/;$/, '');
    for (const piece of line.split(/<[^>]*>/).map((p) => p.trim().replace(/^;|;$/g, '').trim()).filter(Boolean)) {
      assert.ok(script.includes(piece), `trecho do exemplo que o builder não gera: ${piece}`);
    }
  }
  for (const [s] of script.matchAll(/echo '===[A-Z]+==='/g)) assert.ok(block.includes(s), `o exemplo omite ${s}`);
});

test('docs: cada ameaça do SECURITY diz que teste a confere', () => {
  const md = read('SECURITY.md');
  const model = md.slice(md.indexOf('## Modelo de ameaças'), md.indexOf('\n## ', md.indexOf('## Modelo de ameaças') + 3));
  const sections = model.split(/^### /m).slice(1);
  assert.ok(sections.length >= 12, `ameaças no SECURITY: ${sections.length}`);
  for (const s of sections) {
    const title = s.split('\n')[0];
    const verified = s.match(/\*\*Verificado por:\*\*([^\n]*(?:\n(?!\n|- \*\*)[^\n]*)*)/);
    assert.ok(verified, `"${title}" sem "Verificado por"`);
    const tests = [...verified[1].matchAll(/`((?:test|scripts)\/[^`]+)`/g)].map((m) => m[1]);
    assert.ok(tests.length, `"${title}": "Verificado por" sem arquivo de teste`);
  }
});

test('docs: o README continua enxuto (detalhes técnicos ficam no AGENTS)', () => {
  const lines = read('README.md').split('\n').length;
  assert.ok(lines <= 220, `README com ${lines} linhas`);
});
