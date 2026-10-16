// Matriz de ataque gerada das rotas reais (OWASP A01:2025 Broken Access Control, A02
// Security Misconfiguration, CWE-352 CSRF, CWE-350 DNS rebinding, CWE-209 erro que vaza).
//
// As rotas são lidas do código (test-support/rotas.js): uma rota nova entra sozinha aqui,
// e uma limpeza que tire um middleware de segurança deixa a matriz vermelha. Para cada
// rota × método, como um atacante faria pela rede:
//   - Host de outro nome (DNS rebinding)            → 403
//   - sem sessão nem Bearer (painel com DASH_TOKEN) → 401 (só as rotas públicas passam)
//   - mutação vinda de outra origem ou sem o cookie CSRF → 403
//   - cabeçalhos de segurança em TODA resposta, inclusive nos erros
//   - erro sem stack trace, caminho interno ou nome de framework
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { createWizardApp } from '../../server/setup/web.js';
import { listen, close, request } from '../../test-support/request.js';
import { makeInstalacao } from '../../test-support/instalacao-fake.js';
import { rotasDoPainel, rotasDoAssistente, caminhoConcreto, ROOT } from '../../test-support/rotas.js';
import { semComentarios } from '../../test-support/fonte.js';

const TOKEN = 'token-de-teste-da-matriz-0123456789';
const MUTACOES = ['POST', 'PUT', 'PATCH', 'DELETE'];
// Rotas do painel que respondem sem login (a tela de login precisa delas).
const PUBLICAS = new Set(['GET /api/session', 'POST /api/login', 'POST /api/logout', 'GET /entrar']);

const CABECALHOS = {
  'content-security-policy': /default-src 'self'/,
  'x-content-type-options': /^nosniff$/,
  'x-frame-options': /^DENY$/,
  'referrer-policy': /^no-referrer$/,
  'cross-origin-opener-policy': /^same-origin$/,
  'cross-origin-resource-policy': /^same-origin$/,
  'cross-origin-embedder-policy': /^require-corp$/,
  'permissions-policy': /camera=\(\)/,
};

/**
 * Confere os cabeçalhos de segurança e que o corpo não vaza detalhe interno. Respostas da
 * API, do link de entrada e do assistente nunca vão para o cache do navegador (OWASP ASVS
 * V8: sessão, telemetria e o token do fim da instalação não ficam gravados em disco).
 */
function confereResposta(r, onde, caminho = '') {
  for (const [nome, re] of Object.entries(CABECALHOS)) {
    assert.match(String(r.headers[nome] ?? ''), re, `${onde}: cabeçalho ${nome}`);
  }
  if (/^\/(?:api|entrar)(?:\/|$|\?)/.test(caminho) && !/text\/event-stream/.test(String(r.headers['content-type']))) {
    assert.match(String(r.headers['cache-control'] ?? ''), /\bno-store\b/, `${onde}: Cache-Control no-store`);
  }
  assert.doesNotMatch(r.text, /\n\s+at\s|node:internal|\/home\/|[A-Za-z]:\\|Express|x-powered-by/i, `${onde}: corpo vaza detalhe interno`);
  assert.equal(r.headers['x-powered-by'], undefined, `${onde}: x-powered-by`);
  assert.ok(!String(r.headers.server || '').length, `${onde}: cabeçalho Server`);
}

async function painel(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-matriz-'));
  const app = createApp({
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'), dashToken: TOKEN, log: () => {},
    collect: async () => ({ ok: false, error: 'sem coleta na matriz' }),
  });
  const { server, port } = await listen(app.app);
  t.after(async () => { await app.shutdown(); await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  // Um GET comum entrega o cookie CSRF que um navegador legítimo teria.
  const home = await request(port, { path: '/' });
  const csrf = [].concat(home.headers['set-cookie'] || []).find((c) => c.startsWith('dash_csrf=')).split(';')[0];
  return { port, csrf };
}

async function assistente(t) {
  const fake = makeInstalacao();
  const app = createWizardApp({ inst: fake.inst, code: 'MTZ234' });
  const { server, port } = await listen(app);
  t.after(async () => { await close(server); fake.cleanup(); });
  const home = await request(port, { path: '/configurar' });
  const csrf = [].concat(home.headers['set-cookie'] || []).find((c) => c.startsWith('dash_csrf=')).split(';')[0];
  return { port, csrf };
}

const corpo = (metodo) => (MUTACOES.includes(metodo) ? { body: {}, ct: { 'Content-Type': 'application/json' } } : { ct: {} });

test('matriz: as rotas foram lidas do código (painel e assistente)', () => {
  const p = rotasDoPainel();
  const a = rotasDoAssistente();
  assert.ok(p.length >= 18, `painel: ${p.length} rotas`);
  assert.ok(a.length >= 10, `assistente: ${a.length} rotas`);
  assert.ok(p.some((r) => r.metodo === 'DELETE'), 'painel tem DELETE');
});

test('matriz (painel): Host de outro nome recebe 403 em toda rota, com os cabeçalhos', async (t) => {
  const { port } = await painel(t);
  for (const { metodo, caminho } of rotasDoPainel()) {
    const { body, ct } = corpo(metodo);
    for (const host of ['evil.example', 'localhost.evil.example', '127.0.0.1.nip.io', '192.0.2.10', '[::2]']) {
      const r = await request(port, { method: metodo, path: caminhoConcreto(caminho), headers: { Host: host, ...ct }, body });
      assert.equal(r.status, 403, `${metodo} ${caminho} com Host ${host}`);
      confereResposta(r, `${metodo} ${caminho} Host ${host}`, caminho);
    }
  }
});

test('matriz (painel): sem sessão nem Bearer, só as rotas públicas respondem; o resto é 401', async (t) => {
  const { port, csrf } = await painel(t);
  for (const { metodo, caminho } of rotasDoPainel()) {
    const { body, ct } = corpo(metodo);
    const r = await request(port, { method: metodo, path: caminhoConcreto(caminho), headers: { Cookie: csrf, ...ct }, body });
    const chave = `${metodo} ${caminho}`;
    // As públicas podem responder 401 por conta própria (login com token errado); as
    // privadas precisam responder 401 de qualquer jeito.
    if (!PUBLICAS.has(chave)) assert.equal(r.status, 401, `${chave} sem login`);
    confereResposta(r, chave, caminho);
  }
});

test('matriz (painel): Bearer errado, sessão inventada e token na URL não entram', async (t) => {
  const { port, csrf } = await painel(t);
  const privadas = rotasDoPainel().filter((r) => !PUBLICAS.has(`${r.metodo} ${r.caminho}`));
  const tentativas = [
    { Authorization: `Bearer ${TOKEN}x` },
    { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
    { Authorization: `bearer ${TOKEN}` },
    { Authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}` },
    { Cookie: `${csrf}; dash_session=${'a'.repeat(43)}` },
  ];
  for (const { metodo, caminho } of privadas) {
    const { body, ct } = corpo(metodo);
    for (const h of tentativas) {
      const r = await request(port, { method: metodo, path: caminhoConcreto(caminho), headers: { Cookie: csrf, ...h, ...ct }, body });
      assert.equal(r.status, 401, `${metodo} ${caminho} com ${Object.values(h)[0].slice(0, 20)}…`);
    }
    const r = await request(port, { method: metodo, path: `${caminhoConcreto(caminho)}?token=${TOKEN}`, headers: { Cookie: csrf, ...ct }, body });
    assert.equal(r.status, 401, `${metodo} ${caminho}?token= não vale (ADR 0007)`);
  }
});

test('matriz (painel): mutação de outra origem, cross-site ou sem cookie CSRF recebe 403', async (t) => {
  const { port, csrf } = await painel(t);
  const auth = { Authorization: `Bearer ${TOKEN}` };
  for (const { metodo, caminho } of rotasDoPainel().filter((r) => MUTACOES.includes(r.metodo))) {
    const base = { method: metodo, path: caminhoConcreto(caminho), body: {} };
    const casos = [
      { Origin: 'http://evil.example', Cookie: csrf },
      { Origin: 'null', Cookie: csrf },
      { Origin: 'http://localhost.evil.example', Cookie: csrf },
      { 'Sec-Fetch-Site': 'cross-site', Cookie: csrf },
      { Origin: 'http://localhost' }, // mesma origem, mas sem o cookie CSRF
    ];
    for (const h of casos) {
      const r = await request(port, { ...base, headers: { 'Content-Type': 'application/json', ...auth, ...h } });
      assert.equal(r.status, 403, `${metodo} ${caminho} com ${JSON.stringify(h)}`);
      confereResposta(r, `${metodo} ${caminho} CSRF`, caminho);
    }
  }
});

test('matriz (painel): autenticado, nenhuma rota responde 5xx nem vaza detalhe interno', async (t) => {
  const { port, csrf } = await painel(t);
  for (const { metodo, caminho } of rotasDoPainel()) {
    if (caminho === '/api/stream') continue; // SSE fica aberto; coberto por test/integration/api-sse.test.js
    const { body, ct } = corpo(metodo);
    const r = await request(port, {
      method: metodo, path: caminhoConcreto(caminho), body,
      headers: { Cookie: csrf, Origin: 'http://localhost', Authorization: `Bearer ${TOKEN}`, ...ct },
    });
    assert.ok(r.status < 500, `${metodo} ${caminho}: ${r.status}`);
    confereResposta(r, `${metodo} ${caminho} autenticado`, caminho);
  }
});

test('matriz (painel): método ou caminho que não existe é 404 limpo, nunca 500', async (t) => {
  const { port, csrf } = await painel(t);
  const auth = { Authorization: `Bearer ${TOKEN}`, Cookie: csrf, Origin: 'http://localhost', 'Content-Type': 'application/json' };
  for (const { caminho } of rotasDoPainel()) {
    for (const metodo of ['PUT', 'PATCH']) {
      const r = await request(port, { method: metodo, path: caminhoConcreto(caminho), headers: auth, body: {} });
      assert.ok([401, 404].includes(r.status), `${metodo} ${caminho}: ${r.status}`);
      confereResposta(r, `${metodo} ${caminho}`, caminho);
    }
  }
  for (const p of ['/api/nada', '/api/../../etc/passwd', '/.env', '/data/sessions.json', '/server/index.js', '/.git/config']) {
    const r = await request(port, { path: p, headers: auth });
    assert.ok([401, 404].includes(r.status), `${p}: ${r.status}`);
    assert.doesNotMatch(r.text, /SSH_HOST|DASH_TOKEN|\[core\]|import /, `${p} vazou conteúdo`);
  }
});

test('matriz (assistente): Host estranho é 403, sem o código é 401 e outra origem é 403', async (t) => {
  const { port, csrf } = await assistente(t);
  for (const { metodo, caminho } of rotasDoAssistente()) {
    const { body, ct } = corpo(metodo);
    const p = caminhoConcreto(caminho);
    const host = await request(port, { method: metodo, path: p, headers: { Host: 'evil.example', ...ct }, body });
    assert.equal(host.status, 403, `${metodo} ${caminho} Host`);
    confereResposta(host, `assistente ${metodo} ${caminho} Host`, caminho);
    if (caminho.startsWith('/api/configurar/') && caminho !== '/api/configurar/entrar') {
      const semCodigo = await request(port, { method: metodo, path: p, headers: { Cookie: csrf, Origin: 'http://localhost', ...ct }, body });
      assert.equal(semCodigo.status, 401, `${metodo} ${caminho} sem o código`);
      confereResposta(semCodigo, `assistente ${metodo} ${caminho}`, caminho);
    }
    if (MUTACOES.includes(metodo)) {
      const cross = await request(port, { method: metodo, path: p, headers: { Cookie: csrf, Origin: 'http://evil.example', ...ct }, body });
      assert.equal(cross.status, 403, `${metodo} ${caminho} outra origem`);
    }
  }
});

test('ordem dos middlewares: cabeçalhos → Host → CSRF → cookie CSRF → corpo JSON (painel e assistente)', () => {
  const ordem = (arquivo) => [...semComentarios(fs.readFileSync(path.join(ROOT, arquivo), 'utf8'))
    .matchAll(/app\.use\((securityHeaders|hostCheck|csrfCheck|issueCsrfCookie|jsonBody)\b/g)].map((m) => m[1]);
  const esperado = ['securityHeaders', 'hostCheck', 'csrfCheck', 'issueCsrfCookie', 'jsonBody'];
  assert.deepEqual(ordem('server/index.js'), esperado);
  assert.deepEqual(ordem('server/setup/web.js'), esperado);
  // A exigência de login vem depois das rotas públicas e antes de qualquer rota privada.
  const fonte = semComentarios(fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8'));
  const auth = fonte.indexOf("app.use('/api', makeRequireAuth(");
  assert.ok(auth > 0, 'makeRequireAuth registrado em /api');
  for (const { metodo, caminho } of rotasDoPainel()) {
    const pos = fonte.indexOf(`app.${metodo.toLowerCase()}('${caminho}'`);
    if (PUBLICAS.has(`${metodo} ${caminho}`)) assert.ok(pos < auth, `${caminho} pública fica antes do login`);
    else if (caminho.startsWith('/api')) assert.ok(pos > auth, `${metodo} ${caminho} privada fica depois do login`);
  }
});
