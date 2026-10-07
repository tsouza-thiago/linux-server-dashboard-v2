import test from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, csvEscape } from '../../server/csv.js';

test('csvEscape protege contra formula injection do Excel', () => {
  assert.equal(csvEscape('=cmd()'), "'=cmd()");
  assert.equal(csvEscape('+SUM(1)'), "'+SUM(1)");
  assert.equal(csvEscape('-2+3'), "'-2+3");
  assert.equal(csvEscape('@SUM'), "'@SUM");
  assert.equal(csvEscape('normal'), 'normal');
  assert.equal(csvEscape('com, vírgula'), '"com, vírgula"');
  assert.equal(csvEscape('aspas "duplas"'), '"aspas ""duplas"""');
});

test('toCSV gera linhas com escape e sem quebra', () => {
  const samples = [
    {
      ts: '2026-08-15T09:12:00.000Z',
      host: 'meu-host',
      uptimeSec: 720,
      cores: 1,
      os: { kernel: '6.1.0' },
      load: [0.1, 0.2, 0.3],
      ram: { total: 2000, used: 900, avail: 900, swapTotal: 1024, swapUsed: 0 },
      tempC: 29,
      net: { rxMbps: 1.2, txMbps: 0.5 },
      disks: [{ mount: '/', pct: 12, usedBytes: 12884901888, availBytes: 89120571392 }],
      io: [],
    },
  ];
  const csv = toCSV(samples);
  const lines = csv.split('\n');
  assert.ok(lines[0].includes('disk___pct'));
  assert.ok(lines[1].includes('12'));
  assert.ok(lines[1].includes('12.88'));
});

test('toCSV escapa host malicioso', () => {
  const samples = [{
    ts: '2026-08-15T09:12:00.000Z',
    host: '=HYPERLINK("http://evil")',
    uptimeSec: 1,
    cores: 1,
    os: { kernel: 'k' },
    load: [0, 0, 0],
    ram: null,
    tempC: 20,
    net: null,
    disks: [],
    io: [],
  }];
  const csv = toCSV(samples);
  assert.ok(csv.includes("'=HYPERLINK"));
});