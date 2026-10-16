#!/usr/bin/env node
// Varredura de segurança com ferramentas externas: `npm run seguranca`.
//
// Complementa os testes nativos de test/seguranca/ (que rodam em todo `npm run check`) com
// ferramentas conhecidas, alinhadas ao OWASP Top 10 e ao CWE Top 25:
//
//   semgrep    análise estática (regras p/owasp-top-ten, nodejs, javascript, xss,
//              command-injection e secrets)
//   segredos   Gitleaks: segredos nos arquivos e em TODO o histórico do git (OSINT: o que
//              um atacante colhe do repositório público)
//   shell      ShellCheck nos scripts shell
//   osv        OSV-Scanner: vulnerabilidades conhecidas nas dependências (package-lock.json)
//   zap        OWASP ZAP: ataque dinâmico (passivo + ativo) a um painel de teste local, com
//              a API descrita por um OpenAPI gerado das próprias rotas
//   mutacao    scripts/mutacao-seguranca.mjs: quebra cada guarda de segurança de propósito
//              e exige que os testes acusem
//
// Cada ferramenta roda numa imagem Docker fixada por digest (a mesma em toda máquina e no
// CI). Sem Docker, as etapas que dependem dele avisam e pulam; no CI (CI=true) a falta de
// Docker é erro. Achado aceito só com análise em docs/seguranca/excecoes.json.
//
// Uso: npm run seguranca [-- --so=semgrep,zap] [-- --pular=zap]
// Relatórios brutos: .seguranca/ (fora do git, só o dono lê).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.seguranca');

// Imagens fixadas por digest (sha256): trocar de versão é um commit consciente, nunca um
// "latest" que muda sozinho (cadeia de suprimentos, OWASP A03:2025).
const IMG = {
  semgrep: 'semgrep/semgrep@sha256:529ee8a277ec8adc5b534d7c74eea0a47e9de21d62852b6ba7ac6ba9566845c3',
  segredos: 'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f',
  shell: 'koalaman/shellcheck-alpine@sha256:c82fe42504fbc9fc68f15d36638e5ee2324ebb8b94e96a3c4e395bf361c49183',
  osv: 'ghcr.io/google/osv-scanner@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0',
  zap: 'ghcr.io/zaproxy/zaproxy@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6',
};

const SEMGREP_REGRAS = ['p/owasp-top-ten', 'p/nodejs', 'p/javascript', 'p/xss', 'p/command-injection', 'p/secrets'];
const SHELL_SCRIPTS = ['dashboard', 'scripts/node-runtime.sh', 'scripts/askpass.sh', 'scripts/e2e-instalacao/rodar.sh'];

// ---------------------------------------------------------------- utilidades

/** Opções `--so=a,b` e `--pular=c` da linha de comando. */
function opcoes(argv) {
  const lista = (nome) => (argv.find((a) => a.startsWith(`--${nome}=`)) || '').split('=')[1]?.split(',').filter(Boolean) || [];
  return { so: lista('so'), pular: lista('pular') };
}

/** Roda um comando sem shell (argumentos em lista: nada é interpretado). */
function rodar(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

const temDocker = () => rodar('docker', ['version', '--format', '{{.Server.Version}}']).status === 0;

/** Grava um relatório bruto em .seguranca/ (pasta 0700, arquivo 0600). */
function guardar(nome, conteudo) {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, nome), conteudo, { mode: 0o600 });
}

/** Achados aceitos, cada um com motivo e teste que o confere (docs/seguranca/excecoes.json). */
function excecoes() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'seguranca', 'excecoes.json'), 'utf8')).excecoes || [];
  } catch {
    return [];
  }
}

/** O achado `{ferramenta, regra, arquivo}` está na lista de exceções analisadas? */
function aceito({ ferramenta, regra, arquivo = '' }) {
  return excecoes().some((e) => e.ferramenta === ferramenta && e.regra === regra
    && (!e.arquivo || arquivo === e.arquivo || arquivo.startsWith(`${e.arquivo}/`)));
}

/** Separa achados novos (reprovam) dos já analisados (só informados). */
function triar(achados) {
  const novos = achados.filter((a) => !aceito(a));
  return { novos, aceitos: achados.length - novos.length };
}

const resumo = (a) => `${a.regra} em ${a.arquivo || '?'}${a.linha ? `:${a.linha}` : ''}`;

// ---------------------------------------------------------------- etapas

/** Semgrep: análise estática com as regras OWASP. Reprova ERROR e WARNING novos. */
function semgrep() {
  const args = ['run', '--rm', '-v', `${ROOT}:/src:ro`, '-w', '/src', IMG.semgrep, 'semgrep', 'scan',
    '--metrics=off', '--json', '-q', '--exclude', 'node_modules', '--exclude', 'public/vendor',
    '--exclude', '.seguranca', ...SEMGREP_REGRAS.flatMap((r) => ['--config', r])];
  const r = rodar('docker', args);
  guardar('semgrep.json', r.stdout || r.stderr);
  let dados;
  try { dados = JSON.parse(r.stdout); } catch { return { ok: false, detalhe: `saída inválida: ${(r.stderr || '').trim().split('\n').pop()}` }; }
  const achados = dados.results
    .filter((x) => ['ERROR', 'WARNING'].includes(x.extra.severity))
    .map((x) => ({ ferramenta: 'semgrep', regra: x.check_id, arquivo: x.path, linha: x.start.line }));
  const { novos, aceitos } = triar(achados);
  const info = dados.results.length - achados.length;
  return {
    ok: novos.length === 0 && (dados.errors || []).filter((e) => e.level === 'error').length === 0,
    detalhe: `${novos.length} novos · ${aceitos} analisados · ${info} informativos`,
    novos,
  };
}

/**
 * Gitleaks: segredos nos arquivos e em todo o histórico. O worktree e o .git comum são
 * montados nos mesmos caminhos absolutos para o `git log` funcionar dentro do contêiner.
 */
function segredos() {
  const gitDir = path.resolve(ROOT, rodar('git', ['rev-parse', '--git-common-dir']).stdout.trim());
  const montagens = ['-v', `${ROOT}:${ROOT}:ro`];
  if (!gitDir.startsWith(`${ROOT}/`)) montagens.push('-v', `${gitDir}:${gitDir}:ro`);
  const seguro = ['-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=*'];
  // O relatório sai numa pasta temporária montada com escrita (o resto é só leitura).
  // A pasta aberta (0777, para o usuário do contêiner escrever) fica dentro de uma pasta
  // 0700: outro usuário desta máquina não consegue plantar um relatório "limpo".
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-segredos-'));
  const rel = path.join(base, 'relatorio');
  fs.mkdirSync(rel);
  fs.chmodSync(rel, 0o777);
  montagens.push('-v', `${rel}:/relatorio:rw`);
  const achados = [];
  let commits = 0;
  for (const [modo, extra] of [['git', ['--log-opts=--all']], ['dir', []]]) {
    const r = rodar('docker', ['run', '--rm', ...montagens, ...seguro, IMG.segredos, modo, ROOT, '--no-banner',
      '--redact', '--exit-code', '0', '--report-format', 'json', '--report-path', `/relatorio/${modo}.json`, ...extra]);
    let lista;
    try {
      const bruto = fs.readFileSync(path.join(rel, `${modo}.json`), 'utf8');
      guardar(`segredos-${modo}.json`, bruto);
      lista = JSON.parse(bruto);
    } catch {
      fs.rmSync(base, { recursive: true, force: true });
      return { ok: false, detalhe: `gitleaks ${modo}: ${(r.stderr || '').trim().split('\n').pop()}` };
    }
    // Quantos commits o modo "histórico" percorreu: zero quer dizer que o histórico não foi
    // lido (montagem errada), e isso reprova em vez de passar em silêncio.
    if (extra.length) commits = Number((`${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').match(/(\d+) commits scanned/) || [])[1] || 0);
    for (const x of lista) achados.push({ ferramenta: 'gitleaks', regra: x.RuleID, arquivo: x.File.replace(`${ROOT}/`, ''), linha: x.StartLine, commit: x.Commit });
  }
  fs.rmSync(base, { recursive: true, force: true });
  const { novos, aceitos } = triar(achados);
  return {
    ok: novos.length === 0 && commits > 0,
    detalhe: `${novos.length} novos · ${aceitos} analisados · ${commits} commits do histórico + arquivos`,
    novos,
  };
}

/** ShellCheck nos scripts shell (avisos e erros reprovam). */
function shell() {
  const r = rodar('docker', ['run', '--rm', '-v', `${ROOT}:/mnt:ro`, '-w', '/mnt', IMG.shell,
    'shellcheck', '-f', 'json1', '-S', 'warning', ...SHELL_SCRIPTS]);
  guardar('shellcheck.json', r.stdout || r.stderr);
  let dados;
  try { dados = JSON.parse(r.stdout); } catch { return { ok: false, detalhe: `saída inválida: ${(r.stderr || '').trim()}` }; }
  const achados = dados.comments.map((c) => ({ ferramenta: 'shellcheck', regra: `SC${c.code}`, arquivo: c.file, linha: c.line }));
  const { novos, aceitos } = triar(achados);
  return { ok: novos.length === 0, detalhe: `${novos.length} novos · ${aceitos} analisados · ${SHELL_SCRIPTS.length} scripts`, novos };
}

/** OSV-Scanner: vulnerabilidades publicadas para as versões travadas no package-lock.json. */
function osv() {
  const r = rodar('docker', ['run', '--rm', '-v', `${ROOT}:/src:ro`, IMG.osv, 'scan', 'source',
    '--lockfile', '/src/package-lock.json', '--format', 'json']);
  guardar('osv.json', r.stdout || r.stderr);
  let dados;
  try { dados = JSON.parse(r.stdout); } catch { return { ok: false, detalhe: `saída inválida: ${(r.stderr || '').trim().split('\n').pop()}` }; }
  const achados = (dados.results || []).flatMap((res) => res.packages || []).flatMap((p) => (p.vulnerabilities || [])
    .map((v) => ({ ferramenta: 'osv', regra: v.id, arquivo: `${p.package.name}@${p.package.version}` })));
  const { novos, aceitos } = triar(achados);
  return { ok: novos.length === 0, detalhe: `${novos.length} novos · ${aceitos} analisados`, novos };
}

/** Parâmetros conhecidos de cada rota, para o ZAP saber o que atacar. */
const PARAMS = {
  '/api/history': ['limit', 'from', 'to', 'formato'],
  '/api/export': ['format', 'from', 'to'],
  '/api/outages': ['days'],
  '/api/alerts': ['status', 'level', 'limit'],
  '/entrar': ['codigo'],
};
const CORPOS = {
  '/api/login': { token: 'string', remember: 'boolean' },
  '/api/annotations': { ts: 'string', text: 'string', label: 'string' },
};

/** OpenAPI 3 gerado das rotas reais do painel (nenhuma rota fica de fora do ataque). */
async function openapi(base) {
  const { rotasDoPainel } = await import('../test-support/rotas.js');
  const paths = { '/': { get: { responses: { 200: { description: 'ok' } } } } };
  for (const { metodo, caminho } of rotasDoPainel()) {
    const p = caminho.replace(/:([A-Za-z]+)/g, '{$1}');
    const op = { responses: { 200: { description: 'ok' } }, parameters: [] };
    for (const [, nome] of caminho.matchAll(/:([A-Za-z]+)/g)) op.parameters.push({ name: nome, in: 'path', required: true, schema: { type: 'string' } });
    for (const nome of PARAMS[caminho] || []) op.parameters.push({ name: nome, in: 'query', schema: { type: 'string' } });
    if (CORPOS[caminho]) {
      const props = Object.fromEntries(Object.entries(CORPOS[caminho]).map(([k, t]) => [k, { type: t }]));
      op.requestBody = { content: { 'application/json': { schema: { type: 'object', properties: props } } } };
    }
    paths[p] = { ...(paths[p] || {}), [metodo.toLowerCase()]: op };
  }
  return { openapi: '3.0.0', info: { title: 'Server Dashboard', version: 'teste' }, servers: [{ url: base }], paths };
}

/**
 * OWASP ZAP contra um painel de teste: dados falsos, DASH_TOKEN aleatório (o ZAP entra com
 * Bearer) e escuta só em 127.0.0.1 (`--network host`, porque o Host check recusa outro
 * nome). Varredura passiva + ativa, com teto de tempo. Reprova risco médio ou alto novo.
 */
async function zap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-zap-'));
  const token = crypto.randomBytes(24).toString('hex');
  const { createApp } = await import('../server/index.js');
  const app = createApp({
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'), dashToken: token, log: () => {},
    collect: async () => ({ ok: false, error: 'sem coleta na varredura' }),
    // Sem os limites de taxa, para o ZAP chegar a todas as rotas em vez de colher só 429.
    // Os limites são conferidos à parte (test/integration/api-ext.test.js).
    rateLimitMax: 1e6, loginRateMax: 1e6,
  });
  // Conta as respostas por código HTTP: se nenhuma for 2xx, o ZAP não conseguiu entrar (Bearer
  // errado, rota trocada) e a varredura seria rasa. Isso reprova em vez de passar.
  const codigos = {};
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.on('finish', () => { codigos[res.statusCode] = (codigos[res.statusCode] || 0) + 1; });
      app.app(req, res);
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  // A pasta de trabalho é montada no contêiner; o usuário "zap" dele precisa escrever nela.
  const wrk = path.join(dir, 'wrk');
  fs.mkdirSync(wrk, { mode: 0o777 });
  fs.chmodSync(wrk, 0o777);
  fs.writeFileSync(path.join(wrk, 'openapi.json'), JSON.stringify(await openapi(base)));
  // O ZAP entra com `Authorization: Bearer <token>` em todo pedido (variáveis de ambiente dos
  // scans empacotados; o `-z` quebraria o valor no espaço). O token vai pelo ambiente do
  // `docker run`, não pela linha de comando do processo.
  // Teto de 20 min: se o ZAP travar, o contêiner (com nome próprio) é parado e a etapa
  // reprova "sem relatório", em vez de o `npm run seguranca` esperar para sempre.
  const nome = `dash-zap-${process.pid}-${Date.now()}`;
  const teto = setTimeout(() => spawnSync('docker', ['stop', nome], { stdio: 'ignore' }), 20 * 60 * 1000);
  const r = await new Promise((resolve) => {
    const p = spawn('docker', ['run', '--rm', '--name', nome, '--network', 'host', '-v', `${wrk}:/zap/wrk:rw`,
      '-e', 'ZAP_AUTH_HEADER=Authorization', '-e', 'ZAP_AUTH_HEADER_VALUE', '-e', 'ZAP_AUTH_HEADER_SITE=127.0.0.1',
      IMG.zap, 'zap-api-scan.py', '-t', '/zap/wrk/openapi.json', '-f', 'openapi', '-J', 'zap.json',
      // Com --network host, o ZAP escutaria em todas as interfaces e com a API sem chave (padrão
      // dos scans empacotados): `-host 127.0.0.1` prende proxy e API no loopback durante a
      // varredura. (A lista api.addrs fica como o scan a quer: o script fala com a API pelo
      // nome "zap".)
      '-z', '-host 127.0.0.1 -config ascan.maxScanDurationInMins=10'],
    { cwd: ROOT, env: { ...process.env, ZAP_AUTH_HEADER_VALUE: `Bearer ${token}` } });
    let err = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (status) => resolve({ status, err }));
  });
  clearTimeout(teto);
  await app.shutdown();
  await new Promise((resolve) => server.close(resolve));
  let dados;
  try {
    const bruto = fs.readFileSync(path.join(wrk, 'zap.json'), 'utf8');
    guardar('zap.json', bruto);
    dados = JSON.parse(bruto);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, detalhe: `sem relatório (saída ${r.status}): ${r.err.trim().split('\n').pop() || '?'}` };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const alertas = (dados.site || []).flatMap((s) => s.alerts || []);
  const achados = alertas.filter((a) => Number(a.riskcode) >= 2).map((a) => ({
    ferramenta: 'zap', regra: `${a.pluginid} ${a.alert}`,
    arquivo: new URL(a.instances?.[0]?.uri || base).pathname,
  }));
  const { novos, aceitos } = triar(achados);
  const baixos = alertas.filter((a) => Number(a.riskcode) < 2).map((a) => `${a.pluginid} ${a.alert}`);
  guardar('zap-codigos.json', JSON.stringify(codigos));
  const total = Object.values(codigos).reduce((a, b) => a + b, 0);
  const ok2xx = Object.entries(codigos).filter(([c]) => c.startsWith('2')).reduce((a, [, n]) => a + n, 0);
  return {
    ok: novos.length === 0 && ok2xx > 0,
    detalhe: `${novos.length} médios/altos novos · ${aceitos} analisados · ${baixos.length} baixos/informativos · ${total} pedidos (${ok2xx} com 2xx)`,
    novos,
  };
}

/** Teste de mutação dos guardas de segurança (sem Docker). */
function mutacao() {
  const r = rodar(process.execPath, [path.join(ROOT, 'scripts', 'mutacao-seguranca.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  guardar('mutacao.txt', `${r.stdout}${r.stderr}`);
  const ultima = `${r.stdout}`.trim().split('\n').pop() || '';
  return { ok: r.status === 0, detalhe: ultima, novos: [] };
}

// ---------------------------------------------------------------- execução

const ETAPAS = [
  { nome: 'semgrep', titulo: 'análise estática OWASP (Semgrep)', docker: true, fn: semgrep },
  { nome: 'segredos', titulo: 'segredos no código e no histórico (Gitleaks)', docker: true, fn: segredos },
  { nome: 'shell', titulo: 'scripts shell (ShellCheck)', docker: true, fn: shell },
  { nome: 'osv', titulo: 'vulnerabilidades conhecidas nas dependências (OSV-Scanner)', docker: true, fn: osv },
  { nome: 'zap', titulo: 'ataque dinâmico à API (OWASP ZAP)', docker: true, fn: zap },
  { nome: 'mutacao', titulo: 'mutação dos guardas de segurança', docker: false, fn: mutacao },
];

async function main() {
  const { so, pular } = opcoes(process.argv.slice(2));
  const docker = temDocker();
  const noCI = process.env.CI === 'true';
  let falhou = false;
  for (const etapa of ETAPAS) {
    if ((so.length && !so.includes(etapa.nome)) || pular.includes(etapa.nome)) continue;
    if (etapa.docker && !docker) {
      console.log(`${noCI ? '✗' : '▲'} ${etapa.titulo} — sem Docker${noCI ? ' (obrigatório no CI)' : ': pulada'}`);
      if (noCI) falhou = true;
      continue;
    }
    const inicio = Date.now();
    const { ok, detalhe, novos = [] } = await etapa.fn();
    console.log(`${ok ? '✓' : '✗'} ${etapa.titulo} — ${detalhe} (${Math.round((Date.now() - inicio) / 1000)} s)`);
    for (const a of novos.slice(0, 20)) console.log(`    · ${resumo(a)}`);
    if (!ok) falhou = true;
  }
  console.log(falhou ? '\nSEGURANÇA REPROVADA — veja .seguranca/ e não faça commit.' : '\nSEGURANÇA OK');
  process.exit(falhou ? 1 : 0);
}

main();
