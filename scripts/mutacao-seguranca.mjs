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

// Roda só no controle (#104): abre 1 `node --check` por arquivo e gasta ~2/3 de cada rodada.
// Ele confere o semComentarios contra o código de todo o repositório, sem olhar guarda nenhum.
// Se uma mutação depender dele um dia, ela sobrevive e reprova: o buraco não fica escondido.
const SO_NO_CONTROLE = '^fonte: tirar comentários não muda a sintaxe';

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
  { nome: 'sem Cross-Origin-Embedder-Policy', arquivo: 'server/security.js', de: "  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');\n", para: '' },
  { nome: 'API indo para o cache do navegador', arquivo: 'server/security.js', de: "res.setHeader('Cache-Control', 'no-store');", para: "res.setHeader('Cache-Control', 'public, max-age=3600');" },
  { nome: 'comparação de segredo sem tempo constante', arquivo: 'server/http/session.js', de: 'return crypto.timingSafeEqual(ab, bb);', para: 'return ab.toString() === bb.toString();' },
  { nome: 'cookie de sessão sem HttpOnly', arquivo: 'server/http/session.js', de: 'Path=/; HttpOnly; SameSite=Strict`;', para: 'Path=/; SameSite=Strict`;' },
  { nome: 'JSON do corpo sem filtro de __proto__', arquivo: 'server/http/router.js', de: "JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v))", para: 'JSON.parse(text)' },
  { nome: 'query aceitando __proto__/constructor', arquivo: 'server/http/router.js', de: 'if (!CHAVES_PROIBIDAS.has(k) && !vistos.has(k))', para: 'if (!vistos.has(k))' },
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
  { nome: 'authorized_keys regravado inteiro (apaga os outros computadores)', arquivo: 'server/setup/preparo.js', de: "        ...keepOthers(publicKey, id),\n", para: "        'rm -f authorized_keys.novo',\n", testes: ['test/unit/preparo-varios-computadores.test.js'] },
  { nome: 'nome do computador sem saneamento (injeção no sudoers)', arquivo: 'server/setup/acesso.js', de: ".toLowerCase().replace(/[^a-z0-9]+/g, '-')", para: '.toLowerCase()', testes: ['test/unit/preparo-varios-computadores.test.js'] },
  { nome: 'admin oferecendo todas as chaves do agente (MaxAuthTries, fail2ban)', arquivo: 'server/setup/remoto.js', de: "['-i', identityFile, '-o', 'IdentitiesOnly=yes', ", para: "['-i', identityFile, ", testes: ['test/unit/setup-chave-ssh.test.js'] },
  { nome: 'apelido com ProxyJump/ProxyCommand aceito', arquivo: 'server/setup/remoto.js', de: "    if (v && v !== 'none') {\n", para: "    if (false) {\n", testes: ['test/unit/setup-chave-ssh.test.js'] },
  { nome: 'apelido virando opção do ssh (-oProxyCommand)', arquivo: 'server/setup/remoto.js', de: "/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(s)", para: "s.length > 0", testes: ['test/unit/setup-chave-ssh.test.js'] },
  { nome: 'senha do sudo indo para a conexão SSH no modo chave', arquivo: 'server/setup/instalacao.js', de: "    if (this.acesso.modo === 'chave') senha = '';\n", para: '', testes: ['test/unit/setup-chave-ssh.test.js'] },
  { nome: 'aviso de versão sem conferir a assinatura da tag', arquivo: 'server/setup/assinatura.js', de: 'if (verifyTag(root, t, { signersFile, run }).ok) return t;', para: 'return t;', testes: ['test/integration/atualizacao.test.js'] },
  { nome: 'botão Atualizar aceitando a versão da tela', arquivo: 'server/atualizacao/index.js', de: "if (!nova || versao !== nova) return", para: "if (!nova) return", testes: ['test/integration/atualizacao.test.js'] },
  { nome: 'botão Atualizar sem sessão', arquivo: 'server/atualizacao/index.js', de: "if (!this.loginExigido) return 'sem-login';\n", para: '', testes: ['test/integration/atualizacao.test.js'] },
  { nome: 'rotas de atualização fora da sessão', arquivo: 'server/security.js', de: "    if (!token) return next();\n", para: "    if (!token || req.path.startsWith('/api/atualizacao')) return next();\n", testes: ['test/integration/atualizacao.test.js'] },
  { nome: '2 atualizações ao mesmo tempo', arquivo: 'server/atualizacao/registro.js', de: "    if (donoDaTrava(root, procDir)) return false;\n", para: '', testes: ['test/unit/atualizacao-registro.test.js', 'test/integration/cli-manutencao.test.js'] },
  { nome: 'pasta .atualizacao sem 0700', arquivo: 'server/atualizacao/registro.js', de: "  fs.chmodSync(dir, 0o700);\n", para: '', testes: ['test/unit/atualizacao-registro.test.js'] },
  { nome: 'executor filho do painel (morre no stopPanel)', arquivo: 'server/atualizacao/executor.js', de: "{ cwd: root, detached: true, stdio: 'ignore' }", para: "{ cwd: root, stdio: 'ignore' }", testes: ['test/unit/atualizacao-registro.test.js'] },
  { nome: '"procurar agora" sem limite de 1 por minuto', arquivo: 'server/atualizacao/index.js', de: 'if (this.agora() - this.manualEm < MANUAL_MS) return null;\n', para: '', testes: ['test/integration/atualizacao.test.js'] },
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
function rodarTestes(dir, extras = [], pular = []) {
  // Sem NODE_TEST_CONTEXT: se este script rodar dentro de um `node --test`, o filho não
  // pode se achar um subteste (ele precisa devolver o próprio código de saída).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const inicio = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...pular, ...SEG, ...extras], { cwd: dir, encoding: 'utf8', env });
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
      const r = rodarTestes(dir, m.testes, [`--test-skip-pattern=${SO_NO_CONTROLE}`]);
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
