#!/usr/bin/env node
// Teste de mutação dos guardas de segurança: "quem testa os testes?".
//
// Cada mutação abaixo é um erro de segurança realista: o que uma limpeza descuidada,
// uma refatoração ou um código novo poderia introduzir (tirar o Host check, escutar em
// 0.0.0.0, aceitar o token na URL…). Numa CÓPIA temporária do repositório, o script aplica
// uma mutação por vez, roda os testes indicados e exige que eles FALHEM. Mutação que
// sobrevive (testes verdes com o guarda quebrado) é um buraco na rede de testes: reprova.
//
// Se o trecho que a mutação procura não existe mais (o código mudou de forma), ela é
// "desatualizada" e também reprova: a lista precisa acompanhar o código, nunca ficar cega.
//
// Uso: node scripts/mutacao-seguranca.mjs   (também roda dentro de `npm run seguranca`)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Testes que formam a rede de segurança (rodam em toda mutação, além dos específicos).
const SEG = ['test/seguranca/invariantes-estaticas.test.js', 'test/seguranca/superficie-ataque.test.js',
  'test/seguranca/payloads-owasp.test.js', 'test/seguranca/cadeia-suprimentos.test.js'];

/**
 * { nome, arquivo, de, para, testes? }: troca o trecho `de` (que precisa aparecer UMA vez)
 * por `para`. `testes` acrescenta arquivos de teste além da rede de segurança.
 */
const MUTACOES = [
  { nome: 'sem Host check (DNS rebinding)', arquivo: 'server/index.js', de: '  app.use(hostCheck);\n', para: '' },
  { nome: 'sem CSRF check', arquivo: 'server/index.js', de: '  app.use(csrfCheck);\n', para: '' },
  { nome: 'API sem exigir login', arquivo: 'server/index.js', de: "  app.use('/api', makeRequireAuth(DASH_TOKEN, sessions));\n", para: '' },
  { nome: 'painel escutando em 0.0.0.0', arquivo: 'server/index.js', de: "app.listen(PORT, '127.0.0.1',", para: "app.listen(PORT, '0.0.0.0'," },
  { nome: 'corpo JSON sem limite de tamanho', arquivo: 'server/index.js', de: 'jsonBody({ limit: 50 * 1024 })', para: 'jsonBody({ limit: 50 * 1024 * 1024 })' },
  { nome: 'login sem limite de tentativas', arquivo: 'server/index.js', de: "app.post('/api/login', loginRateLimit, ", para: "app.post('/api/login', ", testes: ['test/integration/api-sessao.test.js'] },
  { nome: 'token aceito na URL (?token=)', arquivo: 'server/security.js', de: "    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';", para: "    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.query?.token || '');" },
  { nome: 'CSP com unsafe-inline', arquivo: 'server/security.js', de: `"script-src 'self'",`, para: `"script-src 'self' 'unsafe-inline'",` },
  { nome: 'sem X-Content-Type-Options', arquivo: 'server/security.js', de: "  res.setHeader('X-Content-Type-Options', 'nosniff');\n", para: '' },
  { nome: 'comparação de segredo sem tempo constante', arquivo: 'server/http/session.js', de: 'return crypto.timingSafeEqual(ab, bb);', para: 'return ab.toString() === bb.toString();' },
  { nome: 'cookie de sessão sem HttpOnly', arquivo: 'server/http/session.js', de: 'Path=/; HttpOnly; SameSite=Strict`;', para: 'Path=/; SameSite=Strict`;' },
  { nome: 'JSON do corpo sem filtro de __proto__', arquivo: 'server/http/router.js', de: "JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v))", para: 'JSON.parse(text)' },
  {
    nome: 'estáticos sem proteção de path traversal', arquivo: 'server/http/static.js',
    de: "    if (segments.some((seg) => seg.startsWith('.'))) return res.status(404).json({ error: 'não encontrado' });\n    const file = path.resolve(base, ...segments);\n    if (file !== base && !file.startsWith(base + path.sep)) return res.status(404).json({ error: 'não encontrado' });\n",
    para: '    const file = path.resolve(base, ...segments);\n',
  },
  { nome: 'arquivo de dados sem 0600', arquivo: 'server/storage/ndjson.js', de: 'fs.writeFileSync(tmp, data, { mode: 0o600 });', para: 'fs.writeFileSync(tmp, data);' },
  { nome: 'token do .env sem whitelist (injeção no SSH)', arquivo: 'server/config.js', de: ".filter((t) => TOKEN_RE.test(t) && !t.startsWith('-'));", para: '.filter((t) => t.length > 0);' },
  { nome: 'host do SSH aceitando opção (-oProxyCommand)', arquivo: 'server/config.js', de: "if (!v || v.startsWith('-')) return 'seu-host';", para: "if (!v) return 'seu-host';" },
  { nome: 'CSV sem proteção contra fórmula', arquivo: 'server/csv.js', de: "const guarded = /^[=+\\-@\\t\\r]/.test(s) ? `'${s}` : s;", para: 'const guarded = s;', testes: ['test/unit/csv.test.js'] },
  { nome: 'template html sem escape', arquivo: 'public/js/core/html.js', de: '  return escape(value);\n}\n\nexport function html', para: '  return String(value);\n}\n\nexport function html' },
  { nome: 'SSH aceitando identidade nova do servidor', arquivo: 'server/setup/remoto.js', de: "'StrictHostKeyChecking=yes'", para: "'StrictHostKeyChecking=accept-new'" },
  { nome: 'script de coleta com texto a mais (authorized_keys quebrado)', arquivo: 'server/collector/builder.js', de: `"echo '===FIM==='",`, para: `"echo '===FIM==='; true",` },
  { nome: 'exec com shell importado', arquivo: 'server/cli/servico.js', de: "import { spawn, spawnSync } from 'node:child_process';", para: "import { exec, spawn, spawnSync } from 'node:child_process';" },
];

/**
 * Copia para uma pasta temporária o que está (ou vai estar) no git: os arquivos rastreados e
 * os novos ainda não commitados que o .gitignore não exclui. Depois faz dela um repositório
 * git, porque os testes de segurança listam os arquivos com `git ls-files`.
 */
function copiar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-mutacao-'));
  const lista = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\0').filter(Boolean);
  for (const f of lista) {
    const origem = path.join(ROOT, f);
    if (!fs.existsSync(origem)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(origem, path.join(dir, f));
  }
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=mutacao@example.com', '-c', 'user.name=mutacao', 'commit', '-q', '-m', 'base');
  copiados = lista.length;
  return dir;
}

let copiados = 0;

/** Roda a rede de segurança (mais `extras`) na cópia; devolve o resultado do node --test. */
function rodarTestes(dir, extras = []) {
  // Sem NODE_TEST_CONTEXT: se este script rodar dentro de um `node --test`, o filho não
  // pode se achar um subteste (ele precisa devolver o próprio código de saída).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const inicio = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...SEG, ...extras], { cwd: dir, encoding: 'utf8', env });
  const conta = (rotulo) => Number((r.stdout.match(new RegExp(`ℹ ${rotulo} (\\d+)`)) || [])[1] || 0);
  return { status: r.status, testes: conta('tests'), falhas: conta('fail'), segundos: ((Date.now() - inicio) / 1000).toFixed(1), saida: `${r.stdout}${r.stderr}` };
}

function main() {
  const dir = copiar();
  const sobreviventes = [];
  const desatualizadas = [];
  let mortas = 0;
  try {
    // Controle: sem mutação, a rede precisa passar. Senão toda mutação "morreria" por outro
    // motivo (cópia incompleta, teste quebrado) e o resultado não valeria nada.
    const extras = [...new Set(MUTACOES.flatMap((m) => m.testes || []))];
    const controle = rodarTestes(dir, extras);
    if (controle.status !== 0 || controle.testes < 50 || controle.falhas > 0) {
      console.log(`  ✗ controle: ${controle.testes} testes, ${controle.falhas} falhas SEM mutação; nada a medir\n${controle.saida.slice(-2500)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ controle: sem mutação, ${controle.testes} testes passam (${controle.segundos} s, ${copiados} arquivos copiados)`);
    for (const m of MUTACOES) {
      const arquivo = path.join(dir, m.arquivo);
      const original = fs.readFileSync(arquivo, 'utf8');
      const vezes = original.split(m.de).length - 1;
      if (vezes !== 1) {
        desatualizadas.push(`${m.nome}: o trecho aparece ${vezes} vez(es) em ${m.arquivo}`);
        console.log(`  ? ${m.nome} — desatualizada (${vezes}×)`);
        continue;
      }
      fs.writeFileSync(arquivo, original.replace(m.de, m.para));
      const r = rodarTestes(dir, m.testes);
      fs.writeFileSync(arquivo, original);
      // Só conta como acusada se um teste FALHOU de verdade (asserção), não se o processo
      // caiu por outro motivo.
      if (r.falhas > 0) {
        mortas += 1;
        console.log(`  ✓ ${m.nome} — acusada por ${r.falhas} teste(s) (${r.segundos} s)`);
      } else {
        sobreviventes.push(m.nome);
        console.log(`  ✗ ${m.nome} — SOBREVIVEU (${r.testes} testes, nenhuma falha; saída ${r.status})`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ok = sobreviventes.length === 0 && desatualizadas.length === 0;
  for (const d of desatualizadas) console.log(`    · ${d}`);
  console.log(`${mortas}/${MUTACOES.length} mutações acusadas pelos testes${ok ? '' : ` · ${sobreviventes.length} sobreviveram · ${desatualizadas.length} desatualizadas`}`);
  process.exit(ok ? 0 : 1);
}

main();
