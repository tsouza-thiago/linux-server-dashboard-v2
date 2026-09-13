import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput, computeAlerts, describeError, buildCommand } from '../server/poller.js';

const FIXTURE = `===HOST===
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
              total        used        free      shared  buff/cache   available
Mem:           2000         900         200         100         800         900
Swap:          1024           0
===DF===
Mounted on Size Used Avail Use%
/ 100G 12G 83G 12%
/mnt/disco1 1.0T 300G 700G 29%
===DFB===
Mounted on Size Used Avail Use%
/ 107374182400 12884901888 89120571392 12%
/mnt/disco1 1099511627776 322122547200 751619276800 29%
===NET===
enp0s7: 206460 0 0 0 0 0 0 0 1739375 0 0 0 0 0 0 0
===IO===
 8       0 sda 100 0 290554 1000 200 0 61168 500 0 100 0
 8      16 sdb 100 0 1000 100 200 0 2000 500 0 100 0
===TEMP===
29000
===SMART===
sda:PASSED
sdb:PASSED
===SERVICES===
active
active
===PS===
USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root         1  0.0  0.3 167680 12312 ?        Ss   ago15   0:10 /sbin/init
root       123  0.5  2.1 123456 45678 ?        S    ago15   0:05 /usr/sbin/sshd
`;

test('parseOutput interpreta uma amostra realista', () => {
  const s = parseOutput(FIXTURE, '2026-08-15T09:12:00.000Z', { svcOrder: ['smbd', 'nmbd'] });
  assert.equal(s.host, 'meu-host');
  assert.equal(s.os.kernel, '6.1.0-33-amd64');
  assert.equal(s.os.name, 'Debian GNU/Linux 12 (bookworm)');
  assert.equal(s.cores, 1);
  assert.equal(s.uptimeSec, 720);
  assert.deepEqual(s.load, [0.15, 0.09, 0.10]);
  assert.equal(s.ram.total, 2000);
  assert.equal(s.ram.used, 900);
  assert.equal(s.ram.avail, 900);
  assert.equal(s.ram.swapTotal, 1024);
  assert.equal(s.ram.swapUsed, 0);
  assert.equal(s.disks.length, 2);
  assert.equal(s.disks[0].mount, '/');
  assert.equal(s.disks[0].sizeBytes, 107374182400);
  assert.equal(s.disks[0].pct, 12);
  assert.equal(s.disks[1].usedBytes, 322122547200);
  assert.equal(s.net.rxBytes, 206460);
  assert.equal(s.net.txBytes, 1739375);
  assert.equal(s.io.length, 2);
  assert.equal(s.io[0].dev, 'sda');
  assert.equal(s.io[1].dev, 'sdb');
  assert.equal(s.tempC, 29.0);
  assert.equal(s.smart.length, 2);
  assert.equal(s.smart[0].status, 'PASSED');
  assert.equal(s.services.smbd, 'active');
  assert.equal(s.services.nmbd, 'active');
  assert.equal(s.topProcs[0].pid, 1);
  assert.equal(s.topProcs[0].cmd, '/sbin/init');
});

test('parseOutput trata amostra vazia', () => {
  const s = parseOutput('', '2026-08-15T09:12:00.000Z');
  assert.equal(s.host, '');
  assert.equal(s.load.length, 3);
  assert.equal(s.disks.length, 0);
});

test('computeAlerts respeita limiares', () => {
  const base = {
    disks: [{ mount: '/', pct: 92 }],
    ram: { total: 1000, used: 950 },
    tempC: 65,
    smart: [{ dev: 'sda', status: 'PASSED' }],
    services: { smbd: 'active' },
  };
  const alerts = computeAlerts(base);
  assert.ok(alerts.some((a) => a.level === 'warning' && a.message.includes('Disco')));
  assert.ok(alerts.some((a) => a.level === 'warning' && a.message.includes('RAM')));
  assert.ok(alerts.some((a) => a.level === 'warning' && a.message.includes('Temperatura')));

  const critical = computeAlerts({
    disks: [],
    ram: { total: 1000, used: 100 },
    tempC: 30,
    smart: [{ dev: 'sda', status: 'FAILED' }],
    services: { smbd: 'inactive' },
  });
  assert.ok(critical.some((a) => a.level === 'critical' && a.message.includes('SMART')));
  assert.ok(critical.some((a) => a.level === 'critical' && a.message.includes('smbd')));

  assert.deepEqual(computeAlerts({
    disks: [{ mount: '/', pct: 20 }],
    ram: { total: 1000, used: 300 },
    tempC: 40,
    smart: [{ dev: 'sda', status: 'PASSED' }],
    services: { smbd: 'active' },
  }), []);
});

test('describeError converte falhas SSH em mensagens amigáveis', () => {
  assert.equal(describeError({ timedOut: true }), 'timeout — servidor não respondeu (rede/servidor fora do ar?)');
  assert.ok(describeError({ stderr: 'Host key verification failed.' }).includes('install.sh'));
  assert.equal(describeError({ code: 255 }), 'SSH falhou (exit 255) — host não encontrado ou chave inválida');
  assert.equal(describeError({ code: 1 }), 'SSH falhou (exit 1)');
  assert.equal(describeError({ error: 'spawn ssh ENOENT' }), 'spawn ssh ENOENT');
});

test('buildCommand monta comando de leitura com seções', () => {
  const cmd = buildCommand();
  assert.ok(cmd.includes("echo '===HOST==='"));
  assert.ok(cmd.includes("echo '===PS==='"));
  assert.ok(!cmd.includes('; rm'));
});