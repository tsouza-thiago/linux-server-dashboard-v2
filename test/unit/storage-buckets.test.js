import test from 'node:test';
import assert from 'node:assert/strict';
import { flatten, aggregate, mergeBuckets, downsample, worstOf, roundValue } from '../../server/storage/buckets.js';

const MIN = 60000;
const at = (min) => new Date(Date.UTC(2026, 9, 7, 12, 0) + min * MIN).toISOString();

function sample(min, over = {}) {
  return {
    ts: at(min), host: 'srv', load: [0.5, 0.4, 0.3], cpu: { pct: 10, iowait: 1, steal: 0 },
    ram: { total: 1000, used: 400, avail: 600, free: 100, swapUsed: 0 }, tempC: 40,
    net: { iface: 'eth0', rxMbps: 1, txMbps: 2 },
    disks: [{ mount: '/', pct: 10, usedBytes: 100, availBytes: 900, size: '1K' }],
    io: [{ dev: 'sda', readMBps: 1, writeMBps: 1, utilPct: 5, latencyMs: 2 }],
    psi: { cpu: { some10: 1 }, memory: { some10: 0 }, io: { some10: 3 } },
    ...over,
  };
}

test('flatten: métricas numéricas da amostra, ausentes ficam de fora (I5)', () => {
  const f = flatten(sample(0));
  assert.deepEqual(f, {
    load1: 0.5, load5: 0.4, load15: 0.3, cpu: 10, cpuIowait: 1, cpuSteal: 0,
    ramUsed: 400, ramAvail: 600, swapUsed: 0, ramPct: 40, tempC: 40, rxMbps: 1, txMbps: 2,
    'disk:/:pct': 10, 'disk:/:avail': 900,
    'io:sda:read': 1, 'io:sda:write': 1, 'io:sda:util': 5, 'io:sda:lat': 2,
    'psi:cpu': 1, 'psi:memory': 0, 'psi:io': 3,
  });
  const empty = flatten({ ts: at(0), cpu: null, net: { rxMbps: null }, ram: { used: 1, total: 0 }, tempC: null });
  assert.deepEqual(empty, { ramUsed: 1 }, 'null e divisão por zero não viram número');
  assert.deepEqual(flatten({ ts: at(0), disks: [null, { pct: 3 }], io: [{}] }), {}, 'disco sem mount e I/O sem dev ignorados');
});

test('aggregate: baldes alinhados com mín/máx/média; buraco não vira balde', () => {
  const list = [sample(0, { tempC: 40 }), sample(1, { tempC: 50 }), sample(4, { tempC: 60 }), sample(12, { tempC: 30 })];
  const b = aggregate(list, 5 * MIN);
  assert.deepEqual(b.map((x) => [x.t, x.n]), [
    [Date.parse(at(0)), 3], [Date.parse(at(10)), 1],
  ], 'balde 05–10 sem amostra não aparece');
  assert.deepEqual(b[0].m.tempC, [40, 60, 50]);
  assert.deepEqual(b[1].m.tempC, [30, 30, 30]);
  assert.deepEqual(aggregate([{ ts: 'lixo' }, null], 5 * MIN), []);
});

test('aggregate: média só entre amostras que têm a métrica', () => {
  const b = aggregate([sample(0, { tempC: 40 }), sample(1, { tempC: null }), sample(2, { tempC: 50 })], 5 * MIN);
  assert.equal(b[0].n, 3);
  assert.deepEqual(b[0].m.tempC, [40, 50, 45]);
});

test('mergeBuckets: junta baldes de 5 min em 1 h, média ponderada pelo nº de amostras', () => {
  const five = aggregate([
    sample(0, { tempC: 40 }), sample(1, { tempC: 40 }), sample(2, { tempC: 40 }),
    sample(5, { tempC: 70 }),
  ], 5 * MIN);
  const hour = mergeBuckets(five, 60 * MIN);
  assert.equal(hour.length, 1);
  assert.equal(hour[0].n, 4);
  assert.deepEqual(hour[0].m.tempC, [40, 70, 47.5]);
  assert.deepEqual(mergeBuckets([{ t: 0, n: 1 }], 60 * MIN), [{ t: 0, n: 1, m: {} }], 'balde sem métricas');
});

test('roundValue: inteiros grandes sem casas, demais com 2 casas', () => {
  assert.equal(roundValue(144876724224.6), 144876724225);
  assert.equal(roundValue(3.14159), 3.14);
  assert.equal(roundValue(0.126), 0.13);
});

test('B8 — downsample preserva picos de cada métrica (pior caso do grupo)', () => {
  const list = Array.from({ length: 1440 }, (_, i) => sample(i));
  list[701] = sample(701, {
    load: [9, 8, 7], tempC: 88, cpu: { pct: 99, iowait: 40 },
    ram: { total: 1000, used: 990, avail: 10, free: 5, swapUsed: 300 },
    net: { iface: 'eth0', rxMbps: 900, txMbps: 800 },
    disks: [{ mount: '/', pct: 97, usedBytes: 970, availBytes: 30, size: '1K' }],
    io: [{ dev: 'sda', readMBps: 150, writeMBps: 120, utilPct: 100, latencyMs: 80 }],
  });
  const out = downsample(list, 720);
  assert.ok(out.length <= 720);
  const peak = out.find((s) => s.tempC === 88);
  assert.ok(peak, 'o pico de temperatura sumiu');
  assert.deepEqual(peak.load, [9, 8, 7]);
  assert.equal(peak.cpu.pct, 99);
  assert.equal(peak.ram.used, 990);
  assert.equal(peak.ram.avail, 10, 'folga usa o mínimo');
  assert.equal(peak.net.rxMbps, 900);
  assert.equal(peak.disks[0].pct, 97);
  assert.equal(peak.disks[0].availBytes, 30);
  assert.equal(peak.io[0].utilPct, 100);
  assert.equal(peak.disks[0].size, '1K', 'campos não numéricos vêm da amostra mais recente');
  assert.deepEqual(peak.bucket, { from: at(700), to: at(701), n: 2 });
});

test('downsample: abaixo do limite devolve a mesma lista; último ponto é a última amostra', () => {
  const small = [sample(0), sample(1)];
  assert.equal(downsample(small, 720), small);
  const list = Array.from({ length: 1000 }, (_, i) => sample(i));
  const out = downsample(list, 100);
  assert.ok(out.length <= 100);
  assert.equal(out.at(-1).ts, list.at(-1).ts);
  assert.equal(out[0].bucket.from, list[0].ts);
});

test('worstOf: dado ausente continua ausente (I5) e grupo de 1 é a própria amostra', () => {
  const a = sample(0, { tempC: null, net: { iface: 'eth0', rxMbps: null, txMbps: null } });
  const b = sample(1, { tempC: null, net: { iface: 'eth0', rxMbps: null, txMbps: null } });
  const w = worstOf([a, b]);
  assert.equal(w.tempC, null);
  assert.equal(w.net.rxMbps, null);
  assert.equal(worstOf([a]), a);
  const v1 = worstOf([{ ts: at(0), host: 'x' }, { ts: at(1), host: 'x' }]);
  assert.equal(v1.host, 'x', 'amostra sem os blocos opcionais não quebra');
  assert.ok(!('tempC' in v1));
});
