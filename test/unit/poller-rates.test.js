import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collect, buildCommand, computeNetRates, computeIoRates, describeError,
} from '../../server/poller.js';

const OK_STDOUT = `===HOST===
meu-host
===OS===
6.1.0-33-amd64
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
===CPU===
1
===UPTIME===
720 12345
===LOAD===
0.15 0.09 0.10 1/100 2000
===FREE===
Mem:           2000         900         200         100         800         900
Swap:          1024           0
===DF===
Mounted on Size Used Avail Use%
/ 100G 12G 83G 12%
===DFB===
Mounted on Size Used Avail Use%
/ 107374182400 12884901888 89120571392 12%
===NET===
enp0s7: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0
===IO===
  8       0 sda 100 0 290554 1000 200 0 61168 500 0 100 0
===TEMP===
29000
===SMART===
sda:PASSED
===SERVICES===
active
===PS===
USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root         1  0.0  0.3 167680 12312 ?        Ss   ago15   0:10 /sbin/init
`;

test('computeNetRates calcula Mbps a partir de deltas', () => {
  const prev = { ts: '2026-08-15T09:00:00.000Z', net: { rxBytes: 0, txBytes: 0 } };
  const cur = { ts: '2026-08-15T09:00:10.000Z', net: { rxBytes: 1250000, txBytes: 0 } };
  computeNetRates(cur, prev);
  assert.equal(cur.net.rxMbps, 1.0); // 1.25MB * 8 / 10s / 1e6
  assert.equal(cur.net.txMbps, 0);
});

test('computeNetRates clampa a zero quando contadores resetam', () => {
  const prev = { ts: '2026-08-15T09:00:00.000Z', net: { rxBytes: 99999 } };
  const cur = { ts: '2026-08-15T09:00:10.000Z', net: { rxBytes: 100 } };
  computeNetRates(cur, prev);
  assert.equal(cur.net.rxMbps, 0);
});

test('computeNetRates ignora delta zero ou sem prev', () => {
  const s = { ts: '2026-08-15T09:00:00.000Z', net: { rxBytes: 100, rxMbps: 0 } };
  computeNetRates(s, null);
  assert.equal(s.net.rxMbps, 0);
  computeNetRates(s, { ts: '2026-08-15T09:00:00.000Z', net: { rxBytes: 0 } });
  assert.equal(s.net.rxMbps, 0);
});

test('computeIoRates calcula MB/s por dispositivo', () => {
  const prev = {
    ts: '2026-08-15T09:00:00.000Z',
    io: [{ dev: 'sda', sectorsRead: 0, sectorsWrite: 0 }],
  };
  const cur = {
    ts: '2026-08-15T09:00:10.000Z',
    io: [{ dev: 'sda', sectorsRead: 19531, sectorsWrite: 0 }],
  };
  computeIoRates(cur, prev);
  assert.equal(cur.io[0].readMBps, 1.0); // 19531 * 512 / 10s / 1e6 ≈ 1.0 MB/s
  assert.equal(cur.io[0].writeMBps, 0);
});

test('computeIoRates pula dispositivo novo e sem prev', () => {
  const prev = { ts: '2026-08-15T09:00:00.000Z', io: [{ dev: 'sda', sectorsRead: 1 }] };
  const cur = { ts: '2026-08-15T09:00:10.000Z', io: [{ dev: 'sdb', sectorsRead: 5 }] };
  computeIoRates(cur, prev);
  assert.equal(cur.io[0].readMBps, undefined);
  computeIoRates(cur, null);
  assert.equal(cur.io[0].readMBps, undefined);
});

test('collect: sucesso com runner injetado', async () => {
  const res = await collect({
    host: 'meu-host',
    prev: null,
    runner: async () => ({ stdout: OK_STDOUT, stderr: '', code: 0, timedOut: false }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.sample.host, 'meu-host');
  assert.equal(res.sample.cores, 1);
  assert.equal(res.sample.tempC, 29);
  assert.deepEqual(res.alerts, []);
});

test('collect: falha com exit 255', async () => {
  const res = await collect({
    host: 'meu-host',
    prev: null,
    runner: async () => ({ stdout: '', stderr: 'Connection refused', code: 255, timedOut: false }),
  });
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('255'));
});

test('collect: timeout', async () => {
  const res = await collect({
    host: 'meu-host',
    prev: null,
    runner: async () => ({ stdout: '', stderr: '', code: null, timedOut: true }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, describeError({ timedOut: true }));
});

test('collect: stdout sem marcação ===HOST=== vira falha', async () => {
  const res = await collect({
    host: 'meu-host',
    prev: null,
    runner: async () => ({ stdout: 'sem marcação', stderr: '', code: 0, timedOut: false }),
  });
  assert.equal(res.ok, false);
});

test('buildCommand: inclui seções condicionais apenas quando configuradas', () => {
  const base = buildCommand({ netIf: '', diskDevs: [], services: [] });
  assert.ok(base.includes("echo '===HOST==='"));
  assert.ok(base.includes("echo '===TEMP==='"));
  assert.ok(base.includes("echo '===PS==='"));
  assert.ok(!base.includes('===NET==='));
  assert.ok(!base.includes('===IO==='));
  assert.ok(!base.includes('===SMART==='));
  assert.ok(!base.includes('systemctl'));

  const full = buildCommand({ netIf: 'enp0s7', diskDevs: ['sda', 'sdb'], services: ['smbd'] });
  assert.ok(full.includes('grep enp0s7'));
  assert.ok(full.includes('$3=="sda"||$3=="sdb"'));
  assert.ok(full.includes('smartctl -H /dev/sda'));
  assert.ok(full.includes('systemctl is-active smbd'));
});

test('buildCommand: usa mounts configurados', () => {
  const cmd = buildCommand({ diskMounts: ['/', '/mnt/disco1'], netIf: '', diskDevs: [], services: [] });
  assert.ok(cmd.includes('df -h --output=target,size,used,avail,pcent / /mnt/disco1'));
});