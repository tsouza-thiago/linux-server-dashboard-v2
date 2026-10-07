// Caracterização da segurança pela rede (F4, invariante I9): o que um navegador ou um
// atacante vê, sem depender de como o servidor HTTP é implementado. Escrita e verde ANTES
// da troca do Express por node:http; precisa continuar verde depois.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close, request } from '../../test-support/request.js';

async function start(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sec-'));
  const app = createApp({
    sshHost: 'meu-host',
    pollInterval: 60000,
    historyFile: path.join(dir, 'history.json'),
    alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'),
    collect: async () => ({ ok: false, error: 'sem runner' }),
    log: () => {},
    ...extra,
  });
  const { server, port } = await listen(app.app);
  t.after(async () => { await app.shutdown(); await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...app, port };
}

/** Requisição HTTP crua (sem normalizar caminho nem acrescentar Host). */
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.end(text));
    let data = '';
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      resolve({ status: Number(head.split(' ')[1]), head, body: rest.join('\r\n\r\n') });
    });
    sock.on('error', reject);
  });
}

async function csrfCookie(port) {
  const r = await request(port, { path: '/api/status' });
  const c = [].concat(r.headers['set-cookie'] || [])[0] || '';
  return c.split(';')[0];
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

function assertSecurityHeaders(res, where) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[k], v, `${k} em ${where}`);
  // Página de erro pode ter CSP ainda mais restrita (default-src 'none'), nunca mais frouxa.
  assert.match(res.headers['content-security-policy'] || '', /default-src 'none'|default-src 'self'.*frame-ancestors 'none'/, `CSP em ${where}`);
  assert.equal(res.headers['x-powered-by'], undefined, `X-Powered-By em ${where}`);
  assert.doesNotMatch(res.headers['content-security-policy'] || '', /unsafe-inline|unsafe-eval/, `CSP sem inline/eval em ${where}`);
}

test('cabeçalhos de segurança em TODAS as respostas: página, estático, API, 404, 401, 403 e erro', async (t) => {
  const s = await start(t, { dashToken: 'x'.repeat(32) });
  const cases = [
    ['/', 'página'], ['/style.css', 'estático'], ['/js/main.js', 'script'],
    ['/nao-existe', '404'], ['/api/status', '401'],
  ];
  for (const [p, where] of cases) assertSecurityHeaders(await request(s.port, { path: p }), where);
  assertSecurityHeaders(await request(s.port, { path: '/', headers: { Host: 'evil.com' } }), '403 de Host');
  const bad = await request(s.port, {
    method: 'POST', path: '/api/annotations', body: '{nao json',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'x'.repeat(32)}` },
  });
  assert.equal(bad.status, 400);
  assertSecurityHeaders(bad, 'erro 400');
});

test('Host: ausente, externo, IPv6 sem colchete e rebinding são recusados; locais aceitos', async (t) => {
  const s = await start(t);
  const noHost = await raw(s.port, 'GET /api/status HTTP/1.0\r\n\r\n');
  assert.equal(noHost.status, 403, 'sem Host');
  for (const host of ['evil.com', 'evil.com:3000', '192.0.2.10', 'localhost.evil.com', '::1', 'meu-servidor']) {
    const r = await request(s.port, { path: '/api/status', headers: { Host: host } });
    assert.equal(r.status, 403, host);
    assert.ok(!r.text.includes('"meta"'), `${host} não recebe dados`);
  }
  for (const host of ['localhost', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'LOCALHOST']) {
    assert.equal((await request(s.port, { path: '/api/status', headers: { Host: host } })).status, 200, host);
  }
});

test('estáticos: path traversal, arquivo oculto e pasta não vazam nada', async (t) => {
  const s = await start(t);
  const secrets = /DASH_TOKEN|export function|"dependencies"|BEGIN OPENSSH/;
  for (const p of [
    '/../server/config.js', '/%2e%2e/server/config.js', '/%2E%2E%2Fserver%2Fconfig.js', '/js/../../package.json',
    '/..%2f..%2fpackage.json', '/....//server/index.js', '/.env', '/%2eenv', '/js/', '/fonts',
    '/node_modules/express/package.json', '/index.html%00.js',
  ]) {
    const r = await raw(s.port, `GET ${p} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    // Conexão fechada sem resposta (status NaN) também não vaza nada.
    assert.ok(Number.isNaN(r.status) || [301, 400, 403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.doesNotMatch(r.body, secrets, `${p} vazou conteúdo`);
  }
});

test('estáticos: tipos corretos e nosniff', async (t) => {
  const s = await start(t);
  const types = { '/': /text\/html/, '/style.css': /text\/css/, '/js/main.js': /javascript/, '/fonts/inter-400.woff2': /font\/woff2/ };
  for (const [p, re] of Object.entries(types)) {
    const r = await request(s.port, { path: p });
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], re, p);
  }
});

test('rota de API inexistente devolve 404 sem pilha nem nome do framework', async (t) => {
  const s = await start(t);
  for (const p of ['/api/nao-existe', '/api/alerts/x/y/z']) {
    const r = await request(s.port, { path: p });
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.text, /at .*\.js:\d+|Express|node_modules/, p);
  }
});

test('corpo acima de 50 KB é recusado sem pilha e sem processar', async (t) => {
  const s = await start(t);
  const cookie = await csrfCookie(s.port);
  const r = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'http://localhost' },
    body: JSON.stringify({ text: 'x'.repeat(60 * 1024) }),
  });
  assert.equal(r.status, 413);
  assert.doesNotMatch(r.text, /at .*\.js:\d+/);
  assert.equal(s.annotationsStore.data.length, 0);
});

test('CSRF ponta a ponta: same-origin com cookie passa; sem cookie, outra origem ou cross-site não', async (t) => {
  const s = await start(t);
  const cookie = await csrfCookie(s.port);
  const post = (headers) => request(s.port, {
    method: 'POST', path: '/api/annotations', headers: { 'Content-Type': 'application/json', ...headers }, body: { text: 'oi' },
  });
  assert.equal((await post({ Origin: 'http://localhost', Cookie: cookie })).status, 200);
  assert.equal((await post({ Origin: 'http://localhost' })).status, 403, 'sem cookie dash_csrf');
  assert.equal((await post({ Origin: 'http://evil.com', Cookie: cookie })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site', Cookie: cookie })).status, 403);
  assert.equal((await post({ Origin: 'null', Cookie: cookie })).status, 403, 'Origin null (iframe sandbox)');
  assert.equal(s.annotationsStore.data.length, 1);
});

test('token: Bearer certo passa; errado, de outro tamanho ou ausente → 401 sem dados', async (t) => {
  const token = 'a'.repeat(43);
  const s = await start(t, { dashToken: token });
  const get = (auth) => request(s.port, { path: '/api/status', headers: auth ? { Authorization: auth } : {} });
  assert.equal((await get(`Bearer ${token}`)).status, 200);
  for (const auth of [null, `Bearer ${'b'.repeat(43)}`, `Bearer ${token}x`, `Bearer ${token.slice(1)}`, `Basic ${token}`, token]) {
    const r = await get(auth);
    assert.equal(r.status, 401, String(auth).slice(0, 12));
    assert.ok(!r.text.includes('meta'));
  }
  assert.equal((await request(s.port, { path: '/' })).status, 200, 'a página em si não exige token');
});
