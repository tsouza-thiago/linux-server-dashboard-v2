// Bugs conhecidos da V1 (plano da V2, seção 2.2).
// Cada teste descreve o comportamento CORRETO. Os ainda abertos estão marcados como `todo`
// (aparecem no relatório sem deixar a suíte vermelha); o commit que corrige o bug remove o
// `todo` e o teste passa a valer como regressão. Corrigidos na F1: B1, B2, B6, I5.
// Corrigidos na F2: B4, B7, B8, B11 (detalhes em test/unit/storage-*.test.js).
// Corrigidos na F3: B3, B9 (detalhes em test/unit/alerts-*.test.js).
// Corrigidos na F5: B5, B10 (detalhes em test/unit/front-core.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOutput, computeAlerts } from '../../server/poller.js';
import { AlertsStore } from '../../server/stores.js';
import { OutageLog } from '../../server/storage/outages.js';
import { toCSV } from '../../server/csv.js';
import { RawStore } from '../../server/storage/ndjson.js';
import { downsample } from '../../server/storage/buckets.js';
import { createApp } from '../../server/index.js';
import { dailySummary } from '../../public/js/core/analysis.js';
import { markersInRange } from '../../public/js/charts/timeseries.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TS = '2026-10-07T12:00:00.000Z';
const OPTS = { svcOrder: [], devSet: new Set() };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-bugs-'));

test('B1 — smartctl sem permissão não gera alerta SMART crítico falso', () => {
  // V2: o comando imprime 1 linha por disco com o estado já classificado (ver collector-builder)
  const s = parseOutput('===HOST===\nsrv\n===SMART===\nsda SEM_PERMISSAO\nsdb PASSED\n', TS, OPTS);
  assert.ok(s.smart.some((x) => x.dev === 'sdb' && x.status === 'PASSED'), 'sdb deve ser PASSED');
  assert.equal(computeAlerts(s).filter((a) => a.level === 'critical').length, 0);
});

test('B2 — /proc/net/dev com contador colado ao nome da interface é lido', () => {
  const out = '===HOST===\nsrv\n===NET===\n  eth0:123456789012 100 0 0 0 0 0 0 9999 50 0 0 0 0 0 0\n';
  const s = parseOutput(out, TS, OPTS);
  assert.equal(s.net.rxBytes, 123456789012);
  assert.equal(s.net.txBytes, 9999);
});

test('B2 — a interface certa é escolhida mesmo com nome parecido (veth0 × eth0)', () => {
  const out = '===HOST===\nsrv\n===NET===\n'
    + '  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0\n'
    + ' veth0: 7 1 0 0 0 0 0 0 8 1 0 0 0 0 0 0\n';
  const s = parseOutput(out, TS, { targets: { netIf: 'eth0' } });
  assert.equal(s.net.rxBytes, 1000);
  assert.equal(s.net.txBytes, 2000);
});

test('B3 — condição que persiste mantém UM alerta, só com o valor atualizado', () => {
  const store = new AlertsStore({ file: path.join(tmpDir(), 'alerts.json') });
  for (const tempC of [61.2, 61.5, 62.0, 61.8]) {
    store.reconcile(computeAlerts({ disks: [], ram: null, tempC, smart: [], services: {} }));
  }
  assert.equal(store.data.length, 1);
  assert.equal(store.active.length, 1);
});

test('B4 — CSV com 2+ discos de I/O tem o mesmo número de colunas no cabeçalho e nas linhas', () => {
  const sample = {
    ts: TS, host: 'srv', load: [0, 0, 0], disks: [],
    io: [{ dev: 'sda', readMBps: 1, writeMBps: 2 }, { dev: 'sdb', readMBps: 3, writeMBps: 4 }],
  };
  const [header, row] = toCSV([sample]).split('\n');
  assert.equal(row.split(',').length, header.split(',').length);
});

test('B5 — resumo diário agrupa pelo dia do fuso local, não UTC', () => {
  const prevTZ = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    // 01:00 UTC de 07/10 = 22:00 de 06/10 em São Paulo
    const [day] = dailySummary([{ t: Date.parse('2026-10-07T01:00:00.000Z'), n: 60, m: { load1: [1, 1, 1] } }], ['load1']);
    assert.equal(day.day, '2026-10-06');
  } finally {
    if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ;
  }
});

test('B7 — gravar uma amostra não reescreve o histórico inteiro', async () => {
  const dir = tmpDir();
  const store = new RawStore({ dir, limit: 5000, log: () => {} });
  const base = { host: 'srv', topProcs: Array(7).fill({ user: 'root', pid: 1, cpu: 0, mem: 0.3, cmd: '/usr/sbin/smbd --foreground' }) };
  const tsAt = (i) => new Date(Date.parse(TS) + i * 60000).toISOString();
  for (let i = 0; i < 2000; i++) store.append({ ...base, ts: tsAt(i) });
  await store.flush();
  const total = () => fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  const before = total();
  store.append({ ...base, ts: tsAt(2000) });
  await store.flush();
  const written = total() - before;
  assert.ok(written > 0, 'deveria ter gravado algo');
  assert.ok(written < 64 * 1024, `gravou ${written} bytes para 1 amostra`);
});

test('B8 — redução de pontos para o gráfico preserva picos', () => {
  const list = Array.from({ length: 1440 }, (_, i) => ({ ts: new Date(Date.parse(TS) + i * 60000).toISOString(), tempC: 40 }));
  list[701].tempC = 100; // pico em índice ímpar: a amostragem por passo 2 da V1 descartava
  const out = downsample(list, 720);
  assert.ok(out.some((s) => s.tempC === 100), 'o pico de 100 sumiu');
});

test('B9 — registro de quedas sobrevive a muitos alertas (base do uptime)', () => {
  const dir = tmpDir();
  const store = new AlertsStore({ file: path.join(dir, 'alerts.json') });
  const outages = new OutageLog({ file: path.join(dir, 'outages.ndjson') });
  const now = Date.now();
  outages.start(now - 3600e3, 'timeout');
  outages.end(now - 1800e3);
  for (let i = 0; i < 600; i++) store.add({ level: 'warning', message: `RAM usada em ${90 + (i % 10)}% #${i}` });
  assert.equal(outages.list().length, 1, 'a queda de 30 min foi apagada pelo limite de 500 alertas');
  assert.equal(outages.list()[0].durationSec, 1800);
});

test('B10 — eixo de tempo real nos gráficos (anotações caem no instante certo)', () => {
  // uPlot com eixo x em segundos: a anotação é posicionada pelo instante, não pelo índice
  // do ponto (na V1 o eixo era de categorias "HH:MM:SS").
  const ts = '2026-10-07T12:34:56.000Z';
  const sec = Date.parse(ts) / 1000;
  assert.deepEqual(markersInRange([{ ts, text: 'troquei o disco' }], sec - 60, sec + 60), [{ x: sec, label: 'troquei o disco' }]);
  assert.deepEqual(markersInRange([{ ts, text: 'fora' }], sec + 1, sec + 60), [], 'fora da janela visível não aparece');
});

test('B11 — encerramento grava o histórico pendente antes de sair', async () => {
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

test('I5 — seção ausente vira "sem dado", nunca zero inventado', () => {
  const s = parseOutput('===HOST===\nsrv\n', TS, OPTS);
  assert.equal(s.load, null, 'load ausente virou [0,0,0]');
  assert.equal(s.net, null, 'rede ausente virou zeros');
});
