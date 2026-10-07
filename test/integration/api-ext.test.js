import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close, request } from '../../test-support/request.js';

function setupApp({ collect, token, rateLimitMax } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-api-ext-'));
  const handles = createApp({
    sshHost: 'meu-host',
    pollInterval: 60000,
    historyFile: path.join(dir, 'history.json'),
    alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'),
    dashToken: token,
    rateLimitMax,
    collect: collect || (async () => ({ ok: false, error: 'sem runner', ts: new Date().toISOString() })),
    log: () => {},
  });
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } };
  return { ...handles, cleanup };
}

async function withServer(t, setup) {
  const app = setup();
  const { server, port } = await listen(app.app);
  t.after(async () => {
    await app.shutdown(); // espera as gravações pendentes antes de apagar a pasta
    await close(server);
    app.cleanup();
  });
  return { ...app, server, port };
}

test('API: cookie CSRF emitido no GET (SameSite=Lax, HttpOnly) e não reemitido', async (t) => {
  const s = await withServer(t, () => setupApp());
  const first = await request(s.port, { path: '/api/status' });
  const sc = Array.isArray(first.headers['set-cookie']) ? first.headers['set-cookie'][0] : first.headers['set-cookie'];
  assert.ok(sc, 'Set-Cookie presente no primeiro GET');
  assert.ok(sc.includes('dash_csrf='));
  assert.ok(sc.includes('SameSite=Lax'));
  assert.ok(sc.includes('HttpOnly'));
  assert.ok(sc.includes('Path=/'));
  const cookie = sc.split(';')[0];

  const second = await request(s.port, { path: '/api/status', headers: { Cookie: cookie } });
  assert.ok(!second.headers['set-cookie'], 'não re-emite cookie quando já presente');
});

test('API: rate limit retorna 429 após o máximo de mutações', async (t) => {
  const s = await withServer(t, () => setupApp({ rateLimitMax: 3 }));
  for (let i = 0; i < 3; i++) {
    const r = await request(s.port, {
      method: 'POST', path: '/api/annotations',
      headers: { 'Content-Type': 'application/json' },
      body: { text: `a${i}` },
    });
    assert.equal(r.status, 200);
  }
  const blocked = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { 'Content-Type': 'application/json' },
    body: { text: 'ultrapassou' },
  });
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error, /muitas requisições/);
});

test('API: GETs não são limitados pelo rate limit', async (t) => {
  const s = await withServer(t, () => setupApp({ rateLimitMax: 2 }));
  for (let i = 0; i < 6; i++) {
    const r = await request(s.port, { path: '/api/status' });
    assert.equal(r.status, 200);
  }
});

test('API: error handler devolve JSON sem stack trace (malformed JSON → 400)', async (t) => {
  const s = await withServer(t, () => setupApp());
  const r = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { 'Content-Type': 'application/json' },
    body: '{corpo invalido',
  });
  assert.equal(r.status, 400);
  assert.ok(r.json && r.json.error, 'resposta é JSON com campo error');
  assert.ok(!r.text.includes('SyntaxError'), 'não vaza stack trace');
  assert.ok(!r.text.includes('at '), 'não vaza frame de pilha');
});

test('API: outage prolongado gera apenas UM alerta ativo (chave estável)', async (t) => {
  let erro = 'erro do primeiro poll';
  const s = await withServer(t, () => setupApp({
    collect: async () => ({ ok: false, error: erro, ts: new Date().toISOString() }),
  }));
  await s.runPoll();
  erro = 'erro completamente diferente';
  await s.runPoll();
  assert.equal(s.alertsStore.active.length, 1, 'mensagens variadas não duplicam o alerta offline');
  assert.equal(s.alertsStore.active[0].level, 'critical');
  assert.ok(s.alertsStore.active[0].message.startsWith('Servidor inacessível'));

  const okPoll = await withServer(t, () => setupApp({
    collect: async () => ({ ok: true, sample: {
      ts: new Date().toISOString(), host: 'meu-host', os: { kernel: 'x', name: 'y' },
      cores: 1, uptimeSec: 1, bootAt: new Date().toISOString(), load: [0, 0, 0],
      ram: null, disks: [], net: {}, io: [], tempC: null, smart: [], services: {}, topProcs: [],
    }, alerts: [] }),
  }));
  await okPoll.runPoll();
  assert.equal(okPoll.alertsStore.active.length, 0, 'recuperação auto-resolve o alerta offline');
});