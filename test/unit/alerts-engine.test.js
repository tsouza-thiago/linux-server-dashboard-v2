import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlertEngine } from '../../server/alerts/engine.js';
import { AlertsStore } from '../../server/stores.js';
import { OutageLog } from '../../server/storage/outages.js';

const MIN = 60000;
const BASE = Date.UTC(2026, 9, 7, 12, 0);
const T = { diskPct: 90, ramPct: 90, tempC: 60, hysteresis: 5, offlineAfter: 2 };

function setup({ thresholds = T, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-eng-')) } = {}) {
  let t = BASE;
  const now = () => t;
  const alerts = new AlertsStore({ file: path.join(dir, 'alerts.json'), now });
  const outages = new OutageLog({ file: path.join(dir, 'outages.ndjson'), now });
  const engine = new AlertEngine({ alerts, outages, thresholds, now });
  const tick = () => { t += MIN; return new Date(t).toISOString(); };
  return { engine, alerts, outages, tick, dir, now };
}
const sample = (ts, over = {}) => ({ ts, host: 'srv', cores: 1, load: [0.1, 0.1, 0.1], ram: { total: 1000, used: 400 }, tempC: 40, disks: [{ mount: '/', pct: 10 }], smart: [], services: { smbd: 'active' }, ...over });

test('motor: 1 falha isolada não alerta nem abre queda (debounce)', () => {
  const { engine, alerts, outages, tick } = setup();
  engine.onSample(sample(tick()));
  assert.deepEqual(engine.onFailure('timeout'), { offline: false, failures: 1 });
  engine.onSample(sample(tick()));
  assert.equal(alerts.data.length, 0);
  assert.equal(outages.list().length, 0);
  assert.equal(engine.health(sample(tick())).score, 100);
});

test('motor: 2 falhas seguidas abrem UM alerta e UMA queda desde a 1ª falha; volta resolve e fecha', () => {
  const { engine, alerts, outages, tick } = setup();
  engine.onSample(sample(tick()));
  tick();
  const firstFailure = new Date(BASE + 2 * MIN).toISOString();
  engine.onFailure('Tempo esgotado');
  tick();
  assert.equal(engine.onFailure('Conexão recusada').offline, true);
  for (let i = 0; i < 5; i++) { tick(); engine.onFailure(`erro ${i}`); }
  assert.equal(alerts.active.length, 1);
  assert.equal(alerts.active[0].key, 'servidor-inacessivel');
  assert.equal(alerts.active[0].message, 'Servidor inacessível: erro 4', 'mensagem atualizada no mesmo alerta');
  assert.equal(engine.offlineSince, firstFailure);
  assert.deepEqual(engine.health(null).parts.map((p) => p.label), ['Servidor offline']);
  const backAt = tick();
  engine.onSample(sample(backAt));
  assert.equal(alerts.active.length, 0);
  assert.equal(engine.offline, false);
  assert.equal(engine.offlineSince, null);
  const [o] = outages.list();
  assert.deepEqual([o.from, o.to, o.reason], [firstFailure, backAt, 'Tempo esgotado']);
});

test('motor: durante a queda os outros alertas abertos ficam como estão', () => {
  const { engine, alerts, tick } = setup();
  engine.onSample(sample(tick(), { tempC: 65 }));
  engine.onFailure('x');
  engine.onFailure('x');
  assert.deepEqual(alerts.active.map((a) => a.key).sort(), ['servidor-inacessivel', 'temp:cpu']);
  engine.onSample(sample(tick(), { tempC: 50 }));
  assert.equal(alerts.active.length, 0);
});

test('motor: histerese aplicada entre coletas (flapping de disco não abre/fecha a cada poll)', () => {
  const { engine, alerts, tick } = setup();
  for (const pct of [90, 88, 91, 86, 89, 90, 87]) engine.onSample(sample(tick(), { disks: [{ mount: '/', pct }] }));
  assert.equal(alerts.data.length, 1, 'um único alerta durante toda a oscilação');
  assert.equal(alerts.active[0].message, 'Disco / com 87% usado');
  engine.onSample(sample(tick(), { disks: [{ mount: '/', pct: 85 }] }));
  assert.equal(alerts.active.length, 0);
});

test('motor: offlineAfter configurável e reinício no meio de uma queda continua offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-eng-'));
  const a = setup({ thresholds: { ...T, offlineAfter: 1 }, dir });
  assert.equal(a.engine.onFailure('x').offline, true, '1 falha basta com ALERT_OFFLINE_AFTER=1');
  await Promise.all([a.outages.flush(), a.alerts.flush()]);
  const b = setup({ dir });
  assert.equal(b.engine.offline, true, 'queda aberta no log');
  assert.equal(b.engine.offlineSince, new Date(BASE).toISOString());
  assert.equal(b.engine.onFailure('y').offline, true, 'segue offline já na 1ª falha após reiniciar');
  b.engine.onSample(sample(new Date(BASE + 10 * MIN).toISOString()));
  assert.equal(b.outages.list()[0].durationSec, 600);
});
