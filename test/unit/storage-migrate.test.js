import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateV1, inspectV1, describe, BACKUP_NAME } from '../../server/storage/migrate-v1.js';
import { History } from '../../server/storage/index.js';
import { ROLLUP_STEP_MS } from '../../server/storage/rollup.js';
import { listDays, readNdjson, dayOf, HOUR_MS } from '../../server/storage/ndjson.js';

const MIN = 60000;
const BASE = Date.UTC(2026, 9, 1, 0, 0);
const at = (min) => new Date(BASE + min * MIN).toISOString();
// Amostra no formato da V1 (sem schemaVersion, sem cpu/psi).
const v1 = (min, tempC = 40) => ({
  ts: at(min), host: 'srv', load: [0.1, 0.2, 0.3], tempC,
  ram: { total: 840, used: 400, free: 100, cache: 300, avail: 440, swapTotal: 885, swapUsed: 0 },
  disks: [{ mount: '/', size: '145G', used: '2.5G', avail: '135G', pct: 2, sizeBytes: 1, usedBytes: 1, availBytes: 1 }],
  net: { rxBytes: 1, txBytes: 1, rxMbps: 0, txMbps: 0 },
});

function setup(content) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-mig-'));
  const v1File = path.join(dataDir, 'history.json');
  if (content !== undefined) fs.writeFileSync(v1File, typeof content === 'string' ? content : JSON.stringify(content));
  return { dataDir, v1File };
}

test('migração: sem arquivo da V1 não faz nada', () => {
  const { dataDir, v1File } = setup();
  assert.equal(migrateV1({ v1File, dataDir }).status, 'ausente');
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test('migração: arquivo ilegível é deixado intacto', () => {
  for (const bad of ['{{{ não é json', JSON.stringify({ outra: 1 })]) {
    const { dataDir, v1File } = setup(bad);
    const r = migrateV1({ v1File, dataDir });
    assert.equal(r.status, 'invalido');
    assert.equal(fs.readFileSync(v1File, 'utf8'), bad, 'original não muda');
    assert.deepEqual(fs.readdirSync(dataDir), ['history.json']);
    assert.match(describe(r, dataDir), /não pôde ser lido[\s\S]*não foi alterado/);
  }
  const { dataDir } = setup();
  assert.equal(inspectV1(dataDir).status, 'invalido', 'pasta no lugar do arquivo');
});

test('migração --verificar: resume sem gravar nada', () => {
  const list = [v1(0), v1(1), { host: 'sem ts' }, v1(1), { ts: 'ontem' }];
  const { dataDir, v1File } = setup({ samples: list });
  const r = migrateV1({ v1File, dataDir, dryRun: true });
  assert.equal(r.status, 'verificado');
  assert.equal(r.samples.length, 2, 'duplicado por ts conta 1 vez');
  assert.equal(r.invalid, 2);
  assert.equal(r.total, 5);
  assert.equal(r.from, at(0));
  assert.equal(r.to, at(1));
  assert.deepEqual(fs.readdirSync(dataDir), ['history.json']);
  const text = describe(r, dataDir);
  assert.match(text, /amostras válidas: 2 \(inválidas ignoradas: 2\)/);
  assert.match(text, /Nada foi gravado/);
});

test('migração: grava bruto (72 h) + agregados de todo o período e só então faz o backup', async () => {
  const minutes = 5 * 24 * 60; // 5 dias de V1 a 1/min
  const list = Array.from({ length: minutes }, (_, i) => v1(i, i === 60 ? 77 : 40));
  const { dataDir, v1File } = setup(list.slice().reverse());
  const r = migrateV1({ v1File, dataDir });
  assert.equal(r.status, 'migrado');
  assert.ok(!fs.existsSync(v1File), 'arquivo da V1 virou backup');
  assert.equal(r.backup, path.join(dataDir, BACKUP_NAME));
  assert.equal(fs.statSync(r.backup).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(r.backup, 'utf8')).length, minutes, 'backup é o arquivo original inteiro');

  const rawDays = listDays(path.join(dataDir, 'history'));
  const latest = Date.parse(at(minutes - 1));
  assert.equal(rawDays[0], dayOf(latest - 72 * HOUR_MS), 'só os dias da janela bruta');
  assert.equal(r.rawDays, rawDays.length);
  assert.equal(r.rollupBuckets, minutes / 5 - 1, 'todos os baldes menos o último (aberto)');
  const firstRollup = readNdjson(path.join(dataDir, 'rollup', `${dayOf(at(0))}.ndjson`)).items;
  assert.equal(firstRollup[12].m.tempC[1], 77, 'pico do 1º dia preservado nos agregados');

  const h = new History({ dataDir, log: () => {} });
  await h.flush();
  assert.equal(h.getLatest().ts, at(minutes - 1));
  assert.equal(h.length, 4320, '72 h a 1/min, limitado pelo HISTORY_LIMIT');
  assert.equal(h.rollup.lastT, Math.floor(latest / ROLLUP_STEP_MS) * ROLLUP_STEP_MS - ROLLUP_STEP_MS);
  const week = h.buckets({ fromMs: BASE, toMs: latest, maxPoints: 2000 });
  assert.equal(week.buckets.reduce((n, b) => n + b.n, 0), minutes, 'cada amostra da V1 aparece uma vez');
  assert.match(describe(r, dataDir), /Backup do arquivo original: history\.v1-migrado\.json/);
});

test('migração: rodar de novo (queda antes do backup) não duplica nada', () => {
  const list = Array.from({ length: 30 }, (_, i) => v1(i));
  const { dataDir, v1File } = setup(list);
  const copy = fs.readFileSync(v1File, 'utf8');
  migrateV1({ v1File, dataDir });
  const snapshot = () => ['history', 'rollup'].map((d) => listDays(path.join(dataDir, d))
    .map((day) => fs.readFileSync(path.join(dataDir, d, `${day}.ndjson`), 'utf8')).join('|'));
  const first = snapshot();
  fs.writeFileSync(v1File, copy); // simula a V1 ainda presente
  const again = migrateV1({ v1File, dataDir });
  assert.deepEqual(snapshot(), first);
  assert.notEqual(again.backup, path.join(dataDir, BACKUP_NAME), 'backup anterior preservado');
  assert.ok(again.backup.includes('history.v1-migrado-'));
  assert.ok(fs.existsSync(path.join(dataDir, BACKUP_NAME)));
});

test('migração: mescla com dados da V2 do mesmo dia', async () => {
  const { dataDir, v1File } = setup([v1(0), v1(1)]);
  const h = new History({ dataDir, log: () => {} });
  h.append({ ...v1(2), schemaVersion: 2 });
  await h.flush();
  migrateV1({ v1File, dataDir });
  const items = readNdjson(path.join(dataDir, 'history', `${dayOf(at(0))}.ndjson`)).items;
  assert.deepEqual(items.map((s) => s.ts), [at(0), at(1), at(2)]);
});

test('migração: lista vazia da V1 vira só o backup', () => {
  const { dataDir, v1File } = setup([]);
  const r = migrateV1({ v1File, dataDir });
  assert.equal(r.status, 'migrado');
  assert.equal(r.rawDays, 0);
  assert.equal(r.rollupBuckets, 0);
  assert.match(describe(r, dataDir), /período: — → — \(0 dia\(s\)\)/);
});
