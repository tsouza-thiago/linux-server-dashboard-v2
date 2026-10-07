import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close, request, readSSE } from '../../test-support/request.js';

function setupApp({ collect, token, extra = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-api-'));
  const handles = createApp({
    sshHost: 'meu-host',
    pollInterval: 60000,
    historyFile: path.join(dir, 'history.json'),
    alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'),
    dashToken: token,
    collect: collect || (async () => ({ ok: false, error: 'sem runner', ts: new Date().toISOString() })),
    log: () => {},
    ...extra,
  });
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } };
  return { ...handles, dir, cleanup };
}

async function withServer(t, setup) {
  const app = setup();
  const { server, port } = await listen(app.app);
  t.after(async () => {
    await close(server);
    app.cleanup();
  });
  return { ...app, server, port };
}

async function getCsrfCookie(port) {
  const r = await request(port, { path: '/api/status' });
  const c = Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie'];
  return c ? c.split(';')[0] : '';
}

function sample(ts) {
  return {
    ts,
    host: 'meu-host',
    os: { kernel: '6.1.0', name: 'Debian GNU/Linux 12 (bookworm)' },
    cores: 1,
    uptimeSec: 720,
    bootAt: '2026-08-15T08:48:00.000Z',
    load: [0.1, 0.2, 0.3],
    ram: { total: 2000, used: 900, free: 200, cache: 800, avail: 900, swapTotal: 1024, swapUsed: 0 },
    disks: [{ mount: '/', size: '100G', used: '12G', avail: '83G', pct: 12, sizeBytes: 1e11, usedBytes: 1.2e10, availBytes: 8.8e10 }],
    net: { rxBytes: 100, txBytes: 200, rxMbps: 0.5, txMbps: 0.2 },
    io: [],
    tempC: 29,
    smart: [],
    services: {},
    topProcs: [],
  };
}

// ---- Segurança (Host check, CSRF, headers) ----

test('API: Host não autorizado é bloqueado (403) em rota e API', async (t) => {
  const s = await withServer(t, () => setupApp());
  const r1 = await request(s.port, { path: '/', headers: { Host: 'evil.com' } });
  assert.equal(r1.status, 403);
  const r2 = await request(s.port, { path: '/api/status', headers: { Host: 'evil.com' } });
  assert.equal(r2.status, 403);
  assert.equal(r2.json.error, 'Host não permitido');
});

test('API: POST cross-origin e Sec-Fetch-Site cross-site são bloqueados', async (t) => {
  const s = await withServer(t, () => setupApp());
  const evil = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { Origin: 'https://evil.com', 'Content-Type': 'application/json' },
    body: { text: 'x' },
  });
  assert.equal(evil.status, 403);

  const cross = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    body: { text: 'x' },
  });
  assert.equal(cross.status, 403);

  const csrf = await getCsrfCookie(s.port);
  const same = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', Cookie: csrf },
    body: { text: 'origin ok' },
  });
  assert.equal(same.status, 200);

  const noCookie = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: { text: 'sem cookie' },
  });
  assert.equal(noCookie.status, 403, 'POST same-origin sem cookie CSRF deve ser bloqueado');
});

test('API: headers de segurança presentes e sem X-Powered-By', async (t) => {
  const s = await withServer(t, () => setupApp());
  const r = await request(s.port, { path: '/api/status' });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.ok(r.headers['content-security-policy'].includes("default-src 'self'"));
  assert.equal(r.headers['x-powered-by'], undefined);
});

// ---- DASH_TOKEN ----

test('API: DASH_TOKEN exige autenticação em /api e /api/stream', async (t) => {
  const s = await withServer(t, () => setupApp({ token: 'segredo123' }));
  const noAuth = await request(s.port, { path: '/api/status' });
  assert.equal(noAuth.status, 401);

  const bearer = await request(s.port, { path: '/api/status', headers: { Authorization: 'Bearer segredo123' } });
  assert.equal(bearer.status, 200);

  const query = await request(s.port, { path: '/api/status?token=segredo123' });
  assert.equal(query.status, 200);

  const wrong = await request(s.port, { path: '/api/status', headers: { Authorization: 'Bearer errado' } });
  assert.equal(wrong.status, 401);

  const stream = await readSSE(s.port, { path: '/api/stream?token=segredo123', until: 1 });
  assert.equal(stream.status, 200);

  const staticOk = await request(s.port, { path: '/' });
  assert.equal(staticOk.status, 200, 'rota estática não exige token');
});

// ---- Status / poll ----

test('API: runPoll com sucesso atualiza estado e status', async (t) => {
  const s = await withServer(t, () => setupApp({
    collect: async () => ({ ok: true, sample: sample('2026-08-15T09:00:00.000Z'), alerts: [] }),
  }));
  await s.runPoll();
  assert.equal(s.state.online, true);
  assert.ok(s.state.lastPollAt);
  assert.ok(s.state.nextPollAt);
  assert.equal(s.state.lastError, null);
  assert.equal(s.store.length, 1);

  const r = await request(s.port, { path: '/api/status' });
  assert.equal(r.status, 200);
  assert.equal(r.json.meta.host, 'meu-host');
  assert.equal(r.json.meta.online, true);
  assert.equal(r.json.meta.historySize, 1);
  assert.equal(r.json.sample.host, 'meu-host');
  assert.equal(r.json.sample.tempC, 29);
  assert.deepEqual(r.json.alerts, []);
});

test('API: runPoll com falha vira offline e cria alerta crítico (após 2 falhas seguidas)', async (t) => {
  const s = await withServer(t, () => setupApp({
    collect: async () => ({ ok: false, error: 'SSH falhou (exit 255) — host não encontrado ou chave inválida', ts: new Date().toISOString() }),
  }));
  await s.runPoll();
  assert.equal(s.alertsStore.active.length, 0, '1 falha isolada não alerta (debounce)');
  assert.equal(s.state.failures, 1);
  await s.runPoll();
  assert.equal(s.state.online, false);
  assert.ok(s.state.offlineSince);
  assert.ok(s.state.lastError.includes('255'));
  assert.equal(s.alertsStore.active.length, 1);
  assert.equal(s.alertsStore.active[0].level, 'critical');
  assert.ok(s.alertsStore.active[0].message.startsWith('Servidor inacessível'));
});

test('API: runPoll é idempotente quando já há coleta em andamento', async (t) => {
  let calls = 0;
  const s = await withServer(t, () => setupApp({
    collect: async () => { calls++; return { ok: true, sample: sample('2026-08-15T09:00:00.000Z'), alerts: [] }; },
  }));
  s.state.polling = true;
  await s.runPoll();
  assert.equal(calls, 0, 'não deve coletar enquanto polling');
  assert.equal(s.store.length, 0);
});

test('API: /api/poll responde 200, depois 429 no throttle, e 409 durante coleta', async (t) => {
  let calls = 0;
  const s = await withServer(t, () => setupApp({
    collect: async () => { calls++; return { ok: true, sample: sample('2026-08-15T09:00:00.000Z'), alerts: [] }; },
  }));
  const first = await request(s.port, { method: 'POST', path: '/api/poll' });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);

  const throttle = await request(s.port, { method: 'POST', path: '/api/poll' });
  assert.equal(throttle.status, 429);

  s.state.lastManualPollAt = 0;
  s.state.polling = true;
  const busy = await request(s.port, { method: 'POST', path: '/api/poll' });
  assert.equal(busy.status, 409);
  s.state.polling = false;
});

// ---- History ----

test('API: /api/history respeita limites e downsample', async (t) => {
  const s = await withServer(t, () => setupApp());
  for (let i = 0; i < 1000; i++) {
    s.store.append(sample(`2026-08-15T09:${String(i % 60).padStart(2, '0')}:00.000Z`));
  }
  const def = await request(s.port, { path: '/api/history' });
  assert.equal(def.status, 200);
  assert.ok(def.json.samples.length <= 721, 'downsample para máx 720');
  assert.equal(def.json.count, 1000);

  const small = await request(s.port, { path: '/api/history?limit=100' });
  assert.ok(small.json.samples.length <= 101);

  const clamped = await request(s.port, { path: '/api/history?limit=999999' });
  assert.ok(clamped.json.samples.length <= 2000, 'clamp superior');

  const bad = await request(s.port, { path: '/api/history?limit=banana' });
  assert.ok(bad.json.samples.length <= 721, 'limit inválido usa default');
});

test('API: /api/history filtra por from/to', async (t) => {
  const s = await withServer(t, () => setupApp());
  s.store.append(sample('2026-08-15T09:00:00.000Z'));
  s.store.append(sample('2026-08-15T10:00:00.000Z'));
  s.store.append(sample('2026-08-15T11:00:00.000Z'));
  const r = await request(s.port, { path: '/api/history?from=2026-08-15T10:00:00.000Z&to=2026-08-15T10:59:59.999Z' });
  assert.equal(r.json.samples.length, 1);
  assert.equal(r.json.samples[0].ts, '2026-08-15T10:00:00.000Z');
});

// ---- Alertas ----

test('API: /api/alerts lista e filtra; ack/resolve funcionam; 404 para inexistente', async (t) => {
  const s = await withServer(t, () => setupApp());
  const a = s.alertsStore.add({ level: 'warning', message: 'Disco / em 92%' });
  const c = s.alertsStore.add({ level: 'critical', message: 'SMART /dev/sda: FAILED' });
  s.alertsStore.setStatus(c.id, 'resolved');

  const all = await request(s.port, { path: '/api/alerts' });
  assert.equal(all.status, 200);
  assert.equal(all.json.active.length, 1);
  assert.equal(all.json.all.length, 2);

  const warn = await request(s.port, { path: '/api/alerts?status=new&level=warning' });
  assert.equal(warn.json.all.length, 1);
  assert.equal(warn.json.all[0].message, 'Disco / em 92%');

  const ack = await request(s.port, { method: 'POST', path: `/api/alerts/${a.id}/ack` });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.alert.status, 'ack');

  const resolve = await request(s.port, { method: 'POST', path: `/api/alerts/${a.id}/resolve` });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.json.alert.status, 'resolved');
  assert.ok(resolve.json.alert.resolvedAt);

  const missing = await request(s.port, { method: 'POST', path: '/api/alerts/nao-existe/ack' });
  assert.equal(missing.status, 404);
});

// ---- Anotações ----

test('API: anotações CRUD completo com validação', async (t) => {
  const s = await withServer(t, () => setupApp());
  const empty = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { 'Content-Type': 'application/json' },
    body: { text: '   ' },
  });
  assert.equal(empty.status, 400);

  const created = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { 'Content-Type': 'application/json' },
    body: { ts: '2026-08-15T09:00:00.000Z', text: 'manutenção', label: 'manut' },
  });
  assert.equal(created.status, 200);
  const id = created.json.annotation.id;

  const badTs = await request(s.port, {
    method: 'POST', path: '/api/annotations',
    headers: { 'Content-Type': 'application/json' },
    body: { ts: 'data-invalida', text: 'ts cai para agora' },
  });
  assert.equal(badTs.status, 200);
  assert.ok(badTs.json.annotation.ts);

  const list = await request(s.port, { path: '/api/annotations' });
  assert.equal(list.status, 200);
  assert.equal(list.json.annotations.length, 2);

  const del = await request(s.port, { method: 'DELETE', path: `/api/annotations/${id}` });
  assert.equal(del.status, 200);

  const delAgain = await request(s.port, { method: 'DELETE', path: `/api/annotations/${id}` });
  assert.equal(delAgain.status, 404);
});

// ---- Export ----

test('API: /api/export CSV e JSON com nome de arquivo saneado', async (t) => {
  const s = await withServer(t, () => setupApp());
  s.store.append({ ...sample('2026-08-15T09:00:00.000Z'), host: 'my;host=bad <x>' });
  const csv = await request(s.port, { path: '/api/export?format=csv' });
  assert.equal(csv.status, 200);
  assert.ok(csv.headers['content-type'].includes('text/csv'));
  const csvName = /filename="([^"]+)"/.exec(csv.headers['content-disposition'])?.[1] || '';
  assert.ok(csvName.startsWith('my_host'));
  assert.ok(!/[;=<>]/.test(csvName), 'nome saneado não contém caracteres perigosos');
  assert.ok(csv.text.startsWith('ts,host'));

  const json = await request(s.port, { path: '/api/export?format=json' });
  assert.equal(json.status, 200);
  assert.ok(json.headers['content-type'].includes('application/json'));
  assert.ok(json.headers['content-disposition'].includes('.json'));
  assert.equal(json.json.count, 1);
  assert.equal(json.json.samples[0].host, 'my;host=bad <x>');

  const fmtDefault = await request(s.port, { path: '/api/export' });
  assert.ok(fmtDefault.headers['content-type'].includes('text/csv'));
});

// ---- SSE ----

test('API: /api/stream emite hello e annotations', async (t) => {
  const s = await withServer(t, () => setupApp());
  const res = await readSSE(s.port, { until: 2 });
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/event-stream'));
  assert.ok(res.data.includes('event: hello'));
  assert.ok(res.data.includes('event: annotations'));
  assert.ok(res.data.includes('"online":false'));
});

// ---- Estáticos ----

test('API: serve index.html e vendor', async (t) => {
  const s = await withServer(t, () => setupApp());
  const index = await request(s.port, { path: '/' });
  assert.equal(index.status, 200);
  assert.ok(index.headers['content-type'].includes('text/html'));
  assert.ok(index.text.includes('Linux Server Dashboard'));

  const chart = await request(s.port, { path: '/vendor/chart.js' });
  assert.equal(chart.status, 200);
  assert.ok(chart.text.includes('Chart'));

  const notFound = await request(s.port, { path: '/nao-existe' });
  assert.equal(notFound.status, 404);
});