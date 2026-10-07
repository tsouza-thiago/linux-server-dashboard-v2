import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput, DEV_SET, SVC_ORDER } from '../../server/poller.js';

const TS = '2026-08-15T09:12:00.000Z';

test('parseOutput: sem seção TEMP deixa tempC nulo', () => {
  const s = parseOutput(`===HOST===
meu-host
===UPTIME===
100 1000
`, TS);
  assert.equal(s.tempC, null);
  assert.equal(s.host, 'meu-host');
  assert.equal(s.uptimeSec, 100);
});

test('parseOutput: load com vírgula (locale) é interpretado', () => {
  const s = parseOutput(`===HOST===
h
===LOAD===
0,15 0,09 0,10 1/100 2000
`, TS);
  assert.deepEqual(s.load, [0.15, 0.09, 0.10]);
});

test('parseOutput: uptime fracionado', () => {
  const s = parseOutput(`===HOST===
h
===UPTIME===
720.5 12345
`, TS);
  assert.equal(s.uptimeSec, 720.5);
  assert.ok(Date.parse(s.bootAt) < Date.parse(TS));
});

test('parseOutput: OS apenas com NAME', () => {
  const s = parseOutput(`===HOST===
h
===OS===
6.1.0
NAME="Debian"
`, TS);
  assert.equal(s.os.kernel, '6.1.0');
  assert.equal(s.os.name, 'Debian');
});

test('parseOutput: df ignora cabeçalhos e pcent com %', () => {
  const s = parseOutput(`===HOST===
h
===DF===
Mounted on Size Used Avail Use%
/ 100G 12G 83G 12%
/mnt/d1 1.0T 300G 700G 29%
===DFB===
Mounted on Size Used Avail Use%
/ 107374182400 12884901888 89120571392 12%
/mnt/d1 1099511627776 322122547200 751619276800 29%
`, TS);
  assert.equal(s.disks.length, 2);
  assert.equal(s.disks[0].mount, '/');
  assert.equal(s.disks[0].pct, 12);
  assert.equal(s.disks[0].sizeBytes, 107374182400);
  assert.equal(s.disks[1].pct, 29);
});

test('parseOutput: filtra IO pelos dispositivos configurados', () => {
  const extra = DEV_SET.size ? ` 8      32 zz-notreal 0 0 1 0 0 0 2 0 0 0 0\n` : '';
  const keep = DEV_SET.size ? ` 8      0 ${DEV_SET.values().next().value} 0 0 10 0 0 0 20 0 0 0 0\n` : '';
  const s = parseOutput(`===HOST===
h
===IO===
${keep}${extra}`, TS);
  for (const io of s.io) assert.ok(DEV_SET.has(io.dev), `dispositivo ${io.dev} não deveria estar presente`);
});

test('parseOutput: services segue a ordem configurada', () => {
  const lines = SVC_ORDER.map(() => 'active').join('\n');
  const s = parseOutput(`===HOST===
h
===SERVICES===
${lines}`, TS);
  assert.deepEqual(Object.keys(s.services), SVC_ORDER);
  assert.ok(Object.values(s.services).every((v) => v === 'active'));
});

test('parseOutput: SMART sem status válido não entra', () => {
  const s = parseOutput(`===HOST===
h
===SMART===
sda:PASSED
sdb:
semDoisPontos
`, TS);
  assert.equal(s.smart.length, 1);
  assert.equal(s.smart[0].dev, 'sda');
});

test('parseOutput: ps ignora linhas com colunas insuficientes', () => {
  const s = parseOutput(`===HOST===
h
===PS===
USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
root 1 0.0 0.3 1 1 ? S ago15 0:00 /sbin/init
linha curta demais
daemon 2 1.5 2.0 2 2 ? S ago15 0:00 /usr/sbin/sshd -D
`, TS);
  assert.equal(s.topProcs.length, 2);
  assert.equal(s.topProcs[0].cmd, '/sbin/init');
  assert.equal(s.topProcs[1].user, 'daemon');
});

test('parseOutput: temp zero é ignorada', () => {
  const s = parseOutput(`===HOST===
h
===TEMP===
0
`, TS);
  assert.equal(s.tempC, null);
});

test('parseOutput: RAM ausente fica null', () => {
  const s = parseOutput(`===HOST===
h
`, TS);
  assert.equal(s.ram, null);
});