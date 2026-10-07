import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close, request } from '../../test-support/request.js';

const T = { diskPct: 90, ramPct: 90, tempC: 60, hysteresis: 5, offlineAfter: 2 };

async function start(t, { results, thresholds = T } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-alert-'));
  const queue = [...results];
  const app = createApp({
    sshHost: 'meu-host',
    pollInterval: 60000,
    historyFile: path.join(dir, 'history.json'),
    alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'),
    thresholds,
    collect: async () => { const next = queue.shift(); return next ? next() : { ok: false, error: 'fim da fila' }; },
    log: () => {},
  });
  const { server, port } = await listen(app.app);
  t.after(async () => { await app.shutdown(); await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...app, dir, port };
}

const ok = (tempC, extra = {}) => () => ({
  ok: true,
  sample: { ts: new Date().toISOString(), host: 'srv', cores: 1, load: [0.1, 0.1, 0.1], ram: { total: 1000, used: 400 }, tempC, disks: [], smart: [], services: {}, ...extra },
  alerts: [],
});
const fail = (error = 'Tempo esgotado') => () => ({ ok: false, error });

test('API: alertas vêm do motor (chave estável + histerese), não da coleta', async (t) => {
  const s = await start(t, { results: [ok(61), ok(58), ok(62), ok(54)] });
  await s.runPoll();
  await s.runPoll();
  await s.runPoll();
  assert.equal(s.alertsStore.data.length, 1, 'um alerta para a oscilação 61 → 58 → 62');
  assert.equal(s.alertsStore.active[0].key, 'temp:cpu');
  assert.equal(s.alertsStore.active[0].message, 'Temperatura CPU 62.0°C');
  await s.runPoll();
  assert.equal(s.alertsStore.active.length, 0, '54 °C está abaixo de 60 − 5');
});

test('API: /api/status traz saúde e limiares da mesma fonte das regras', async (t) => {
  const s = await start(t, { results: [ok(65)], thresholds: { ...T, tempC: 64 } });
  await s.runPoll();
  const r = await request(s.port, { path: '/api/status' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.meta.thresholds, { ...T, tempC: 64 });
  assert.equal(r.json.health.score, 85);
  assert.deepEqual(r.json.health.parts.map((p) => p.label), ['Temp 65.0°C']);
  assert.equal(r.json.meta.failures, 0);
});

test('API: queda registrada em /api/outages com uptime; 1 falha isolada não conta', async (t) => {
  const s = await start(t, { results: [ok(40), fail(), ok(40), fail('A'), fail('B'), fail('C'), ok(40)] });
  await s.runPoll();
  await s.runPoll();
  assert.equal(s.state.online, true, '1 falha não derruba o status (sem piscar)');
  assert.equal(s.state.failures, 1);
  await s.runPoll();
  await s.runPoll();
  await s.runPoll();
  assert.equal(s.state.online, false);
  assert.ok(s.state.offlineSince);
  const during = await request(s.port, { path: '/api/outages' });
  assert.equal(during.json.outages.length, 1);
  assert.equal(during.json.outages[0].ongoing, true);
  assert.equal(during.json.outages[0].reason, 'A');
  const st = await request(s.port, { path: '/api/status' });
  assert.equal(st.json.health.score, 0);
  await s.runPoll();
  await s.runPoll();
  const after = await request(s.port, { path: '/api/outages?days=7' });
  assert.equal(after.json.days, 7);
  assert.equal(after.json.outages.length, 1);
  assert.equal(after.json.outages[0].ongoing, false);
  assert.ok(after.json.uptime.uptimePct < 100);
  assert.equal(s.alertsStore.active.length, 0);
  await s.shutdown();
  const lines = fs.readFileSync(path.join(s.dir, 'outages.ndjson'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => JSON.parse(l).ev), ['off', 'on']);
});

test('API: /api/outages sem dados e com days fora da faixa', async (t) => {
  const s = await start(t, { results: [] });
  const r = await request(s.port, { path: '/api/outages?days=999' });
  assert.equal(r.status, 200);
  assert.equal(r.json.days, 90);
  assert.deepEqual(r.json.outages, []);
  assert.equal(r.json.uptime.uptimePct, null, 'sem dado nenhum não inventa 100%');
  const def = await request(s.port, { path: '/api/outages?days=banana' });
  assert.equal(def.json.days, 30);
});

test('API: exceção na coleta conta como falha do motor', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-alert-'));
  const app = createApp({
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'), annotationsFile: path.join(dir, 'n.json'),
    thresholds: { ...T, offlineAfter: 1 }, collect: async () => { throw new Error('quebrou'); }, log: () => {},
  });
  await app.runPoll();
  assert.equal(app.state.lastError, 'quebrou');
  assert.equal(app.alertsStore.active[0].message, 'Servidor inacessível: quebrou');
  await app.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});
