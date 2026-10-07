import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RollupStore, ROLLUP_STEP_MS } from '../../server/storage/rollup.js';
import { History } from '../../server/storage/index.js';
import { listDays, dayOf, readNdjson, writeFileAtomicSync, HOUR_MS, DAY_MS } from '../../server/storage/ndjson.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-rollup-'));
const MIN = 60000;
const BASE = Date.UTC(2026, 9, 7, 0, 0);
const at = (min) => new Date(BASE + min * MIN).toISOString();
const sample = (min, tempC = 40) => ({ ts: at(min), host: 'srv', tempC, load: [0.1, 0.1, 0.1] });
const silent = () => {};

test('RollupStore: fecha só baldes completos, 1 linha por balde, e retoma após reiniciar', async () => {
  const dir = tmp();
  const r = new RollupStore({ dir, log: silent });
  const raw = [];
  for (let i = 0; i < 12; i++) { raw.push(sample(i, 40 + i)); r.close(raw, Date.parse(raw.at(-1).ts)); }
  await r.flush();
  const lines = readNdjson(path.join(dir, `${dayOf(at(0))}.ndjson`)).items;
  assert.deepEqual(lines.map((b) => [b.t, b.n]), [[BASE, 5], [BASE + ROLLUP_STEP_MS, 5]], 'balde 10–15 ainda aberto');
  assert.deepEqual(lines[0].m.tempC, [40, 44, 42]);
  assert.equal(fs.statSync(path.join(dir, `${dayOf(at(0))}.ndjson`)).mode & 0o777, 0o600);

  const again = new RollupStore({ dir, log: silent });
  assert.equal(again.lastT, BASE + ROLLUP_STEP_MS);
  again.close(raw, Date.parse(at(11)));
  await again.flush();
  assert.equal(readNdjson(path.join(dir, `${dayOf(at(0))}.ndjson`)).items.length, 2, 'fechar de novo não duplica');
});

test('RollupStore: query filtra por intervalo e atravessa dias; apaga além de 90 dias', async () => {
  const dir = tmp();
  const r = new RollupStore({ dir, retentionDays: 90, log: silent });
  const raw = [];
  for (let d = 0; d < 95; d += 1) for (let i = 0; i < 6; i += 1) raw.push(sample(d * 1440 + i));
  r.close(raw, Date.parse(at(94 * 1440 + 100)));
  await r.flush();
  const days = listDays(dir);
  assert.equal(days.length, 91, '90 dias + o dia de referência');
  assert.equal(days[0], dayOf(BASE + 4 * DAY_MS));
  const q = r.query(BASE + 93 * DAY_MS, BASE + 94 * DAY_MS + ROLLUP_STEP_MS);
  assert.deepEqual(q.map((b) => b.t), [
    BASE + 93 * DAY_MS, BASE + 93 * DAY_MS + ROLLUP_STEP_MS,
    BASE + 94 * DAY_MS, BASE + 94 * DAY_MS + ROLLUP_STEP_MS,
  ]);
  assert.ok(r.sizeBytes() > 0);
});

test('RollupStore: linha cortada e lixo são ignorados; writeBucketsSync mescla por t', () => {
  const dir = tmp();
  const file = path.join(dir, `${dayOf(at(0))}.ndjson`);
  fs.writeFileSync(file, `${JSON.stringify({ t: BASE, n: 1, m: { tempC: [1, 1, 1] } })}\n{"t":1,"n":"x"}\n{"t":`);
  const r = new RollupStore({ dir, log: silent });
  assert.equal(r.lastT, BASE);
  r.writeBucketsSync([{ t: BASE, n: 2, m: { tempC: [5, 5, 5] } }, { t: BASE + ROLLUP_STEP_MS, n: 1, m: {} }], writeFileAtomicSync);
  assert.deepEqual(r.query(0, BASE + DAY_MS).map((b) => [b.t, b.n]), [[BASE, 2], [BASE + ROLLUP_STEP_MS, 1]]);
  assert.equal(r.lastT, BASE + ROLLUP_STEP_MS);
  assert.equal(new RollupStore({ dir: path.join(dir, 'nada'), log: silent }).lastT, -Infinity);
});

test('History: 1 amostra por minuto gera bruto + agregados; recarrega igual', async () => {
  const dataDir = tmp();
  const h = new History({ dataDir, log: silent });
  for (let i = 0; i < 30; i++) h.append(sample(i, i === 17 ? 90 : 40));
  await h.flush();
  assert.equal(h.length, 30);
  assert.equal(h.getLatest().ts, at(29));
  assert.equal(listDays(path.join(dataDir, 'history')).length, 1);
  assert.equal(readNdjson(path.join(dataDir, 'rollup', `${dayOf(at(0))}.ndjson`)).items.length, 5, '25 min fechados');
  const h2 = new History({ dataDir, log: silent });
  assert.equal(h2.length, 30);
  assert.equal(h2.rollup.lastT, BASE + 4 * ROLLUP_STEP_MS);
  assert.equal(h2.getSamples(5).length, 5);
  assert.equal(h2.getRange(at(10), at(11)).length, 2);
  assert.equal(h2.limit, 4320);
  assert.equal(h2.samples.length, 30);
});

test('History: reinício depois de parado fecha os baldes pendentes', async () => {
  const dataDir = tmp();
  const h = new History({ dataDir, log: silent });
  for (let i = 0; i < 8; i++) h.raw.append(sample(i)); // grava só o bruto (simula queda antes do rollup)
  await h.flush();
  const h2 = new History({ dataDir, log: silent });
  await h2.flush();
  assert.equal(h2.rollup.lastT, BASE, 'balde 00–05 fechado no boot');
});

test('History.buckets: dentro da janela bruta usa amostras de 1 min e preserva o pico', () => {
  const h = new History({ dataDir: tmp(), log: silent });
  for (let i = 0; i < 120; i++) h.append(sample(i, i === 61 ? 95 : 40));
  const r = h.buckets({ fromMs: BASE, toMs: Date.parse(at(119)), maxPoints: 60 });
  assert.equal(r.step, 2 * MIN);
  assert.equal(r.buckets.length, 60);
  assert.equal(Math.max(...r.buckets.map((b) => b.m.tempC[1])), 95);
  assert.equal(r.from, at(0));
  const tiny = h.buckets({ fromMs: BASE, toMs: Date.parse(at(9)), maxPoints: 720 });
  assert.equal(tiny.step, MIN, 'passo mínimo de 1 min');
  assert.equal(tiny.buckets.length, 10);
});

test('History.buckets: antes da janela bruta junta agregados + bruto sem sobrepor', async () => {
  const dataDir = tmp();
  const h = new History({ dataDir, retentionMs: 2 * HOUR_MS, log: silent });
  for (let i = 0; i < 6 * 60; i++) h.append(sample(i, i === 30 ? 99 : 40));
  await h.flush();
  const rawStart = Date.parse(h.samples[0].ts);
  assert.ok(rawStart > BASE + 3 * HOUR_MS, 'bruto só guarda as últimas 2 h');
  const r = h.buckets({ fromMs: BASE, toMs: Date.parse(at(6 * 60 - 1)), maxPoints: 1000 });
  assert.equal(r.step, ROLLUP_STEP_MS, 'passo vira múltiplo de 5 min');
  const ts = r.buckets.map((b) => b.t);
  assert.deepEqual(ts, [...new Set(ts)].sort((a, b) => a - b), 'sem baldes repetidos');
  assert.equal(r.buckets.length, 72, '6 h em baldes de 5 min');
  assert.equal(r.buckets.reduce((n, b) => n + b.n, 0), 360, 'cada amostra contada uma vez');
  assert.equal(r.buckets[6].m.tempC[1], 99, 'pico antigo veio dos agregados');
  const big = h.buckets({ fromMs: BASE, toMs: Date.parse(at(359)), maxPoints: 10 });
  assert.equal(big.step % ROLLUP_STEP_MS, 0);
  assert.ok(big.buckets.length <= 10);
});

test('History.buckets: sem dados devolve lista vazia; maxPoints é limitado', () => {
  const h = new History({ dataDir: tmp(), log: silent });
  const r = h.buckets({ fromMs: BASE, toMs: BASE + DAY_MS, maxPoints: 999999 });
  assert.deepEqual(r.buckets, []);
  assert.equal(r.step, ROLLUP_STEP_MS);
  h.append({ host: 'sem ts' });
  assert.equal(h.length, 0);
});
