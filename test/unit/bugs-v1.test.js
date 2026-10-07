// Bugs conhecidos da V1 (plano da V2, seção 2.2).
// Cada teste descreve o comportamento CORRETO e hoje falha; por isso está marcado como
// `todo` (aparece no relatório sem deixar a suíte vermelha). O commit que corrigir o bug
// remove o `todo` e o teste passa a valer como regressão.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOutput, computeAlerts } from '../../server/poller.js';
import { AlertsStore } from '../../server/stores.js';
import { toCSV } from '../../server/csv.js';
import { HistoryStore, downsample } from '../../server/history.js';
import { createApp } from '../../server/index.js';
import { loadAll, loadFrontend } from '../../test-support/frontend.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TS = '2026-10-07T12:00:00.000Z';
const OPTS = { svcOrder: [], devSet: new Set() };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-bugs-'));

test('B1 — smartctl sem saída (sem permissão) não gera alerta SMART crítico falso', { todo: 'B1 · corrigir na F1 (coleta)' }, () => {
  // sda sem permissão não imprime nada; o printf sem \n cola a linha com a do sdb
  const s = parseOutput('===HOST===\nsrv\n===SMART===\nsda:sdb:PASSED\n', TS, OPTS);
  assert.ok(s.smart.some((x) => x.dev === 'sdb' && x.status === 'PASSED'), 'sdb deve ser PASSED');
  assert.equal(computeAlerts(s).filter((a) => a.level === 'critical').length, 0);
});

test('B2 — /proc/net/dev com contador colado ao nome da interface é lido', { todo: 'B2 · corrigir na F1 (coleta)' }, () => {
  const out = '===HOST===\nsrv\n===NET===\n  eth0:123456789012 100 0 0 0 0 0 0 9999 50 0 0 0 0 0 0\n';
  const s = parseOutput(out, TS, OPTS);
  assert.equal(s.net.rxBytes, 123456789012);
  assert.equal(s.net.txBytes, 9999);
});

test('B2 — a interface certa é escolhida mesmo com nome parecido (veth0 × eth0)', { todo: 'B2 · corrigir na F1 (coleta)' }, () => {
  const out = '===HOST===\nsrv\n===NET===\n'
    + '  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0\n'
    + ' veth0: 7 1 0 0 0 0 0 0 8 1 0 0 0 0 0 0\n';
  const s = parseOutput(out, TS, { ...OPTS, netIf: 'eth0' });
  assert.equal(s.net.rxBytes, 1000);
  assert.equal(s.net.txBytes, 2000);
});

test('B3 — condição que persiste mantém UM alerta, só com o valor atualizado', { todo: 'B3 · corrigir na F3 (alertas)' }, () => {
  const store = new AlertsStore({ file: path.join(tmpDir(), 'alerts.json') });
  for (const tempC of [61.2, 61.5, 62.0, 61.8]) {
    store.reconcile(computeAlerts({ disks: [], ram: null, tempC, smart: [], services: {} }));
  }
  assert.equal(store.data.length, 1);
  assert.equal(store.active.length, 1);
});

test('B4 — CSV com 2+ discos de I/O tem o mesmo número de colunas no cabeçalho e nas linhas', { todo: 'B4 · corrigir na F2 (armazenamento/export)' }, () => {
  const sample = {
    ts: TS, host: 'srv', load: [0, 0, 0], disks: [],
    io: [{ dev: 'sda', readMBps: 1, writeMBps: 2 }, { dev: 'sdb', readMBps: 3, writeMBps: 4 }],
  };
  const [header, row] = toCSV([sample]).split('\n');
  assert.equal(row.split(',').length, header.split(',').length);
});

test('B5 — resumo diário agrupa pelo dia do fuso local, não UTC', { todo: 'B5 · corrigir na F5/F6 (frontend)' }, () => {
  const prevTZ = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const { Dash } = loadFrontend('analysis.js');
    // 01:00 UTC de 07/10 = 22:00 de 06/10 em São Paulo
    const [day] = Dash.analysis.dailySummary([{ ts: '2026-10-07T01:00:00.000Z', load: [1, 1, 1] }]);
    assert.equal(day.day, '2026-10-06');
  } finally {
    if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ;
  }
});

test('B6 — selo SMART de um ponto de montagem vem do disco que o contém', { todo: 'B6 · corrigir na F1 (device do mount) + F6' }, () => {
  const { sandbox } = loadAll(['analysis.js', 'sections.js']);
  const sample = { smart: [{ dev: 'sda', status: 'PASSED' }], disks: [{ mount: '/', source: '/dev/sda2' }] };
  assert.equal(sandbox.smartOf(sample, '/').status, 'PASSED');
});

test('B7 — gravar uma amostra não reescreve o histórico inteiro', { todo: 'B7 · corrigir na F2 (NDJSON append-only)' }, async () => {
  const store = new HistoryStore({ limit: 5000, file: path.join(tmpDir(), 'history.json') });
  const sample = { ts: TS, host: 'srv', topProcs: Array(7).fill({ user: 'root', pid: 1, cpu: 0, mem: 0.3, cmd: '/usr/sbin/smbd --foreground' }) };
  store.samples = Array(2000).fill(sample);
  const sizes = [];
  const original = fsp.writeFile;
  fsp.writeFile = async (file, data, opts) => { sizes.push(Buffer.byteLength(data)); return original(file, data, opts); };
  try {
    store.append({ ...sample, ts: '2026-10-07T12:01:00.000Z' });
    await store.flush();
  } finally {
    fsp.writeFile = original;
  }
  assert.ok(sizes.length > 0, 'deveria ter gravado algo');
  assert.ok(Math.max(...sizes) < 64 * 1024, `gravou ${Math.max(...sizes)} bytes para 1 amostra`);
});

test('B8 — redução de pontos para o gráfico preserva picos', { todo: 'B8 · corrigir na F2 (agregação por balde)' }, () => {
  const list = Array.from({ length: 1440 }, (_, i) => ({ ts: String(i).padStart(5, '0'), v: 1 }));
  list[701].v = 100; // pico em índice ímpar: a amostragem por passo 2 descarta
  const out = downsample(list, 720);
  assert.ok(out.some((s) => s.v === 100), 'o pico de 100 sumiu');
});

test('B9 — registro de quedas sobrevive a muitos alertas (base do uptime)', { todo: 'B9 · corrigir na F3 (log de outages)' }, () => {
  const store = new AlertsStore({ file: path.join(tmpDir(), 'alerts.json') });
  const now = Date.now();
  store.data.push({
    id: 'queda', key: 'servidor-inacessivel', level: 'critical', status: 'resolved',
    message: 'Servidor inacessível: timeout',
    ts: new Date(now - 3600e3).toISOString(), resolvedAt: new Date(now - 1800e3).toISOString(),
  });
  for (let i = 0; i < 600; i++) store.add({ level: 'warning', message: `RAM usada em ${90 + (i % 10)}% #${i}` });
  const { Dash } = loadFrontend('analysis.js');
  assert.equal(Dash.analysis.outages(store.data).length, 1, 'a queda de 30 min foi apagada pelo limite de 500 alertas');
});

test('B10 — eixo de tempo real nos gráficos (anotações caem no instante certo)', { todo: 'B10 · corrigir na F5 (uPlot)' }, () => {
  const { Dash } = loadFrontend('charts.js');
  Dash.charts.registerSpecs();
  const chart = Object.values(Dash.charts.charts)[0];
  assert.ok(['time', 'linear'].includes(chart.options.scales.x.type), `eixo x é "${chart.options.scales.x.type ?? 'category'}"`);
});

test('B11 — encerramento grava o histórico pendente antes de sair', { todo: 'B11 · corrigir na F4 (HTTP)' }, async () => {
  let flushed = false;
  const store = { length: 0, limit: 10, getLatest: () => null, getRange: () => [], append() {}, flush: async () => { flushed = true; } };
  const app = createApp({ store, log: () => {}, alertsFile: path.join(tmpDir(), 'a.json'), annotationsFile: path.join(tmpDir(), 'n.json') });
  assert.equal(typeof app.shutdown, 'function', 'createApp não expõe shutdown()');
  await app.shutdown();
  assert.ok(flushed);
});

test('B12 — stop.sh só encerra o processo que o próprio painel registrou', { todo: 'B12 · corrigir na F7 (comando dashboard)' }, () => {
  const stop = fs.readFileSync(path.join(ROOT, 'stop.sh'), 'utf8');
  assert.doesNotMatch(stop, /lsof\s+-t\s+-i/, 'fallback por porta pode matar processo alheio');
  assert.doesNotMatch(stop, /pgrep\s+-f/, 'fallback por nome pode matar processo alheio');
});

test('I5 — seção ausente vira "sem dado", nunca zero inventado', { todo: 'I5 · corrigir na F1 (coleta)' }, () => {
  const s = parseOutput('===HOST===\nsrv\n', TS, OPTS);
  assert.equal(s.load, null, 'load ausente virou [0,0,0]');
  assert.equal(s.net, null, 'rede ausente virou zeros');
});
