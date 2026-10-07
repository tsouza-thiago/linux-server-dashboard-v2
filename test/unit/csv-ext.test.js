import test from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, csvEscape } from '../../server/csv.js';

function baseSample(over = {}) {
  return {
    ts: '2026-08-15T09:12:00.000Z',
    host: 'meu-host',
    uptimeSec: 720,
    cores: 1,
    os: { kernel: '6.1.0', name: 'Debian' },
    load: [0.1, 0.2, 0.3],
    ram: { total: 2000, used: 900, avail: 900, swapTotal: 1024, swapUsed: 0 },
    tempC: 29,
    net: { rxMbps: 1.2, txMbps: 0.5, rxBytes: 100, txBytes: 50 },
    disks: [{ mount: '/', pct: 12, usedBytes: 12884901888, availBytes: 89120571392 }],
    io: [],
    ...over,
  };
}

test('csvEscape cobre newline dentro do valor', () => {
  assert.equal(csvEscape('linha1\nlinha2'), '"linha1\nlinha2"');
  assert.equal(csvEscape(''), '');
});

test('toCSV inclui colunas IO quando presentes', () => {
  const samples = [baseSample({
    io: [{ dev: 'sda', readMBps: 1.5, writeMBps: 0.3 }],
  })];
  const csv = toCSV(samples);
  const lines = csv.split('\n');
  assert.ok(lines[0].includes('ioDev,ioReadMBps,ioWriteMBps'));
  assert.ok(lines[1].includes('sda,1.5,0.3'));
});

test('toCSV cria coluna por mount com caracteres especiais saneados', () => {
  const samples = [baseSample({
    disks: [{ mount: '/mnt/disco 1', pct: 10, usedBytes: 1000, availBytes: 2000 }],
  })];
  const csv = toCSV(samples);
  assert.ok(csv.split('\n')[0].includes('disk__mnt_disco_1_pct'));
});

test('toCSV com múltiplos mounts e campos ausentes', () => {
  const samples = [
    baseSample({
      ram: null,
      net: null,
      tempC: null,
      disks: [
        { mount: '/', pct: 12, usedBytes: 1000, availBytes: 9000 },
        { mount: '/mnt/d1', pct: 5, usedBytes: 500, availBytes: 9500 },
      ],
    }),
    baseSample({
      ts: '2026-08-15T09:13:00.000Z',
      disks: [{ mount: '/', pct: 12, usedBytes: 1100, availBytes: 8900 }],
    }),
  ];
  const csv = toCSV(samples);
  const lines = csv.split('\n');
  assert.ok(lines[0].includes('disk___pct') && lines[0].includes('disk__mnt_d1_pct'));
  assert.equal(lines[2].split(',').length, lines[1].split(',').length, 'linhas com mesma largura');
});

test('toCSV com array vazio gera só cabeçalho', () => {
  const csv = toCSV([]);
  assert.ok(csv.startsWith('ts,host,uptimeSec'));
  assert.equal(csv.split('\n').length, 1);
});

test('toCSV escapa valores com vírgula e aspas', () => {
  const samples = [baseSample({ host: 'host, "mal"`' })];
  const csv = toCSV(samples);
  assert.ok(csv.includes('"host, ""mal""`"'));
});