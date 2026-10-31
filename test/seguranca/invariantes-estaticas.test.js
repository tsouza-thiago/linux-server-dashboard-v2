// Invariantes de segurança conferidas no código-fonte (análise estática própria, sem
// dependência). Cada regra é uma decisão de "security by design" do projeto (AGENTS.md,
// "Regras de segurança"): se uma limpeza, refatoração ou código novo a violar, a suíte fica
// vermelha antes do commit. Os comentários são ignorados (test-support/fonte.js): citar
// "innerHTML" num comentário não reprova; usar, sim.
//
// Referências: OWASP Top 10:2025 e CWE (o número de cada regra está no nome do teste).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { ROOT } from '../../test-support/rotas.js';
import { semComentarios, arquivosDeCodigo, arquivosRastreados, procurar } from '../../test-support/fonte.js';

// O script de mutação guarda os ataques como TEXTO (é o catálogo do que estas regras
// precisam pegar), por isso fica fora da varredura; o resto do código entra todo.
const CODIGO = arquivosDeCodigo().filter((f) => f !== 'scripts/mutacao-seguranca.mjs');
const SERVIDOR = CODIGO.filter((f) => f.startsWith('server/'));
const FRONTEND = CODIGO.filter((f) => f.startsWith('public/js/'));
const HTML = arquivosRastreados().filter((f) => /^public\/.*\.html$/.test(f));
const ler = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Achados de `re` fora da lista de exceções `{ 'arquivo': 'motivo' }`. */
function proibido(arquivos, re, excecoes = {}) {
  return procurar(arquivos, re).filter((a) => !Object.keys(excecoes).some((f) => a.startsWith(`${f}:`)));
}

// ---------------------------------------------------------------- o próprio leitor

test('fonte: tirar comentários não muda a sintaxe nem o número de linhas de nenhum arquivo', (t) => {
  // Se o leitor confundisse uma regex ou string com comentário, apagaria código: o arquivo
  // limpo deixaria de compilar (node --check) e as regras abaixo ficariam cegas.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-fonte-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const problemas = [];
  for (const f of CODIGO) {
    const original = ler(f);
    const limpo = semComentarios(original);
    if (limpo.split('\n').length !== original.split('\n').length) problemas.push(`${f}: linhas mudaram`);
    const destino = path.join(dir, f.replace(/\//g, '__'));
    fs.writeFileSync(destino, limpo);
    const r = spawnSync(process.execPath, ['--check', destino], { encoding: 'utf8' });
    if (r.status !== 0) problemas.push(`${f}: ${r.stderr.split('\n').slice(0, 3).join(' ')}`);
  }
  assert.ok(CODIGO.length > 50, `só ${CODIGO.length} arquivos de código`);
  assert.deepEqual(problemas, []);
});

test('fonte: comentário que cita padrão perigoso não é achado; código é', () => {
  const amostra = [
    '// nunca use innerHTML aqui',
    "/* eval(x) só no comentário */ const a = 'innerHTML em string';",
    'const re = /\\/\\/ não é comentário/; el.innerHTML = x;',
    'const t = `${a /* c */}` + b; // fim',
  ].join('\n');
  const limpo = semComentarios(amostra);
  assert.equal(limpo.split('\n').length, 4);
  assert.ok(!/nunca use/.test(limpo));
  assert.ok(!/eval\(x\)/.test(limpo));
  assert.ok(/'innerHTML em string'/.test(limpo), 'string fica');
  assert.ok(/el\.innerHTML = x/.test(limpo), 'código depois de regex com // fica');
  assert.ok(!/fim/.test(limpo));
});

// ---------------------------------------------------------------- injeção (A05:2025)

test('CWE-89: não existe banco de dados nem SQL (os dados são arquivos NDJSON/JSON em data/)', () => {
  // Premissa da exceção do ZAP para "SQL Injection" (docs/seguranca/excecoes.json): se um
  // dia entrar SQL, este teste cai e a exceção precisa ser revista.
  const pkg = JSON.parse(ler('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(deps.filter((d) => /sql|sqlite|mysql|pg|mongo|knex|sequelize|prisma|typeorm|redis/i.test(d)), []);
  assert.deepEqual(proibido(CODIGO, /from\s+'node:sqlite'|\b(?:SELECT\s+[\w*,\s]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/g), []);
});

test('CWE-94: sem eval, new Function, vm nem setTimeout com texto', () => {
  assert.deepEqual(proibido(CODIGO, /\beval\s*\(|new\s+Function\s*\(|from\s+'node:vm'|set(?:Timeout|Interval)\s*\(\s*['"`]/g), []);
});

test('CWE-78: child_process só com spawn/spawnSync (argumentos em lista), nunca exec nem shell: true', () => {
  const imports = [];
  for (const f of CODIGO) {
    for (const [, nomes] of semComentarios(ler(f)).matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g)) {
      for (const n of nomes.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!['spawn', 'spawnSync'].includes(n)) imports.push(`${f}: ${n}`);
      }
    }
  }
  assert.deepEqual(imports, [], 'exec/execSync/execFile passam pelo shell ou fogem do padrão');
  assert.deepEqual(proibido(CODIGO, /shell\s*:\s*true|require\(\s*['"](node:)?child_process/g), []);
});

test('CWE-78: shell local (sh -c) só com texto fixo, nunca montado com dado', () => {
  // O único `sh -c` local procura o xdg-open com um comando literal.
  const achados = procurar(SERVIDOR, /\(\s*'(?:ba)?sh'\s*,\s*\[\s*'-c'\s*,\s*([^\]]*)\]/g);
  for (const a of achados) assert.match(a, /'-c', '[^'$`]*'\]/, `sh -c com texto não fixo: ${a}`);
});

test('CWE-78: o SSH sempre com BatchMode e ConnectTimeout; nunca sem conferir a identidade do servidor', async () => {
  const { SSH_OPTS } = await import('../../server/collector/index.js');
  assert.deepEqual(SSH_OPTS, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']);
  assert.deepEqual(proibido(CODIGO, /StrictHostKeyChecking[ =](?:no|accept-new)|UserKnownHostsFile[ =]\/dev\/null/gi), []);
});

test('CWE-1333: new RegExp só com texto escapado ou fixo (sem ReDoS nem injeção de regex)', () => {
  const ESCAPE = /\.replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g, '\\\\\$&'\)/;
  const FIXOS = {
    // `key` vem de uma lista fixa de variáveis do .env escrita no próprio código.
    'server/setup/local.js': /new RegExp\(`\^\\\\s\*\$\{key\}\\\\s\*=`\)/,
    // `label` é uma palavra fixa do relatório do node --test.
    'scripts/check.mjs': /new RegExp\(`ℹ \$\{label\} /,
  };
  const problemas = procurar(CODIGO, /new RegExp\([^;\n]*/g).filter((a) => {
    const [arquivo] = a.split(':');
    return !ESCAPE.test(a) && !(FIXOS[arquivo] && FIXOS[arquivo].test(a)) && !/new RegExp\(`\^\$\{re\}\/\?\$`\)/.test(a);
  });
  assert.deepEqual(problemas, []);
});

test('CWE-1321: o JSON do corpo descarta __proto__, constructor e prototype', () => {
  const fonte = semComentarios(ler('server/http/router.js'));
  assert.match(fonte, /JSON\.parse\(text, \(k, v\) => \(k === '__proto__' \|\| k === 'constructor' \|\| k === 'prototype' \? undefined : v\)\)/);
  assert.match(fonte, /return Object\.setPrototypeOf\(Object\.fromEntries\(vistos\), null\);/, 'query sem protótipo e sem gravação por nome');
  assert.match(fonte, /!CHAVES_PROIBIDAS\.has\(k\)/, 'query recusa __proto__, constructor e prototype');
});

// ---------------------------------------------------------------- XSS e CSP (A05, CWE-79)

test('CWE-79: HTML cru só no template `html` (core/html.js); nada de innerHTML, document.write ou srcdoc fora dele', () => {
  const re = /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(|\.srcdoc\s*=|createContextualFragment/g;
  assert.deepEqual(proibido(FRONTEND, re, { 'public/js/core/html.js': 'único ponto que escreve HTML, depois do escape' }), []);
});

test('CWE-79: sem style="…" no HTML gerado (CSP sem unsafe-inline): medidas vão pelo CSSOM', () => {
  assert.deepEqual(proibido(FRONTEND, /\sstyle\s*=\s*["'\\$]|setAttribute\(\s*['"]style['"]/g), []);
  for (const f of HTML) assert.doesNotMatch(ler(f), /\sstyle\s*=/, `${f}: style inline`);
});

test('CWE-79: páginas sem script inline, sem on*="…" e sem recurso de outra origem', () => {
  for (const f of HTML) {
    const html = ler(f);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i, `${f}: script inline`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f}: manipulador inline`);
    for (const [, url] of html.matchAll(/\s(?:src|href)\s*=\s*"([^"]+)"/g)) {
      assert.ok(!/^(?:https?:)?\/\//i.test(url), `${f}: recurso externo ${url}`);
    }
  }
});

test('CWE-1022: link que abre outra aba sempre com rel="noopener noreferrer"', () => {
  for (const a of procurar([...FRONTEND, ...HTML], /target=["']_blank["'][^>]*/g)) {
    assert.match(a, /rel="noopener noreferrer"/, a);
  }
});

test('CSP: a política não tem unsafe-inline, unsafe-eval nem curinga, e scripts só da própria origem', () => {
  const fonte = semComentarios(ler('server/security.js'));
  assert.doesNotMatch(fonte, /unsafe-|'\*'|\s\*;|data: 'self'.*script/);
  assert.match(fonte, /"script-src 'self'"/);
  assert.match(fonte, /"object-src 'none'"/);
  assert.match(fonte, /"frame-ancestors 'none'"/);
});

// ---------------------------------------------------------------- dados e segredos (A04, A07)

test('CWE-330: nada de Math.random (segredos vêm de crypto.randomBytes)', () => {
  assert.deepEqual(proibido(CODIGO, /Math\.random\s*\(/g), []);
});

test('CWE-208: segredo comparado só com safeEqual (crypto.timingSafeEqual)', () => {
  // Comparar só o TAMANHO (`.length`) não vaza o conteúdo e é o que o safeEqual faz antes.
  const SEGREDO = '(?:token|DASH_TOKEN|bearer|codigo|pendingCode|sessionHash|idHash)';
  const re = new RegExp(`\\b${SEGREDO}\\b(?!\\.length)\\s*[!=]==?\\s*[A-Za-z_]|[A-Za-z_)\\]]\\s*[!=]==?\\s*${SEGREDO}\\b(?!\\.length)`, 'g');
  assert.deepEqual(proibido(SERVIDOR, re), []);
  assert.match(semComentarios(ler('server/http/session.js')), /crypto\.timingSafeEqual\(ab, bb\)/);
});

test('CWE-598: o token nunca é aceito na URL (?token=)', () => {
  assert.deepEqual(proibido([...SERVIDOR, ...FRONTEND], /[?&]token=|query\.token|searchParams\.get\(\s*['"]token['"]\)/g), []);
});

test('CWE-532: o log nunca recebe o ambiente nem o DASH_TOKEN', () => {
  // O NOME 'DASH_TOKEN' entre aspas pode aparecer (ex.: para tirá-lo de uma lista); o VALOR, não.
  assert.deepEqual(proibido(CODIGO, /(?:console\.\w+|\blog|out\.\w+)\([^;\n]*(?:\bprocess\.env\b(?!\.[A-Z_]+)|(?<!['"])\bDASH_TOKEN\b(?!['"]))/g), []);
});

test('CWE-922: o navegador guarda só o tema e a versão do aviso fechado (nada de token ou dado)', () => {
  for (const a of procurar(FRONTEND, /(?:local|session)Storage\.setItem\([^;]*/g)) assert.match(a, /setItem\((?:THEME_KEY|DISPENSADA_KEY),/, a);
});

test('CWE-732: arquivos gravados pelo painel nascem 0600 e pastas 0700', () => {
  // Escritas: o modo 0o600 precisa estar na própria chamada. Exceções: a gravação atômica
  // genérica recebe o modo por parâmetro (padrão 0o600) e o rollup recebe a função atômica.
  const excecoesEscrita = {
    'server/setup/local.js': 'writeAtomic(file, text, mode = 0o600): o .desktop do menu é 0644 de propósito',
    'server/storage/rollup.js': 'writeBucketsSync recebe writeFileAtomicSync (0600) por parâmetro',
  };
  const escritas = proibido(SERVIDOR, /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\([^;]*/g, excecoesEscrita)
    .filter((a) => !/0o600/.test(a));
  assert.deepEqual(escritas, []);
  const abertas = procurar(SERVIDOR, /openSync\([^;]*/g).filter((a) => !/'r'\)/.test(a) && !/0o600/.test(a));
  assert.deepEqual(abertas, []);
  const pastas = proibido(SERVIDOR, /mkdirSync\([^;]*/g, {
    'server/setup/local.js': '~/.local/share/applications e ~/.config/systemd/user: pastas padrão do sistema, fora de data/',
  }).filter((a) => !/0o700/.test(a));
  assert.deepEqual(pastas, []);
});

test('cookies: todo Set-Cookie é HttpOnly e tem SameSite', () => {
  for (const a of procurar(SERVIDOR, /Path=\/;[^`'"]*/g)) {
    assert.match(a, /HttpOnly/, a);
    assert.match(a, /SameSite=(?:Strict|Lax)/, a);
  }
});

// ---------------------------------------------------------------- rede (A01, A02, CWE-918)

test('A02: todo servidor HTTP escuta só em 127.0.0.1', () => {
  const excecoes = {
    'server/http/router.js': 'repasse genérico de .listen(...args); quem chama passa o endereço',
  };
  const semLoopback = proibido(SERVIDOR, /\.listen\([^;]*/g, excecoes).filter((a) => !/'127\.0\.0\.1'|, host,/.test(a));
  assert.deepEqual(semLoopback, []);
  // O único `listen(port, host)` (porta livre) tem 127.0.0.1 como padrão.
  assert.match(semComentarios(ler('server/cli/servico.js')), /export function portFree\(port, host = '127\.0\.0\.1'\)/);
});

test('CWE-200: os clientes HTTP dos testes só falam com 127.0.0.1 (alerta #8 do CodeQL)', () => {
  // Os testes mandam ao painel de teste dados lidos de arquivo (rotas lidas do código, token
  // de teste). Isso só é inofensivo enquanto o destino for esta máquina: o host fica fixo.
  const fonte = semComentarios(ler('test-support/request.js'));
  const pedidos = fonte.match(/http\.request\(\{[^}]*\}/g) || [];
  assert.equal(pedidos.length, 2, 'request() e readSSE()');
  for (const p of pedidos) assert.match(p, /^http\.request\(\{\s*host: '127\.0\.0\.1',\s*port,/);
  assert.doesNotMatch(fonte, /\bhost\s*[:=]\s*(?!'127\.0\.0\.1')[^,\s]/, 'nenhum host vindo de parâmetro');
});

test('CWE-918: o servidor não faz pedido de rede para fora (só ao próprio painel em 127.0.0.1)', () => {
  const fetches = procurar(SERVIDOR, /\bfetch\s*\([^;]*/g).filter((a) => !/fetch\(`http:\/\/127\.0\.0\.1:/.test(a));
  assert.deepEqual(fetches, []);
  assert.deepEqual(proibido(SERVIDOR, /\bhttps?\.(?:get|request)\s*\(/g), []);
  // net.connect: teste de porta local (servico.js) e do SSH do servidor escolhido na instalação.
  assert.deepEqual(proibido(SERVIDOR, /net\.connect\s*\(/g, {
    'server/cli/servico.js': 'espera o painel local subir',
    'server/setup/remoto.js': 'confere se a porta SSH do servidor escolhido responde',
  }), []);
});

test('CWE-829: import() dinâmico só com caminho fixo', () => {
  assert.deepEqual(procurar(CODIGO, /\bimport\(\s*(?!['"])/g).filter((a) => !/@param|import\('\.\.?\//.test(a)), []);
});

test('frontend: nenhuma URL de outra origem no código (só o link do tutorial no GitHub)', () => {
  // Cada achado é "arquivo:linha  <url>"; a URL inteira precisa COMEÇAR no repositório do
  // projeto (âncora ^), senão "https://evil.example/?github.com/…" passaria.
  const urls = procurar(FRONTEND, /https?:\/\/[^'"`\s)]+/g)
    .filter((a) => !/^https:\/\/github\.com\/tsouza-thiago\/linux-server-dashboard-v2\//.test(a.split('  ').pop()));
  assert.deepEqual(urls, []);
});

test('sem debugger esquecido', () => {
  assert.deepEqual(proibido(CODIGO, /\bdebugger\s*;/g), []);
});
