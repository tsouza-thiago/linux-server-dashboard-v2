import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from '../../test-support/frontend.js';

function makeSamples() {
  return [
    {
      ts: '2026-08-15T09:00:00.000Z',
      load: [0.5, 0.4, 0.3],
      ram: { total: 100, used: 50 },
      tempC: 40,
      disks: [{ mount: '/', pct: 50 }],
      net: { rxMbps: 1.5, txMbps: 0.5 },
      io: [{ dev: 'sda', readMBps: 1.1, writeMBps: 0.2 }],
    },
    {
      ts: '2026-08-15T09:01:00.000Z',
      load: [0.6, 0.4, 0.3],
      ram: { total: 100, used: 60 },
      tempC: null,
      disks: [{ mount: '/', pct: 51 }],
      net: { rxMbps: 2.0, txMbps: 0.6 },
      io: [{ dev: 'sda', readMBps: 1.3, writeMBps: 0.3 }],
    },
  ];
}

function ctx() {
  const c = loadFrontend('charts.js');
  c.Dash.diskDetailMount = '/';
  c.Dash.ioDev = 'sda';
  c.Dash.charts.registerSpecs();
  return c;
}

test('charts.labels gera rótulos de hora por amostra', () => {
  const { Dash } = ctx();
  const labels = Dash.charts.labels(makeSamples());
  assert.equal(labels.length, 2);
  assert.match(labels[0], /^\d{2}:\d{2}:\d{2}$/);
});

test('charts.series converte nulo/undefined em null', () => {
  const { Dash } = ctx();
  const s = [
    { tempC: 10 },
    { tempC: null },
    {},
    { tempC: 30 },
  ];
  const data = Dash.charts.series(s, (x) => x.tempC);
  assert.deepEqual(data, [10, null, null, 30]);
});

test('charts.spec.load/ram/temp extraem séries', () => {
  const { Dash } = ctx();
  const samples = makeSamples();
  const load = Dash.charts.specs.load.fn(samples);
  assert.equal(load.datasets.length, 3);
  assert.deepEqual(load.datasets[0].data, [0.5, 0.6]);

  const ram = Dash.charts.specs.ram.fn(samples);
  assert.deepEqual(ram.datasets[0].data, [50, 60]);

  const temp = Dash.charts.specs.temp.fn(samples);
  assert.deepEqual(temp.datasets[0].data, [40, null]);
});

test('charts.spec.disk agrupa por mount', () => {
  const { Dash } = ctx();
  const samples = makeSamples();
  const disk = Dash.charts.specs.disk.fn(samples);
  assert.equal(disk.datasets.length, 1);
  assert.equal(disk.datasets[0].label, '/');
  assert.deepEqual(disk.datasets[0].data, [50, 51]);
});

test('charts.spec.diskDetail usa mount selecionado', () => {
  const { Dash } = ctx();
  const samples = makeSamples();
  Dash.diskDetailMount = '/';
  const detail = Dash.charts.specs.diskDetail.fn(samples);
  assert.equal(detail.datasets.length, 1);
  assert.equal(detail.datasets[0].label, '/ %');
  Dash.diskDetailMount = null;
  assert.equal(Dash.charts.specs.diskDetail.fn(samples).datasets.length, 0);
});

test('charts.spec.net extrai download/upload', () => {
  const { Dash } = ctx();
  const net = Dash.charts.specs.net.fn(makeSamples());
  assert.deepEqual(net.datasets[0].data, [1.5, 2.0]);
  assert.deepEqual(net.datasets[1].data, [0.5, 0.6]);
});

test('charts.spec.io usa dispositivo selecionado', () => {
  const { Dash } = ctx();
  Dash.ioDev = 'sda';
  const io = Dash.charts.specs.io.fn(makeSamples());
  assert.equal(io.datasets[0].label, 'sda leitura MB/s');
  assert.deepEqual(io.datasets[0].data, [1.1, 1.3]);
  assert.deepEqual(io.datasets[1].data, [0.2, 0.3]);
});

test('charts.spec.io com dispositivo sem dados gera nulos', () => {
  const { Dash } = ctx();
  Dash.ioDev = 'sdb';
  const io = Dash.charts.specs.io.fn(makeSamples());
  assert.deepEqual(io.datasets[0].data, [null, null]);
});

test('charts.toDataset mapeia cor e fill', () => {
  const { Dash } = ctx();
  const d = Dash.charts.toDataset({ label: 'x', data: [1, 2], color: '#3b82f6', fill: true });
  assert.equal(d.label, 'x');
  assert.equal(d.borderColor, '#3b82f6');
  assert.equal(d.backgroundColor, '#3b82f622');
  assert.equal(d.fill, true);
  assert.equal(d.pointRadius, 0);
});

test('charts.sync atualiza todos os gráficos criados', () => {
  const { Dash } = ctx();
  Dash.samples = makeSamples();
  Dash.charts.sync();
  assert.equal(Dash.charts.charts.load.data.labels.length, 2);
  assert.equal(Dash.charts.charts.ram.data.datasets[0].data.length, 2);
  assert.equal(Dash.charts.charts.disk.data.datasets[0].data.length, 2);
});