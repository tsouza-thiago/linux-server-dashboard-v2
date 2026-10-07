import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRates, computeCpu, computeNet, computeIo } from '../../server/collector/rates.js';

const T0 = '2026-10-07T13:50:00.000Z';
const T1 = '2026-10-07T13:51:00.000Z'; // 60 s depois

const ticks = (o) => {
  const t = { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0, ...o };
  t.total = t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;
  return t;
};
const disk = (o) => ({
  dev: 'sda', readIos: 0, sectorsRead: 0, readTicksMs: 0, writeIos: 0, sectorsWrite: 0, writeTicksMs: 0, ioTicksMs: 0,
  readMBps: null, writeMBps: null, utilPct: null, latencyMs: null, ...o,
});
const net = (o) => ({ iface: 'enp0s7', rxBytes: 0, txBytes: 0, rxMbps: null, txMbps: null, ...o });

test('CPU %: usuário, sistema, espera de disco e roubo a partir dos ticks', () => {
  const prev = { ts: T0, uptimeSec: 100, cpuTicks: ticks({ user: 1000, system: 500, idle: 8000, iowait: 500 }) };
  const cur = { ts: T1, uptimeSec: 160, cpuTicks: ticks({ user: 1070, nice: 0, system: 520, idle: 8850, iowait: 530, softirq: 10, steal: 20 }) };
  // delta total = 70 + 20 + 850 + 30 + 10 + 20 = 1000
  assert.deepEqual(computeCpu(cur, prev), { pct: 12, user: 7, system: 3, iowait: 3, steal: 2 });
});

test('CPU %: sem anterior, reinício (uptime menor) ou sem ticks → null', () => {
  const cur = { ts: T1, uptimeSec: 50, cpuTicks: ticks({ idle: 10 }) };
  assert.equal(computeCpu(cur, null), null);
  assert.equal(computeCpu(cur, { ts: T0, uptimeSec: 9999, cpuTicks: ticks({ idle: 5 }) }), null);
  assert.equal(computeCpu({ ...cur, cpuTicks: null }, { ts: T0, uptimeSec: 1, cpuTicks: ticks({}) }), null);
  assert.equal(computeCpu(cur, { ts: T0, uptimeSec: 1, cpuTicks: cur.cpuTicks }), null, 'delta zero');
});

test('rede: Mbps a partir dos bytes; reset de contador e troca de interface → null', () => {
  const prev = { ts: T0, uptimeSec: 100, net: net({ rxBytes: 1_000_000, txBytes: 500_000 }) };
  const cur = { ts: T1, uptimeSec: 160, net: net({ rxBytes: 16_000_000, txBytes: 800_000 }) };
  computeNet(cur, prev);
  assert.equal(cur.net.rxMbps, 2); // 15 MB * 8 / 60 s
  assert.equal(cur.net.txMbps, 0.04);

  const reset = { ts: T1, uptimeSec: 160, net: net({ rxBytes: 10, txBytes: 10 }) };
  computeNet(reset, prev);
  assert.equal(reset.net.rxMbps, null, 'contador andou para trás: sem dado, não 0');

  const other = { ts: T1, uptimeSec: 160, net: net({ iface: 'eth1', rxBytes: 99e9 }) };
  computeNet(other, prev);
  assert.equal(other.net.rxMbps, null);
});

test('disco: MB/s, % de uso (io_ticks) e latência média por operação', () => {
  const prev = { ts: T0, uptimeSec: 100, io: [disk({ readIos: 100, sectorsRead: 1000, readTicksMs: 500, writeIos: 50, sectorsWrite: 2000, writeTicksMs: 300, ioTicksMs: 1000 })] };
  const cur = {
    ts: T1, uptimeSec: 160,
    io: [disk({ readIos: 300, sectorsRead: 1000 + 117188, readTicksMs: 500 + 4000, writeIos: 150, sectorsWrite: 2000 + 58594, writeTicksMs: 300 + 2000, ioTicksMs: 1000 + 30000 })],
  };
  computeIo(cur, prev);
  const d = cur.io[0];
  assert.equal(d.readMBps, 1); // 117188 setores * 512 / 60 s ≈ 1,00 MB/s
  assert.equal(d.writeMBps, 0.5);
  assert.equal(d.utilPct, 50); // 30 s ocupados em 60 s
  assert.equal(d.latencyMs, 20); // 6000 ms / 300 operações
});

test('disco: % de uso nunca passa de 100; sem operações a latência é null; disco novo fica sem taxa', () => {
  const prev = { ts: T0, uptimeSec: 1, io: [disk({ ioTicksMs: 0 })] };
  const cur = { ts: T1, uptimeSec: 61, io: [disk({ ioTicksMs: 90000 }), disk({ dev: 'sdz', ioTicksMs: 5 })] };
  computeIo(cur, prev);
  assert.equal(cur.io[0].utilPct, 100);
  assert.equal(cur.io[0].latencyMs, null);
  assert.equal(cur.io[1].utilPct, null);
});

test('computeRates preenche tudo e respeita ordem de tempo invertida (delta ≤ 0)', () => {
  const prev = { ts: T1, uptimeSec: 100, cpuTicks: ticks({ idle: 1 }), net: net({}), io: [disk({})] };
  const cur = { ts: T0, uptimeSec: 160, cpuTicks: ticks({ idle: 2 }), net: net({ rxBytes: 5 }), io: [disk({ sectorsRead: 5 })] };
  computeRates(cur, prev);
  assert.equal(cur.net.rxMbps, null);
  assert.equal(cur.io[0].readMBps, null);
});
