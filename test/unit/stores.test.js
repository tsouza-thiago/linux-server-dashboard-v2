import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AlertsStore } from '../../server/stores.js';

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  const store = new AlertsStore({ file: path.join(dir, 'alerts.json') });
  return { store, dir };
}

test('AlertsStore: ciclo de vida new -> ack -> resolved', () => {
  const { store, dir } = tempStore();
  try {
    const a = store.add({ level: 'warning', message: 'Disco / em 92%' });
    assert.equal(a.status, 'new');
    assert.equal(store.active.length, 1);

    store.setStatus(a.id, 'ack');
    assert.equal(store.active.length, 1);
    assert.equal(store.active[0].status, 'ack');

    store.setStatus(a.id, 'resolved');
    assert.equal(store.active.length, 0);
    assert.equal(store.list({})[0].status, 'resolved');
    assert.ok(store.list({})[0].resolvedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.reconcile resolve o que sumiu e mantém o ativo', () => {
  const { store, dir } = tempStore();
  try {
    store.reconcile([{ level: 'warning', message: 'Disco / em 92%' }]);
    assert.equal(store.active.length, 1);

    store.reconcile([{ level: 'warning', message: 'Disco / em 92%' }]);
    assert.equal(store.active.length, 1, 'não duplica condição ativa');

    store.reconcile([]);
    assert.equal(store.active.length, 0, 'condição sumiu -> auto-resolve');
    assert.equal(store.list({})[0].status, 'resolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore persiste e recarrega', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  try {
    const file = path.join(dir, 'alerts.json');
    const a1 = new AlertsStore({ file });
    a1.add({ level: 'critical', message: 'SMART /dev/sda: FAILED' });
    await a1.flush();

    const a2 = new AlertsStore({ file });
    assert.equal(a2.active.length, 1);
    assert.equal(a2.active[0].message, 'SMART /dev/sda: FAILED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});