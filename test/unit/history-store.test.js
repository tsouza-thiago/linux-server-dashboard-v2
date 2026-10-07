import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../../server/history.js';

function tempFile(name = 'history.json', content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-hist-'));
  const file = path.join(dir, name);
  if (content !== undefined) writeFileSync(file, content);
  return { dir, file };
}

function sample(ts, v = 1) {
  return { ts, load: [v], ram: { total: 1000, used: v }, disks: [] };
}

test('HistoryStore: append grava e recarrega', async () => {
  const { dir, file } = tempFile();
  try {
    const s1 = new HistoryStore({ file, limit: 100 });
    s1.append(sample('2026-08-15T09:00:00.000Z', 1));
    s1.append(sample('2026-08-15T09:01:00.000Z', 2));
    await s1.flush();

    const s2 = new HistoryStore({ file, limit: 100 });
    assert.equal(s2.length, 2);
    assert.equal(s2.getLatest().ts, '2026-08-15T09:01:00.000Z');
    assert.equal(s2.getLatest().load[0], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HistoryStore: limite FIFO descarta os mais antigos', () => {
  const { dir, file } = tempFile();
  try {
    const s = new HistoryStore({ file, limit: 5 });
    for (let i = 0; i < 10; i++) s.append(sample(`2026-08-15T0${i}:00:00.000Z`, i));
    assert.equal(s.length, 5);
    assert.equal(s.samples[0].load[0], 5);
    assert.equal(s.getLatest().load[0], 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HistoryStore: carrega array puro e objeto com samples', () => {
  const { dir, file } = tempFile('history.json', JSON.stringify([sample('2026-08-15T09:00:00.000Z')]));
  try {
    assert.equal(new HistoryStore({ file }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const { dir: dir2, file: file2 } = tempFile('history.json', JSON.stringify({ samples: [sample('2026-08-15T09:00:00.000Z')] }));
  try {
    assert.equal(new HistoryStore({ file: file2 }).length, 1);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('HistoryStore: arquivo corrompido ou ausente vira lista vazia', () => {
  const { dir, file } = tempFile('history.json', '{{{{nao é json');
  try {
    const s = new HistoryStore({ file });
    assert.equal(s.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const { dir: dir2, file: file2 } = tempFile('history.json');
  try {
    const s = new HistoryStore({ file: file2 });
    assert.equal(s.length, 0);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('HistoryStore: ignora entradas sem ts e ordena', () => {
  const { dir, file } = tempFile('history.json', JSON.stringify([
    sample('2026-08-15T09:02:00.000Z', 2),
    { foo: 'sem ts' },
    sample('2026-08-15T09:00:00.000Z', 0),
    sample('2026-08-15T09:01:00.000Z', 1),
  ]));
  try {
    const s = new HistoryStore({ file });
    assert.equal(s.length, 3);
    assert.equal(s.samples[0].load[0], 0);
    assert.equal(s.samples[2].load[0], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HistoryStore: getSamples e getRange', () => {
  const { dir, file } = tempFile();
  try {
    const s = new HistoryStore({ file, limit: 100 });
    for (let i = 0; i < 10; i++) {
      s.append(sample(`2026-08-15T09:0${i}:00.000Z`, i));
    }
    assert.equal(s.getSamples(3).length, 3);
    assert.equal(s.getSamples(3)[0].load[0], 7);

    const ranged = s.getRange('2026-08-15T09:03:00.000Z', '2026-08-15T09:05:00.000Z');
    assert.deepEqual(ranged.map((x) => x.load[0]), [3, 4, 5]);

    const fromOnly = s.getRange('2026-08-15T09:08:00.000Z');
    assert.equal(fromOnly.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HistoryStore: escrita é atômica e com permissões 0600', async () => {
  const { dir, file } = tempFile();
  try {
    const s = new HistoryStore({ file, limit: 10 });
    s.append(sample('2026-08-15T09:00:00.000Z'));
    await s.flush();
    assert.ok(existsSync(file));
    assert.ok(!existsSync(`${file}.tmp`), 'arquivo temporário deve ser removido');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HistoryStore: getRange aplica downsample acima do limite', () => {
  const { dir, file } = tempFile();
  try {
    const s = new HistoryStore({ file, limit: 10000 });
    for (let i = 0; i < 1000; i++) s.append(sample(`2026-08-15T09:${String(i).padStart(2, '0')}:00.000Z`, i));
    const ranged = s.getRange(undefined, undefined, 50);
    assert.ok(ranged.length <= 51);
    assert.equal(ranged[ranged.length - 1].load[0], 999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});