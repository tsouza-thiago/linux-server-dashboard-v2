import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close, request, readSSE } from '../../test-support/request.js';

const TOKEN = 't'.repeat(43);

async function start(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sess-'));
  const app = createApp({
    historyFile: path.join(dir, 'history.json'),
    alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'),
    dashToken: TOKEN,
    collect: async () => ({ ok: false, error: 'sem runner' }),
    log: () => {},
    ...extra,
  });
  const { server, port } = await listen(app.app);
  t.after(async () => { await app.shutdown(); await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  // Navegador: abre a página (recebe o cookie CSRF) e manda Origin nos POSTs.
  const page = await request(port, { path: '/' });
  const csrf = [].concat(page.headers['set-cookie'])[0].split(';')[0];
  const post = (p, body, cookie = '') => request(port, {
    method: 'POST', path: p, body: body ?? {},
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Cookie: [csrf, cookie].filter(Boolean).join('; ') },
  });
  return { ...app, dir, port, csrf, post };
}

const sessionFrom = (res) => {
  const c = [].concat(res.headers['set-cookie'] || []).find((x) => x.startsWith('dash_session='));
  return c ? c.split(';')[0] : null;
};

test('login: token certo vira cookie de sessão que dá acesso à API e ao SSE', async (t) => {
  const s = await start(t);
  const before = await request(s.port, { path: '/api/session' });
  assert.deepEqual(before.json, { authRequired: true, authenticated: false, expiresAt: null });
  assert.equal((await request(s.port, { path: '/api/status' })).status, 401);

  const login = await s.post('/api/login', { token: ` ${TOKEN} ` });
  assert.equal(login.status, 200);
  const raw = [].concat(login.headers['set-cookie']).find((x) => x.startsWith('dash_session='));
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Max-Age=2592000/);
  const cookie = sessionFrom(login);

  const st = await request(s.port, { path: '/api/status', headers: { Cookie: cookie } });
  assert.equal(st.status, 200);
  const me = (await request(s.port, { path: '/api/session', headers: { Cookie: cookie } })).json;
  assert.equal(me.authenticated, true);
  const left = Date.parse(me.expiresAt) - Date.now();
  assert.ok(left > 29 * 86400e3 && left <= 30 * 86400e3, `sessão expira em ~30 dias (${left} ms)`);
  const sse = await readSSE(s.port, { headers: { Cookie: cookie }, until: 1 });
  assert.equal(sse.status, 200, 'SSE autenticado pelo cookie, sem token na URL');
});

test('login sem "manter conectado": cookie some ao fechar o navegador (sem Max-Age)', async (t) => {
  const s = await start(t);
  const login = await s.post('/api/login', { token: TOKEN, remember: false });
  assert.equal(login.status, 200);
  const raw = [].concat(login.headers['set-cookie']).find((x) => x.startsWith('dash_session='));
  assert.doesNotMatch(raw, /Max-Age/);
  assert.match(raw, /HttpOnly; SameSite=Strict/);
  const st = await request(s.port, { path: '/api/status', headers: { Cookie: sessionFrom(login) } });
  assert.equal(st.status, 200);
});

test('login: token errado → 401; tentativas limitadas por minuto (força bruta)', async (t) => {
  const s = await start(t, { loginRateMax: 3 });
  for (const body of [{ token: 'errado' }, { token: 123 }, {}]) {
    const r = await s.post('/api/login', body);
    assert.equal(r.status, 401);
    assert.equal(sessionFrom(r), null);
  }
  const blocked = await s.post('/api/login', { token: TOKEN });
  assert.equal(blocked.status, 429, 'mesmo o token certo espera depois de muitas tentativas');
});

test('login exige a proteção CSRF como qualquer mutação', async (t) => {
  const s = await start(t);
  const cross = await request(s.port, {
    method: 'POST', path: '/api/login', body: { token: TOKEN },
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com', Cookie: s.csrf },
  });
  assert.equal(cross.status, 403);
  assert.equal(sessionFrom(cross), null);
});

test('sair encerra esta sessão; encerrar todas derruba as outras também', async (t) => {
  const s = await start(t);
  const a = sessionFrom(await s.post('/api/login', { token: TOKEN }));
  const b = sessionFrom(await s.post('/api/login', { token: TOKEN }));
  const out = await s.post('/api/logout', {}, a);
  assert.equal(out.status, 200);
  assert.match([].concat(out.headers['set-cookie']).join(), /dash_session=; .*Max-Age=0/);
  assert.equal((await request(s.port, { path: '/api/status', headers: { Cookie: a } })).status, 401);
  assert.equal((await request(s.port, { path: '/api/status', headers: { Cookie: b } })).status, 200);

  const c = sessionFrom(await s.post('/api/login', { token: TOKEN }));
  assert.equal((await s.post('/api/logout-all', {})).status, 401, 'encerrar todas exige estar logado');
  const all = await s.post('/api/logout-all', {}, c);
  assert.equal(all.status, 200);
  assert.equal(all.json.revoked, 2);
  for (const ck of [b, c]) assert.equal((await request(s.port, { path: '/api/status', headers: { Cookie: ck } })).status, 401);
  assert.equal((await s.post('/api/logout', {})).status, 200, 'sair sem sessão não é erro');
});

test('sem DASH_TOKEN: tudo aberto e o login é desnecessário', async (t) => {
  const s = await start(t, { dashToken: '' });
  assert.deepEqual((await request(s.port, { path: '/api/session' })).json, { authRequired: false, authenticated: true, expiresAt: null });
  assert.deepEqual((await s.post('/api/login', {})).json, { ok: true, authRequired: false });
  assert.equal((await request(s.port, { path: '/api/status' })).status, 200);
});

test('sessão sobrevive a reiniciar o painel (sessions.json com hash, 0600)', async (t) => {
  const s = await start(t);
  const cookie = sessionFrom(await s.post('/api/login', { token: TOKEN }));
  await s.shutdown();
  const file = path.join(s.dir, 'sessions.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(cookie.split('=')[1]));
  const again = createApp({
    historyFile: path.join(s.dir, 'history.json'), alertsFile: path.join(s.dir, 'alerts.json'),
    annotationsFile: path.join(s.dir, 'annotations.json'), dashToken: TOKEN, log: () => {},
  });
  const { server, port } = await listen(again.app);
  t.after(() => close(server));
  assert.equal((await request(port, { path: '/api/status', headers: { Cookie: cookie } })).status, 200);
});
