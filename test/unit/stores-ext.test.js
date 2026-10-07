import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore, AlertsStore, AnnotationsStore } from '../../server/stores.js';

function tempFile(name, content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-store-'));
  const file = path.join(dir, name);
  if (content !== undefined) writeFileSync(file, content);
  return { dir, file };
}

test('JsonStore: usa defaults quando arquivo ausente', () => {
  const { dir, file } = tempFile('s.json');
  try {
    const s = new JsonStore({ file, defaults: [1] });
    assert.deepEqual(s.data, [1], 'defaults mantidos quando arquivo ausente');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonStore: sobrescreve defaults com conteúdo do arquivo', () => {
  const { dir, file } = tempFile('s.json', JSON.stringify([{ a: 1 }]));
  try {
    const s = new JsonStore({ file, defaults: [999] });
    assert.equal(s.data.length, 1);
    assert.equal(s.data[0].a, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonStore: dados não-array viram lista vazia', () => {
  const { dir, file } = tempFile('s.json', JSON.stringify({ not: 'array' }));
  try {
    const s = new JsonStore({ file });
    assert.deepEqual(s.data, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonStore: save é atômico (sem .tmp residual)', async () => {
  const { dir, file } = tempFile('s.json');
  try {
    const s = new JsonStore({ file });
    s.data = [{ a: 1 }];
    await s.save();
    assert.ok(existsSync(file));
    assert.ok(!existsSync(`${file}.tmp`));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AnnotationsStore: adiciona, trunca e remove', () => {
  const { dir, file } = tempFile('annotations.json');
  try {
    const s = new AnnotationsStore({ file });
    const a = s.add({ ts: '2026-08-15T09:00:00.000Z', text: 'x'.repeat(600), label: 'y'.repeat(120) });
    assert.equal(a.text.length, 500);
    assert.equal(a.label.length, 80);
    assert.ok(a.id);

    assert.equal(s.remove(a.id), true);
    assert.equal(s.remove(a.id), false);
    assert.equal(s.data.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AnnotationsStore: persiste e recarrega', async () => {
  const { dir, file } = tempFile('annotations.json');
  try {
    const s1 = new AnnotationsStore({ file });
    s1.add({ ts: '2026-08-15T09:00:00.000Z', text: 'manutenção', label: 'manut' });
    await s1.flush();
    const s2 = new AnnotationsStore({ file });
    assert.equal(s2.data.length, 1);
    assert.equal(s2.data[0].text, 'manutenção');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.list filtra por status, level e limit', () => {
  const { dir, file } = tempFile('alerts.json');
  try {
    const s = new AlertsStore({ file });
    const w = s.add({ level: 'warning', message: 'Disco / em 90%' });
    const c = s.add({ level: 'critical', message: 'SMART FAILED' });
    s.setStatus(c.id, 'resolved');

    assert.equal(s.list({ status: 'warning' }).length, 0);
    assert.equal(s.list({ status: 'new' }).length, 1);
    assert.equal(s.list({ level: 'critical' }).length, 1);
    assert.equal(s.list({ limit: 1 }).length, 1);
    assert.equal(s.list({ limit: 1 })[0].message, 'SMART FAILED', 'mais recente primeiro');
    assert.equal(s.list({ status: 'resolved', level: 'critical' }).length, 1);
    assert.equal(w.message, 'Disco / em 90%');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.trim respeita o max', () => {
  const { dir, file } = tempFile('alerts.json');
  try {
    const s = new AlertsStore({ file, max: 3 });
    for (let i = 0; i < 6; i++) s.add({ level: 'warning', message: `alerta ${i}` });
    assert.equal(s.data.length, 3);
    assert.equal(s.data[0].message, 'alerta 3');
    assert.equal(s.data[2].message, 'alerta 5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.setStatus retorna null para id inexistente', () => {
  const { dir, file } = tempFile('alerts.json');
  try {
    const s = new AlertsStore({ file });
    assert.equal(s.setStatus('nao-existe', 'ack'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.reconcile deduplica por mensagem (mantém primeiro nível)', () => {
  const { dir, file } = tempFile('alerts.json');
  try {
    const s = new AlertsStore({ file });
    s.reconcile([{ level: 'warning', message: 'Mesma condição' }]);
    s.reconcile([{ level: 'critical', message: 'Mesma condição' }]);
    assert.equal(s.active.length, 1, 'mesma mensagem não duplica');
    assert.equal(s.active[0].level, 'warning');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});