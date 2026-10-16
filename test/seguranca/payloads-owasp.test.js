// Corpus de ataques conhecidos contra cada ponto que recebe dado de fora.
//
// Os payloads seguem as categorias do OWASP WSTG (Web Security Testing Guide) e do
// PayloadsAllTheThings, escritos aqui à mão (nada é baixado). Cada bloco diz a categoria
// do OWASP Top 10:2025 e o CWE. Entradas atacadas:
//   - caminho da URL (estáticos)               → path traversal (A01, CWE-22)
//   - query e nome do arquivo do export        → header injection (A05, CWE-113)
//   - células do CSV                           → formula injection (A05, CWE-1236)
//   - template html do navegador               → XSS (A05, CWE-79)
//   - variáveis do .env e campos da instalação → injeção de comando/opção (A05, CWE-78/88)
//   - corpo JSON e query                       → prototype pollution (A08, CWE-1321)
//   - tamanho e profundidade do corpo          → negação de serviço (A10, CWE-400/674)
//   - regex sobre entrada                      → ReDoS (A10, CWE-1333)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createApp } from '../../server/index.js';
import { listen, close, request } from '../../test-support/request.js';
import { csvEscape, toCSV } from '../../server/csv.js';
import { escape, html } from '../../public/js/core/html.js';
import { sanitizeToken, sanitizeHost } from '../../server/config.js';
import { parseHost, originAllowed, parseCookies } from '../../server/security.js';
import { normalizeCode } from '../../server/setup/web.js';
import { buildScript } from '../../server/collector/builder.js';
import { parseOutput } from '../../server/collector/parser.js';
import {
  validHost, validUser, validPort, validDevice, validIp, validAbsPath, validPublicKey, quoteCommandOption, sudoersLine,
} from '../../server/setup/acesso.js';

const TOKEN = 'token-de-teste-dos-payloads-0123456789';

async function painel(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-payload-'));
  const app = createApp({
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'), dashToken: TOKEN, log: () => {},
    collect: async () => ({ ok: false, error: 'sem coleta' }), rateLimitMax: 1e6,
  });
  const { server, port } = await listen(app.app);
  t.after(async () => { await app.shutdown(); await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  const home = await request(port, { path: '/' });
  const csrf = [].concat(home.headers['set-cookie'] || []).find((c) => c.startsWith('dash_csrf=')).split(';')[0];
  const auth = { Authorization: `Bearer ${TOKEN}`, Cookie: csrf, Origin: 'http://localhost', 'Content-Type': 'application/json' };
  return { app, port, auth, dir };
}

/** Requisição HTTP crua: o caminho vai byte a byte, sem normalização do cliente. */
function cru(port, linha) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.end(`GET ${linha} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    let data = '';
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => resolve({ status: Number(data.split(' ')[1]), data }));
    sock.on('error', reject);
  });
}

// ---------------------------------------------------------------- A01 · CWE-22

const TRAVESSIA = [
  '/../../../../etc/passwd', '/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd',
  '/%252e%252e/%252e%252e/etc/passwd', '/..%c0%af..%c0%afetc/passwd', '/..%5c..%5cetc%5cpasswd',
  '/....//....//etc/passwd', '/js/../../server/config.js', '/js/%2e%2e/%2e%2e/.env', '/.env',
  '/.git/config', '/%2egit/config', '/data/sessions.json', '/index.html%00.js', '/index.html%2500',
  '/%c0%ae%c0%ae/%c0%ae%c0%ae/etc/passwd', '/js/main.js/..%2f..%2f..%2fpackage.json',
  '/vendor/uplot/../../../AGENTS.md', '/‥/‥/etc/passwd', '/js/%5c..%5c..%5cpackage.json',
];

test('A01/CWE-22: path traversal nos estáticos não lê nada fora de public/', async (t) => {
  const { port } = await painel(t);
  for (const p of TRAVESSIA) {
    // Só o que não é ASCII visível é codificado; os %xx do ataque seguem como estão.
    const r = await cru(port, p.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c)));
    assert.ok([400, 401, 403, 404].includes(r.status), `${p}: ${r.status}`);
    assert.doesNotMatch(r.data, /root:x:0:0|SSH_HOST|DASH_TOKEN|\[core\]|"devDependencies"|import fs|# Server Dashboard/, `${p}: vazou conteúdo`);
  }
});

// ---------------------------------------------------------------- A05 · CWE-113

test('A05/CWE-113: CRLF e aspas na query do export não injetam cabeçalho nem mudam o nome do arquivo', async (t) => {
  const { port, auth } = await painel(t);
  const ataques = ['%0d%0aSet-Cookie:%20x=1', '%0aX-Injetado:%201', '";%20filename=evil.sh', '../../etc/passwd', '%E5%98%8A%E5%98%8DSet-Cookie:x=1'];
  for (const a of ataques) {
    for (const format of ['csv', 'json', `csv${a}`]) {
      const r = await request(port, { path: `/api/export?format=${format}&from=${a}&to=${a}`, headers: auth });
      assert.ok(r.status < 500, `${a}: ${r.status}`);
      assert.equal(r.headers['x-injetado'], undefined, `${a}: cabeçalho injetado`);
      assert.ok(![].concat(r.headers['set-cookie'] || []).some((c) => c.startsWith('x=')), `${a}: cookie injetado`);
      const disp = String(r.headers['content-disposition'] || '');
      if (disp) assert.match(disp, /^attachment; filename="[A-Za-z0-9_.-]+"$/, `${a}: nome do arquivo ${disp}`);
    }
  }
});

// ---------------------------------------------------------------- A05 · CWE-1236

const FORMULAS = ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '=cmd|\'/C calc\'!A0', '=HYPERLINK("http://evil.example")',
  '-2+3+cmd|\' /C calc\'!A0', '@cmd|\'/c notepad\'!_xlbgnm.A1'];

test('A05/CWE-1236: célula que começa com = + - @ vira texto no CSV', () => {
  for (const f of FORMULAS) {
    const cell = csvEscape(f);
    const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
    assert.ok(unquoted.startsWith("'"), `${JSON.stringify(f)} → ${cell}`);
  }
  const csv = toCSV([{ ts: '2026-10-16T00:00:00.000Z', host: '=cmd|\'/C calc\'!A0', os: { kernel: '@SUM(1)' } }]);
  assert.match(csv.split('\n')[1], /,'=cmd/);
  assert.match(csv.split('\n')[1], /,'@SUM/);
});

test('A05/CWE-1236: TAB e CR no início também viram texto, e CR no meio fica entre aspas (OWASP CSV Injection)', () => {
  // O Excel e o LibreOffice pulam TAB (0x09) e CR (0x0D) no começo da célula e leem o resto
  // como fórmula. `host` e `kernel` vêm do servidor monitorado (ameaça 13 do SECURITY).
  for (const f of ['\t=1+1', '\r=1+1', '\t@SUM(A1)', '\r+cmd|\'/C calc\'!A0']) {
    const cell = csvEscape(f);
    const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
    assert.ok(unquoted.startsWith("'"), `${JSON.stringify(f)} → ${JSON.stringify(cell)}`);
  }
  // Um CR no meio quebraria a linha em alguns leitores: a célula vai entre aspas.
  assert.equal(csvEscape('a\rb'), '"a\rb"');
  const csv = toCSV([{ ts: '2026-10-16T00:00:00.000Z', host: '\t=cmd|\'/C calc\'!A0', os: { kernel: 'x\r=1' } }]);
  assert.equal(csv.split('\n').length, 2, 'o CR do kernel não cria linha nova');
  assert.match(csv, /,"?'\t=cmd/);
});

// ---------------------------------------------------------------- A05 · CWE-79

const XSS = [
  '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg/onload=alert(1)>', '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>", '`-alert(1)-`', '<iframe srcdoc="<script>alert(1)</script>">', '<a href="javascript:alert(1)">x</a>',
  '<<SCRIPT>alert(1);//<</SCRIPT>', '<details open ontoggle=alert(1)>', '&lt;script&gt;', '<script>', '<math><mi xlink:href="javascript:alert(1)">',
];

test('A05/CWE-79: o template html escapa todo payload, em texto e em atributo', () => {
  for (const p of XSS) {
    // Em texto, o que o payload vira não pode ter < > (abrir tag); em atributo, também não
    // pode ter aspas nem crase (fechar o atributo).
    assert.equal(String(html`<p>${p}</p>`), `<p>${escape(p)}</p>`);
    assert.doesNotMatch(escape(p), /[<>"'`]/, `${p} → ${escape(p)}`);
    const attr = String(html`<span title="${p}" data-x='${p}'>x</span>`);
    assert.equal((attr.match(/"/g) || []).length, 2, `${p}: aspas extras no atributo`);
    assert.equal((attr.match(/'/g) || []).length, 2, `${p}: apóstrofos extras no atributo`);
  }
});

test('A08: o instante da anotação é gravado em ISO canônico (nunca o texto recebido)', async (t) => {
  const { port, auth } = await painel(t);
  const casos = [
    ['2026-10-16T12:00:00Z', '2026-10-16T12:00:00.000Z'],
    ['2026-10-16T09:00:00-03:00', '2026-10-16T12:00:00.000Z'],
    ['Fri, 16 Oct 2026 12:00:00 GMT', '2026-10-16T12:00:00.000Z'],
  ];
  for (const [enviado, gravado] of casos) {
    const r = await request(port, { method: 'POST', path: '/api/annotations', headers: auth, body: { ts: enviado, text: 'x' } });
    assert.equal(r.json.annotation.ts, gravado, enviado);
  }
  // Texto que não é data vira o instante atual (como antes).
  for (const lixo of ['John Doe AND 1=1 --', '<script>', '9'.repeat(30), { a: 1 }]) {
    const r = await request(port, { method: 'POST', path: '/api/annotations', headers: auth, body: { ts: lixo, text: 'y' } });
    assert.match(r.json.annotation.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, JSON.stringify(lixo));
  }
});

test('A05/CWE-79: anotação com payload volta da API como texto JSON (sem virar HTML)', async (t) => {
  const { port, auth } = await painel(t);
  for (const p of XSS) {
    const r = await request(port, { method: 'POST', path: '/api/annotations', headers: auth, body: { text: p, label: p.slice(0, 20) } });
    assert.ok([200, 201, 400].includes(r.status), `${p}: ${r.status}`);
    assert.match(String(r.headers['content-type']), /^application\/json/);
  }
  const lista = await request(port, { path: '/api/annotations', headers: auth });
  assert.match(String(lista.headers['content-type']), /^application\/json/);
  assert.equal(lista.headers['x-content-type-options'], 'nosniff');
});

// ---------------------------------------------------------------- A05 · CWE-78 / CWE-88

const COMANDOS = [
  '$(reboot)', '`reboot`', 'sda;reboot', 'sda|reboot', 'sda&&reboot', 'sda\nreboot', 'sda\rreboot', "sda'reboot",
  'sda"reboot', '-oProxyCommand=touch /tmp/x', '--help', '../../etc/shadow', 'sda$IFS$9reboot', 'sda>/etc/passwd',
  'sda<x', 'sda\\x', 'sda{a,b}', 'sda*', 'sda?', 'sda#', 'sda!', '%0areboot', '–oProxyCommand=x', 'sda\u0000x',
];

test('A05/CWE-78/88: tokens do .env nunca carregam metacaractere de shell nem viram opção', () => {
  for (const p of COMANDOS) {
    for (const tk of sanitizeToken(`ok1 ${p} ok2`)) {
      assert.match(tk, /^[A-Za-z0-9_./:-]+$/, `${JSON.stringify(p)} → ${tk}`);
      assert.ok(!tk.startsWith('-'), `${JSON.stringify(p)} virou opção: ${tk}`);
    }
  }
  for (const p of COMANDOS) assert.ok(!sanitizeHost(p).startsWith('-'), `host ${JSON.stringify(p)}`);
  assert.equal(sanitizeHost('  -oProxyCommand=x'), 'seu-host');
});

test('A05/CWE-78: o script de coleta só contém os alvos que passaram pelo filtro', () => {
  const ruins = COMANDOS.flatMap((p) => sanitizeToken(p));
  const { script } = buildScript({ netIf: 'eth0', mounts: ['/', ...ruins.filter((x) => x.startsWith('/'))], devs: ['sda'], services: ['smbd'] }, 'smart');
  for (const p of ['$(reboot)', '`reboot`', ';reboot', '|reboot', '&&reboot']) assert.ok(!script.includes(p), p);
});

test('A05/CWE-78/88: validadores da instalação recusam todo payload', () => {
  for (const p of COMANDOS) {
    assert.equal(validHost(p), false, `host ${JSON.stringify(p)}`);
    assert.equal(validUser(p), false, `usuário ${JSON.stringify(p)}`);
    assert.equal(validDevice(p), false, `disco ${JSON.stringify(p)}`);
    assert.equal(validIp(p), false, `ip ${JSON.stringify(p)}`);
    assert.equal(validPublicKey(`ssh-ed25519 ${p}`), false, `chave ${JSON.stringify(p)}`);
    if (!/^\/[A-Za-z0-9/._-]+$/.test(p)) assert.equal(validAbsPath(p), false, `caminho ${JSON.stringify(p)}`);
  }
  for (const p of ['0', '65536', '22;reboot', '-1', '1e3', '0x16', ' 22']) assert.equal(validPort(p), false, `porta ${p}`);
  assert.equal(validAbsPath('/usr/../bin/sh'), false);
  assert.throws(() => quoteCommandOption('coleta\nreboot'));
  assert.throws(() => quoteCommandOption('coleta\\'));
  assert.throws(() => sudoersLine({ devs: ['sda', 'sda;ALL'] }));
});

// ---------------------------------------------------------------- A08 · CWE-1321

test('A08/CWE-1321: __proto__ e constructor no JSON ou na query não poluem objetos', async (t) => {
  const { port, auth } = await painel(t);
  const corpos = [
    '{"__proto__":{"poluido":1},"text":"a"}', '{"constructor":{"prototype":{"poluido":1}},"text":"b"}',
    '{"text":"c","label":{"__proto__":{"poluido":1}}}', '{"text":"d","ts":{"constructor":{"prototype":{"poluido":1}}}}',
  ];
  for (const b of corpos) {
    const r = await request(port, { method: 'POST', path: '/api/annotations', headers: auth, body: b });
    assert.ok(r.status < 500, `${b}: ${r.status}`);
  }
  for (const q of ['__proto__[poluido]=1', 'constructor[prototype][poluido]=1', '__proto__.poluido=1']) {
    const r = await request(port, { path: `/api/alerts?${q}`, headers: auth });
    assert.ok(r.status < 500, `${q}: ${r.status}`);
  }
  assert.equal({}.poluido, undefined, 'Object.prototype poluído');
  assert.equal(Object.prototype.poluido, undefined);
});

// ---------------------------------------------------------------- A10 · CWE-400 / CWE-674

test('A10/CWE-400/674: corpo grande demais é 413; JSON profundo ou quebrado é 400; o painel segue respondendo', async (t) => {
  const { port, auth } = await painel(t);
  const grande = await request(port, { method: 'POST', path: '/api/annotations', headers: auth, body: JSON.stringify({ text: 'x'.repeat(60 * 1024) }) });
  assert.equal(grande.status, 413);
  const profundo = await request(port, { method: 'POST', path: '/api/annotations', headers: auth, body: `${'['.repeat(20000)}${']'.repeat(20000)}` });
  assert.ok(profundo.status >= 400 && profundo.status < 500, `profundo: ${profundo.status}`);
  for (const b of ['{', '{"text":', '\u0000', '{"text":"\ud800"}', 'null', '[]', '"texto"', '1e999']) {
    const r = await request(port, { method: 'POST', path: '/api/annotations', headers: auth, body: b });
    assert.ok(r.status < 500, `${JSON.stringify(b)}: ${r.status}`);
  }
  const vivo = await request(port, { path: '/api/session' });
  assert.equal(vivo.status, 200, 'o painel continua de pé');
});

// ---------------------------------------------------------------- A10 · CWE-1333

/** Executa `fn` e falha se demorar mais que `ms` (backtracking catastrófico). */
function rapido(nome, fn, ms = 250) {
  const t0 = performance.now();
  fn();
  const dt = performance.now() - t0;
  assert.ok(dt < ms, `${nome}: ${dt.toFixed(0)} ms (ReDoS?)`);
}

test('A10/CWE-1333: regex que tocam entrada de fora respondem rápido a texto hostil', () => {
  const longo = 'a'.repeat(100000);
  const ruins = [longo, `${longo}!`, ' '.repeat(100000), `${'-'.repeat(50000)}x`, `${'a:'.repeat(50000)}`, `${'[::'.repeat(30000)}`,
    `${'a.'.repeat(50000)}-`, `${'%'.repeat(50000)}`, `${'=;'.repeat(50000)}`, `ssh-ed25519 ${'A'.repeat(100000)}==!`];
  for (const s of ruins) {
    rapido('parseHost', () => parseHost(s));
    rapido('originAllowed', () => originAllowed({ headers: { origin: `http://${s}`, host: 'localhost' } }));
    rapido('parseCookies', () => parseCookies(s));
    rapido('normalizeCode', () => normalizeCode(s));
    rapido('sanitizeToken', () => sanitizeToken(s));
    for (const v of [validHost, validUser, validPort, validDevice, validIp, validAbsPath, validPublicKey]) rapido(v.name, () => v(s));
    rapido('csvEscape', () => csvEscape(s));
    rapido('escape', () => escape(s));
  }
  // Resposta hostil do servidor (até o limite de 1 MB que o coletor aceita).
  const hostil = ['===VER===', '2 abc', 'smart', '===DF===', `${'/dev/sda '.repeat(80000)}`, '===NET===', `${'eth0: '.repeat(80000)}`,
    '===PS===', `${'root 1 0.0 0.0 1 1 '.repeat(40000)}`, '===FIM==='].join('\n').slice(0, 1024 * 1024);
  rapido('parseOutput', () => parseOutput(hostil, new Date().toISOString()), 2000);
});
