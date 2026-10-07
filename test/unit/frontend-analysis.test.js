import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from '../../test-support/frontend.js';

const { Dash } = loadFrontend('analysis.js');
const A = Dash.analysis;
const j = (x) => JSON.parse(JSON.stringify(x));

function latest(over = {}) {
  return {
    ts: '2026-08-15T09:00:00.000Z',
    host: 'h',
    cores: 4,
    load: [1, 1, 1],
    ram: { total: 8000, used: 4000 },
    tempC: 40,
    disks: [{ mount: '/', pct: 50 }],
    smart: [{ dev: 'sda', status: 'PASSED' }],
    services: { smbd: 'active' },
    ...over,
  };
}

test('healthScore: servidor saudável dá 100/ok', () => {
  const r = A.healthScore(latest(), []);
  assert.equal(r.score, 100);
  assert.equal(r.level, 'ok');
  assert.deepEqual(j(r.parts), []);
});

test('healthScore: servidor offline zera', () => {
  const r = A.healthScore(latest(), [{ message: 'Servidor inacessível: x' }]);
  assert.equal(r.score, 0);
  assert.equal(r.level, 'bad');
  assert.ok(r.parts.some((p) => p.label.includes('offline')));
});

test('healthScore: sem dados zera', () => {
  const r = A.healthScore(null, []);
  assert.equal(r.score, 0);
  assert.equal(r.level, 'bad');
});

test('healthScore: load alto desconta 10', () => {
  const r = A.healthScore(latest({ cores: 1, load: [5, 1, 1] }), []);
  assert.ok(r.parts.some((p) => p.label.includes('Load') && p.pts === 10 && p.level === 'warn'));
  assert.equal(r.score, 90);
});

test('healthScore: RAM ≥90 desconta 15, ≥75 desconta 5', () => {
  const r1 = A.healthScore(latest({ ram: { total: 100, used: 95 } }), []);
  assert.ok(r1.parts.some((p) => p.label.includes('RAM') && p.pts === 15));
  const r2 = A.healthScore(latest({ ram: { total: 100, used: 80 } }), []);
  assert.ok(r2.parts.some((p) => p.label.includes('RAM') && p.pts === 5));
  const r3 = A.healthScore(latest({ ram: { total: 100, used: 50 } }), []);
  assert.ok(!r3.parts.some((p) => p.label.includes('RAM')));
});

test('healthScore: temperatura ≥70 bad, ≥60 warn', () => {
  const r1 = A.healthScore(latest({ tempC: 75 }), []);
  assert.ok(r1.parts.some((p) => p.label.includes('Temp') && p.pts === 25 && p.level === 'bad'));
  const r2 = A.healthScore(latest({ tempC: 65 }), []);
  assert.ok(r2.parts.some((p) => p.label.includes('Temp') && p.pts === 15 && p.level === 'warn'));
});

test('healthScore: disco ≥90 desconta 15, ≥80 desconta 5', () => {
  const r1 = A.healthScore(latest({ disks: [{ mount: '/', pct: 95 }] }), []);
  assert.ok(r1.parts.some((p) => p.label.includes('Disco') && p.pts === 15));
  const r2 = A.healthScore(latest({ disks: [{ mount: '/', pct: 85 }] }), []);
  assert.ok(r2.parts.some((p) => p.label.includes('Disco') && p.pts === 5));
});

test('healthScore: SMART FAILED e serviço inativo são bad', () => {
  const r = A.healthScore(latest({ smart: [{ dev: 'sda', status: 'FAILED' }], services: { smbd: 'inactive' } }), []);
  assert.ok(r.parts.some((p) => p.label.includes('SMART') && p.pts === 40 && p.level === 'bad'));
  assert.ok(r.parts.some((p) => p.label.includes('Serviço') && p.pts === 25 && p.level === 'bad'));
});

test('healthScore: fronteiras de nível 80 e 50', () => {
  assert.equal(A.healthScore(latest(), []).level, 'ok');
  const rWarn = A.healthScore(latest({ tempC: 65, disks: [{ mount: '/', pct: 95 }] }), []);
  assert.equal(rWarn.score, 100 - 15 - 15);
  assert.equal(rWarn.level, 'warn');
  const rBad = A.healthScore(latest({
    tempC: 75, disks: [{ mount: '/', pct: 95 }],
    smart: [{ dev: 'sda', status: 'FAILED' }], services: { smbd: 'inactive' },
  }), []);
  assert.ok(rBad.score < 50);
  assert.equal(rBad.level, 'bad');
});

function growSamples(n, startGB, stepGB, sizeGB = 100) {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 3600000).toISOString(),
    disks: [{ mount: '/', usedBytes: (startGB + i * stepGB) * 1e9, sizeBytes: sizeGB * 1e9, pct: 50 }],
  }));
}

test('diskEta: menos de 10 amostras não estima', () => {
  assert.deepEqual(j(A.diskEta(growSamples(5, 10, 0.1))), []);
});

test('diskEta: crescimento projeta dias até lotar e ordena', () => {
  const etas = A.diskEta(growSamples(20, 50, 1));
  assert.equal(etas.length, 1);
  const e = etas[0];
  assert.equal(e.mount, '/');
  assert.ok(e.growthPerDayGB > 0);
  assert.ok(e.daysToFull > 0);
  assert.ok(e.samples >= 10);
});

test('diskEta: crescimento zero/negativo não projeta', () => {
  const etas = A.diskEta(growSamples(20, 50, 0));
  assert.equal(etas[0].daysToFull, null);
});

test('diskEta: ignora disco sem bytes', () => {
  const samples = Array.from({ length: 12 }, (_, i) => ({
    ts: String(i),
    disks: [{ mount: '/', pct: 5 }],
  }));
  assert.deepEqual(j(A.diskEta(samples)), []);
});

test('ramPressure: sem dados', () => {
  assert.deepEqual(j(A.ramPressure([])), { avg: null, max: null, trend: 'flat' });
});

test('ramPressure: média, pico e tendência flat', () => {
  const r = A.ramPressure(Array.from({ length: 12 }, () => ({ ram: { total: 100, used: 50 } })));
  assert.equal(r.avg, 50);
  assert.equal(r.max, 50);
  assert.equal(r.trend, 'flat');
});

test('ramPressure: tendência sobe/desce', () => {
  const up = Array.from({ length: 12 }, (_, i) => ({ ram: { total: 100, used: 30 + i * 2 } }));
  assert.equal(A.ramPressure(up).trend, 'up');
  const down = Array.from({ length: 12 }, (_, i) => ({ ram: { total: 100, used: 60 - i * 2 } }));
  assert.equal(A.ramPressure(down).trend, 'down');
});

test('ramPressure: ignora amostras sem ram', () => {
  const r = A.ramPressure([{ ram: null }, { ram: { total: 100, used: 25 } }]);
  assert.equal(r.avg, 25);
});

test('outages: filtra e monta período resolvido e em curso', () => {
  const alerts = [
    { ts: '2026-08-01T00:00:00Z', message: 'Servidor inacessível: x', status: 'resolved', resolvedAt: '2026-08-01T00:10:00Z' },
    { ts: '2026-08-02T00:00:00Z', message: 'Servidor inacessível: y', status: 'new' },
    { ts: '2026-08-03T00:00:00Z', message: 'Disco em 90%', status: 'new' },
  ];
  const o = A.outages(alerts);
  assert.equal(o.length, 2);
  assert.equal(o[0].durationSec, 600);
  assert.equal(o[1].durationSec, null);
  assert.equal(o[1].status, 'new');
});

test('uptimePct: sem outages = 100%', () => {
  const r = A.uptimePct([{ message: 'Disco em 90%' }], 2592000000);
  assert.equal(r.uptimePct, 100);
  assert.equal(r.offlineMs, 0);
});

test('uptimePct: outage total na janela ≈ 50% de uptime', () => {
  const now = Date.now();
  const alerts = [{
    ts: new Date(now - 600000).toISOString(),
    message: 'Servidor inacessível: x',
    resolvedAt: new Date(now - 300000).toISOString(),
  }];
  const r = A.uptimePct(alerts, 600000);
  assert.ok(r.offlineMs > 299000 && r.offlineMs <= 300000, `offlineMs=${r.offlineMs}`);
  assert.ok(Math.abs(r.uptimePct - 50) < 0.1, `uptimePct=${r.uptimePct}`);
});

test('uptimePct: outage parcial fora da janela é cortado', () => {
  const now = Date.now();
  const alerts = [{
    ts: new Date(now - 2000000).toISOString(),
    message: 'Servidor inacessível: x',
    resolvedAt: new Date(now - 500000).toISOString(),
  }];
  const r = A.uptimePct(alerts, 600000);
  assert.ok(r.offlineMs > 99000 && r.offlineMs <= 100000, `offlineMs=${r.offlineMs}`);
  assert.equal(r.uptimePct.toFixed(1), '83.3');
});

test('dailySummary: agrega min/max/avg por dia', () => {
  const samples = [
    { ts: '2026-08-01T10:00:00Z', load: [1, 0, 0], ram: { total: 100, used: 50 }, tempC: 30, net: { rxMbps: 1, txMbps: 0.5 } },
    { ts: '2026-08-01T11:00:00Z', load: [3, 0, 0], ram: { total: 100, used: 70 }, tempC: 40, net: { rxMbps: 2, txMbps: 0.5 } },
    { ts: '2026-08-02T10:00:00Z', load: [2, 0, 0], ram: { total: 100, used: 60 }, tempC: 35, net: { rxMbps: 3, txMbps: 1 } },
  ];
  const days = A.dailySummary(samples);
  assert.equal(days.length, 2);
  assert.equal(days[0].day, '2026-08-01');
  assert.equal(days[0].load1.min, 1);
  assert.equal(days[0].load1.max, 3);
  assert.equal(days[0].load1.avg, 2);
  assert.equal(days[0].ram.avg, 60);
  assert.equal(days[0].temp.max, 40);
  assert.equal(days[0].rx.max, 2);
});

test('dailySummary: campos ausentes viram null', () => {
  const days = A.dailySummary([{ ts: '2026-08-01T10:00:00Z', load: [1, 0, 0] }]);
  assert.equal(days[0].ram, null);
  assert.equal(days[0].temp, null);
  assert.equal(days[0].rx, null);
});