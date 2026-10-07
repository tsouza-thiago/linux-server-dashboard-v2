import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, rulesFor, ramPct, OFFLINE_KEY } from '../../server/alerts/rules.js';
import { healthScore } from '../../server/alerts/health.js';
import { computeAlerts } from '../../server/poller.js';

const T = { diskPct: 90, ramPct: 90, tempC: 60, hysteresis: 5, offlineAfter: 2 };
const base = (over = {}) => ({
  ts: '2026-10-07T12:00:00.000Z', host: 'srv', cores: 1, load: [0.2, 0.2, 0.2],
  ram: { total: 1000, used: 400 }, tempC: 40,
  disks: [{ mount: '/', pct: 10 }, { mount: '/mnt/dados', pct: 50 }],
  smart: [{ dev: 'sda', status: 'PASSED' }], services: { smbd: 'active' },
  ...over,
});
const keys = (r) => r.conditions.map((c) => c.key).sort();

test('chaves estáveis por condição: o valor muda, a chave não (B3)', () => {
  const a = evaluate(base({ tempC: 61.2 }), T).conditions[0];
  const b = evaluate(base({ tempC: 63.9 }), T).conditions[0];
  assert.equal(a.key, 'temp:cpu');
  assert.equal(b.key, a.key);
  assert.notEqual(b.message, a.message);
  assert.equal(b.value, 63.9);
  assert.equal(b.level, 'warning');
});

test('todas as regras com limiar padrão; nada dispara numa amostra saudável', () => {
  assert.deepEqual(evaluate(base(), T).conditions, []);
  const bad = base({
    ram: { total: 1000, used: 950 }, tempC: 75,
    disks: [{ mount: '/', pct: 91 }, { mount: '/mnt/dados', pct: 89 }],
    smart: [{ dev: 'sda', status: 'FAILED' }, { dev: 'sdb', status: 'SEM_PERMISSAO' }],
    services: { smbd: 'failed', nmbd: 'inactive', docker: 'activating', x: 'desconhecido' },
  });
  const r = evaluate(bad, T);
  assert.deepEqual(keys(r), ['disk:/:usage', 'ram:usage', 'service:nmbd', 'service:smbd', 'smart:sda', 'temp:cpu']);
  const byKey = Object.fromEntries(r.conditions.map((c) => [c.key, c]));
  assert.equal(byKey['disk:/:usage'].message, 'Disco / com 91% usado');
  assert.equal(byKey['ram:usage'].message, 'RAM usada em 95%');
  assert.equal(byKey['smart:sda'].level, 'critical');
  assert.equal(byKey['service:smbd'].message, 'Serviço smbd failed');
  assert.equal(byKey['service:smbd'].value, null);
});

test('histerese: dispara em 90, continua acima de 85 e só limpa em 85 ou menos', () => {
  const run = (values) => {
    const active = new Set();
    return values.map((pct) => {
      const r = evaluate(base({ disks: [{ mount: '/', pct }] }), T, active);
      active.clear();
      for (const c of r.conditions) active.add(c.key);
      return active.has('disk:/:usage');
    });
  };
  assert.deepEqual(run([89, 90, 88, 86, 85, 89, 90]), [false, true, true, true, false, false, true]);
});

test('flapping: valor oscilando em volta do limiar não abre e fecha o alerta a cada coleta', () => {
  const active = new Set();
  let transitions = 0;
  let was = false;
  for (let i = 0; i < 60; i++) {
    const tempC = 60 + (i % 2 ? -1.5 : 0.5); // 60.5 / 58.5 / 60.5 ...
    const r = evaluate(base({ tempC }), T, active);
    active.clear();
    for (const c of r.conditions) active.add(c.key);
    const now = active.has('temp:cpu');
    if (now !== was) transitions += 1;
    was = now;
  }
  assert.equal(transitions, 1, 'dispara 1 vez e fica aberto enquanto não cai abaixo de 55 °C');
});

test('histerese 0: volta ao comportamento simples (>= limiar)', () => {
  const t0 = { ...T, hysteresis: 0 };
  const active = new Set(['temp:cpu']);
  assert.equal(evaluate(base({ tempC: 60 }), t0, active).conditions.length, 1);
  assert.equal(evaluate(base({ tempC: 59.9 }), t0, active).conditions.length, 0);
});

test('limiares do .env mudam as regras (fonte única)', () => {
  const t = { ...T, diskPct: 80, tempC: 50 };
  assert.deepEqual(keys(evaluate(base({ tempC: 51, disks: [{ mount: '/', pct: 81 }] }), t)), ['disk:/:usage', 'temp:cpu']);
  assert.deepEqual(rulesFor(t).map((r) => [r.id, r.fire ?? null, r.clear ?? null]), [
    ['disk', 80, 75], ['ram', 90, 85], ['temp', 50, 45], ['smart', null, null], ['service', null, null],
  ]);
});

test('dado ausente: o alerta aberto fica como está (não resolve, não cria)', () => {
  const active = new Set(['temp:cpu', 'smart:sda', 'disk:/:usage', 'service:smbd', 'ram:usage']);
  const r = evaluate({ ts: 'x', host: 'srv', tempC: null, smart: null, disks: [{ mount: '/', pct: null }], services: { smbd: 'desconhecido' } }, T, active);
  assert.deepEqual(r.conditions, []);
  assert.deepEqual([...r.unknown].sort(), ['disk:/:usage', 'ram:usage', 'service:smbd', 'smart:sda', 'temp:cpu']);
  const fresh = evaluate({ ts: 'x', tempC: null, smart: [{ dev: 'sda' }] }, T);
  assert.deepEqual(fresh, { conditions: [], unknown: new Set() }, 'sem alerta aberto não há o que manter');
});

test('mount ou serviço que saiu da configuração resolve o alerta (não fica desconhecido)', () => {
  const active = new Set(['disk:/mnt/velho:usage', 'service:antigo']);
  const r = evaluate(base(), T, active);
  assert.deepEqual(r.conditions, []);
  assert.equal(r.unknown.size, 0);
});

test('computeAlerts (fachada do poller) usa as mesmas regras, sem estado', () => {
  const list = computeAlerts(base({ tempC: 61.2 }));
  assert.deepEqual(list, [{ key: 'temp:cpu', level: 'warning', message: 'Temperatura CPU 61.2°C', value: 61.2 }]);
  assert.equal(computeAlerts(base({ tempC: 70 }), { ...T, tempC: 80 }).length, 0);
  assert.equal(OFFLINE_KEY, 'servidor-inacessivel', 'chave da V1 mantida para continuidade');
  assert.equal(ramPct({ ram: { used: 1, total: 0 } }), null);
});

test('saúde usa os mesmos limiares: zona de atenção abaixo do limiar e penalidade no limiar', () => {
  assert.deepEqual(healthScore(base(), T), { score: 100, level: 'ok', parts: [] });
  const h = healthScore(base({
    load: [2, 1, 1], ram: { total: 1000, used: 800 }, tempC: 71,
    disks: [{ mount: '/', pct: 85 }, { mount: '/x', pct: 92 }, { mount: '/y', pct: null }],
    smart: [{ dev: 'sda', status: 'FAILED' }], services: { smbd: 'failed', nmbd: 'desconhecido' },
  }), T);
  assert.deepEqual(h.parts.map((p) => [p.label, p.pts, p.level]), [
    ['Load 2.00 alto (1 núcleo)', 10, 'warn'], ['RAM 80%', 5, 'warn'], ['Temp 71.0°C', 25, 'bad'],
    ['Disco / 85%', 5, 'warn'], ['Disco /x 92%', 15, 'warn'], ['SMART /dev/sda', 40, 'bad'], ['Serviço smbd failed', 25, 'bad'],
  ]);
  assert.equal(h.score, 0);
  assert.equal(h.level, 'bad');
  const custom = healthScore(base({ tempC: 55, ram: { total: 1000, used: 960 }, cores: 2, load: [2, 1, 1] }), { ...T, tempC: 50, ramPct: 95 });
  assert.deepEqual(custom.parts.map((p) => p.label), ['RAM 96%', 'Temp 55.0°C']);
  assert.equal(custom.score, 70);
  assert.equal(custom.level, 'warn');
  assert.deepEqual(healthScore(null, T).parts, [{ label: 'Sem dados', pts: 100, level: 'bad' }]);
  assert.deepEqual(healthScore(base(), T, { offline: true }), { score: 0, level: 'bad', parts: [{ label: 'Servidor offline', pts: 100, level: 'bad' }] });
});
