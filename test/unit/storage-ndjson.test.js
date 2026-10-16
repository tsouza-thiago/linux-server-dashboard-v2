// Histórico bruto em NDJSON: 1 linha por amostra (B7), virada do dia e janela de 72 h.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RawStore, readNdjson, listDays, dayOf, writeFileAtomicSync, HOUR_MS } from '../../server/storage/ndjson.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-raw-'));
const MIN = 60000;
const BASE = Date.UTC(2026, 9, 7, 12, 0);
const at = (min) => new Date(BASE + min * MIN).toISOString();
const sample = (min, extra = {}) => ({ ts: at(min), host: 'srv', load: [0.1, 0.1, 0.1], ...extra });
const silent = () => {};

test('RawStore: grava 1 linha por amostra no arquivo do dia e recarrega', async () => {
  const dir = tmp();
  const s1 = new RawStore({ dir, log: silent });
  s1.append(sample(0));
  s1.append(sample(1));
  await s1.flush();
  const file = path.join(dir, `${dayOf(at(0))}.ndjson`);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const s2 = new RawStore({ dir, log: silent });
  assert.deepEqual(s2.samples.map((s) => s.ts), [at(0), at(1)]);
  assert.equal(s2.getLatest().ts, at(1));
});

test('B7 — gravar uma amostra só acrescenta a linha dela (não reescreve o histórico)', async () => {
  const dir = tmp();
  const store = new RawStore({ dir, limit: 5000, log: silent });
  const big = { topProcs: Array(8).fill({ user: 'root', pid: 1, cpu: 0, mem: 0.3, cmd: '/usr/sbin/smbd --foreground' }) };
  for (let i = 0; i < 2000; i++) store.append(sample(i, big));
  await store.flush();
  const sizeOf = () => listDays(dir).reduce((n, d) => n + fs.statSync(path.join(dir, `${d}.ndjson`)).size, 0);
  const before = sizeOf();
  const firstFile = path.join(dir, `${listDays(dir)[0]}.ndjson`);
  const head = fs.readFileSync(firstFile, 'utf8').slice(0, 2000);
  const extra = sample(2000, big);
  store.append(extra);
  await store.flush();
  assert.equal(sizeOf() - before, Buffer.byteLength(`${JSON.stringify(extra)}\n`));
  assert.equal(fs.readFileSync(firstFile, 'utf8').slice(0, 2000), head, 'conteúdo antigo intacto');
});

test('RawStore: vira o dia em outro arquivo; janela de 72 h conta da amostra mais recente', async () => {
  const dir = tmp();
  const store = new RawStore({ dir, retentionMs: 72 * HOUR_MS, log: silent });
  for (let h = 0; h <= 100; h += 1) store.append(sample(h * 60));
  await store.flush();
  const latest = Date.parse(store.getLatest().ts);
  assert.ok(store.samples.every((s) => Date.parse(s.ts) >= latest - 72 * HOUR_MS));
  assert.equal(store.length, 73, '72 h + a amostra da borda');
  const reloaded = new RawStore({ dir, retentionMs: 72 * HOUR_MS, log: silent });
  assert.equal(reloaded.length, 73);
  assert.equal(reloaded.samples[0].ts, store.samples[0].ts);
});

test('RawStore: apaga arquivos de dias que saíram inteiros da janela', async () => {
  const dir = tmp();
  const store = new RawStore({ dir, retentionMs: 24 * HOUR_MS, log: silent });
  for (let d = 0; d < 5; d += 1) store.append(sample(d * 24 * 60));
  await store.flush();
  const days = listDays(dir);
  assert.deepEqual(days, [dayOf(at(3 * 24 * 60)), dayOf(at(4 * 24 * 60))]);
});

test('RawStore: limite de amostras em memória (HISTORY_LIMIT) é FIFO', () => {
  const store = new RawStore({ dir: tmp(), limit: 5, log: silent });
  for (let i = 0; i < 8; i++) store.append(sample(i));
  assert.equal(store.length, 5);
  assert.equal(store.samples[0].ts, at(3));
});

test('RawStore: linha cortada por queda é ignorada e a próxima gravação começa em linha nova', async () => {
  const dir = tmp();
  const file = path.join(dir, `${dayOf(at(0))}.ndjson`);
  fs.writeFileSync(file, `${JSON.stringify(sample(0))}\n{"ts":"${at(1)}","ho`);
  const logs = [];
  const store = new RawStore({ dir, log: (m) => logs.push(m) });
  assert.equal(store.length, 1);
  assert.match(logs.join('\n'), /1 linha\(s\) inválida\(s\)/);
  store.append(sample(2));
  await store.flush();
  const again = new RawStore({ dir, log: silent });
  assert.deepEqual(again.samples.map((s) => s.ts), [at(0), at(2)]);
});

test('RawStore: ignora amostras sem ts válido, ordena ao carregar e tolera pasta ausente', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, `${dayOf(at(0))}.ndjson`), [sample(5), { host: 'x' }, { ts: 'ontem' }, sample(1)].map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'outro.txt'), 'não é dia');
  const store = new RawStore({ dir, log: silent });
  assert.deepEqual(store.samples.map((s) => s.ts), [at(1), at(5)]);
  store.append({ host: 'sem ts' });
  assert.equal(store.length, 2);
  const none = new RawStore({ dir: path.join(dir, 'nao-existe'), log: silent });
  assert.equal(none.length, 0);
  assert.equal(none.getLatest(), null);
});

test('RawStore: getSamples e getRange (com redução que preserva picos)', () => {
  const store = new RawStore({ dir: tmp(), log: silent });
  for (let i = 0; i < 50; i++) store.append(sample(i, { tempC: i === 33 ? 90 : 40 }));
  assert.equal(store.getSamples(10).length, 10);
  assert.deepEqual(store.getRange(at(10), at(12)).map((s) => s.ts), [at(10), at(11), at(12)]);
  const reduced = store.getRange(undefined, undefined, 10);
  assert.ok(reduced.length <= 10);
  assert.ok(reduced.some((s) => s.tempC === 90));
});

test('RawStore: falha de gravação é registrada sem derrubar o poll', async () => {
  const dir = tmp();
  const blocker = path.join(dir, 'arquivo');
  fs.writeFileSync(blocker, 'x');
  const logs = [];
  const store = new RawStore({ dir: path.join(blocker, 'sub'), log: (m) => logs.push(m) });
  store.append(sample(0));
  await store.flush();
  assert.equal(store.length, 1, 'amostra continua em memória');
  assert.match(logs.join('\n'), /falha ao gravar/);
});

test('readNdjson e writeFileAtomicSync', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'x.ndjson');
  writeFileAtomicSync(file, '{"a":1}\n\n{"a":2}\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readNdjson(file), { items: [{ a: 1 }, { a: 2 }], bad: 0, torn: false });
  assert.deepEqual(readNdjson(path.join(dir, 'nada.ndjson')), { items: [], bad: 0, torn: false });
  assert.throws(() => readNdjson(dir), /EISDIR/);
});

test('RAM (orçamento de desempenho): só a amostra mais recente guarda os processos, em memória e depois de reiniciar; o disco guarda tudo', async () => {
  const dir = tmp();
  const procs = { topProcs: [{ user: 'root', pid: 1, cpu: 0, mem: 1, rssKB: 10, cmd: '/sbin/init' }] };
  const store = new RawStore({ dir, log: silent });
  for (let i = 0; i < 3; i++) store.append(sample(i, procs));
  assert.deepEqual(store.samples.map((s) => 'topProcs' in s), [false, false, true]);
  assert.deepEqual(store.getLatest().topProcs, procs.topProcs);
  assert.equal(store.samples[0].load[0], 0.1, 'o resto da amostra antiga continua igual');
  await store.flush();
  // Amostra de outro dia (o fim de cada arquivo diário não pode ficar com processos).
  store.append(sample(24 * 60, procs));
  await store.flush();
  const lines = listDays(dir).flatMap((d) => fs.readFileSync(path.join(dir, `${d}.ndjson`), 'utf8').trim().split('\n'));
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => JSON.parse(l).topProcs), 'o NDJSON continua com a amostra inteira');
  const again = new RawStore({ dir, log: silent });
  assert.deepEqual(again.samples.map((s) => 'topProcs' in s), [false, false, false, true]);
  assert.equal(again.getLatest().ts, at(24 * 60));
});

test('readNdjson: lê em blocos (linha e UTF-8 cortados entre blocos), map, linha inválida e arquivo cortado', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.ndjson');
  const long = 'ç'.repeat(700_000); // ~1,4 MB: a linha atravessa o bloco de 1 MB no meio de um caractere
  fs.writeFileSync(file, `${JSON.stringify({ a: 1 })}\n{quebrada\n${JSON.stringify({ a: 2, s: long })}\n${JSON.stringify({ a: 3 })}`);
  const r = readNdjson(file, { map: (o, i) => ({ ...o, i }) });
  assert.deepEqual(r.items.map((o) => [o.a, o.i]), [[1, 0], [2, 1], [3, 2]]);
  assert.equal(r.items[1].s, long);
  assert.equal(r.bad, 1);
  assert.equal(r.torn, true);
  fs.appendFileSync(file, '\n');
  assert.equal(readNdjson(file).torn, false);
  assert.deepEqual(readNdjson(path.join(dir, 'nada.ndjson')), { items: [], bad: 0, torn: false });
});
