import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close, request } from '../../test-support/request.js';

const MIN = 60000;
const BASE = Date.UTC(2026, 9, 7, 0, 0);
const at = (min) => new Date(BASE + min * MIN).toISOString();
const sample = (min, tempC = 40) => ({ ts: at(min), host: 'srv', load: [0.1, 0.1, 0.1], tempC, disks: [], io: [] });

async function start(t, { v1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hist-'));
  if (v1) fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(v1));
  const logs = [];
  const app = createApp({
    sshHost: 'meu-host',
    pollInterval: 60000,
    historyFile: path.join(dir, 'history.json'),
    alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'),
    collect: async () => ({ ok: false, error: 'sem runner' }),
    log: (m) => logs.push(m),
  });
  const { server, port } = await listen(app.app);
  t.after(async () => {
    await app.shutdown(); // espera as gravações pendentes antes de apagar a pasta
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ...app, dir, port, logs };
}

test('API: 1ª subida migra o history.json da V1 e serve o histórico migrado', async (t) => {
  const s = await start(t, { v1: Array.from({ length: 20 }, (_, i) => sample(i)) });
  assert.ok(fs.existsSync(path.join(s.dir, 'history.v1-migrado.json')), 'backup criado');
  assert.ok(!fs.existsSync(path.join(s.dir, 'history.json')));
  assert.match(s.logs.join('\n'), /20 amostras da V1 migradas/);
  const r = await request(s.port, { path: '/api/history' });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 20);
  assert.equal(r.json.samples.at(-1).ts, at(19));
});

test('API: history.json da V1 ilegível é registrado e mantido', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hist-'));
  fs.writeFileSync(path.join(dir, 'history.json'), '[{"ts":');
  const logs = [];
  createApp({ historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'a.json'), annotationsFile: path.join(dir, 'n.json'), log: (m) => logs.push(m) });
  assert.match(logs.join('\n'), /histórico da V1 não migrado: JSON inválido/);
  assert.equal(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'), '[{"ts":');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('API: /api/history?formato=baldes devolve baldes com mín/máx/média e preserva picos', async (t) => {
  const s = await start(t);
  for (let i = 0; i < 180; i++) s.store.append(sample(i, i === 95 ? 88 : 40));
  const r = await request(s.port, { path: `/api/history?formato=baldes&from=${at(0)}&to=${at(179)}&limit=36` });
  assert.equal(r.status, 200);
  assert.equal(r.json.step, 5 * MIN);
  assert.equal(r.json.buckets.length, 36);
  assert.equal(r.json.count, 180);
  assert.equal(Math.max(...r.json.buckets.map((b) => b.m.tempC[1])), 88);
  assert.equal(r.json.from, at(0));

  const def = await request(s.port, { path: '/api/history?formato=baldes' });
  assert.equal(def.status, 200, 'sem from/to: últimas 24 h até a amostra mais recente');
  assert.equal(def.json.to, at(179));
  assert.equal(def.json.buckets.reduce((n, b) => n + b.n, 0), 180);
});

test('API: /api/history?formato=baldes recusa intervalo inválido', async (t) => {
  const s = await start(t);
  for (const q of [`from=${at(10)}&to=${at(0)}`, 'from=banana', `from=${at(0)}&to=${at(92 * 24 * 60)}`]) {
    const r = await request(s.port, { path: `/api/history?formato=baldes&${q}` });
    assert.equal(r.status, 400, q);
    assert.match(r.json.error, /intervalo inválido/);
  }
});

test('API: store sem agregação responde 501 em formato=baldes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hist-'));
  const store = { length: 0, limit: 10, getLatest: () => null, getRange: () => [], append() {}, flush: async () => {} };
  const app = createApp({ store, log: () => {}, alertsFile: path.join(dir, 'a.json'), annotationsFile: path.join(dir, 'n.json') });
  const { server, port } = await listen(app.app);
  t.after(async () => { await app.shutdown(); await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  const r = await request(port, { path: '/api/history?formato=baldes' });
  assert.equal(r.status, 501);
});

test('shutdown(): grava o histórico pendente em disco antes de sair (B11)', async (t) => {
  const s = await start(t);
  s.store.append(sample(0));
  s.store.append(sample(1));
  await s.shutdown();
  const file = path.join(s.dir, 'history', `${at(0).slice(0, 10)}.ndjson`);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('API: export CSV usa o histórico novo, com colunas de I/O por dispositivo (B4)', async (t) => {
  const s = await start(t);
  s.store.append({ ...sample(0), io: [{ dev: 'sda', readMBps: 1, writeMBps: 2 }, { dev: 'sdb', readMBps: 3, writeMBps: 4 }] });
  s.store.append({ ...sample(1), io: [{ dev: 'sdb', readMBps: 5, writeMBps: 6 }] });
  const r = await request(s.port, { path: '/api/export?format=csv' });
  assert.equal(r.status, 200);
  const [header, row1, row2] = r.text.split('\n');
  assert.ok(header.endsWith('io_sda_readMBps,io_sda_writeMBps,io_sdb_readMBps,io_sdb_writeMBps'));
  assert.ok(row1.endsWith('1,2,3,4'));
  assert.ok(row2.endsWith(',,5,6'), 'disco ausente na amostra fica vazio, sem deslocar colunas');
});
