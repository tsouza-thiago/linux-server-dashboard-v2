import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeToken, isPlaceholderHost, clampInt, clampPathToData, config,
} from '../../server/config.js';

test('sanitizeToken remove tokens perigosos', () => {
  assert.deepEqual(sanitizeToken('sda sdb'), ['sda', 'sdb']);
  assert.deepEqual(sanitizeToken('sda;rm -rf /'), ['/']);
  assert.deepEqual(sanitizeToken('$(reboot)'), []);
  assert.deepEqual(sanitizeToken('-rf /etc'), ['/etc']);
  assert.deepEqual(sanitizeToken('  a  b  '), ['a', 'b']);
  assert.deepEqual(sanitizeToken(''), []);
});

test('sanitizeToken aceita caracteres seguros', () => {
  assert.deepEqual(sanitizeToken('/ /mnt/disco1'), ['/', '/mnt/disco1']);
  assert.deepEqual(sanitizeToken('enpXsY:1'), ['enpXsY:1']);
});

test('isPlaceholderHost detecta valores padrão', () => {
  assert.equal(isPlaceholderHost('seu-host'), true);
  assert.equal(isPlaceholderHost('seu_host_ou_alias_ssh'), true);
  assert.equal(isPlaceholderHost('debiandell'), false);
});

test('clampInt respeita limites', () => {
  assert.equal(clampInt('60000', 60000, 10000, 3600000), 60000);
  assert.equal(clampInt('1000', 60000, 10000, 3600000), 60000); // abaixo do piso
  assert.equal(clampInt('banana', 60000, 10000, 3600000), 60000);
  assert.equal(clampInt('', 60000, 10000, 3600000), 60000);
});

test('clampPathToData mantém dentro de data/', () => {
  const p = clampPathToData('data/custom.json', 'history.json');
  assert.ok(p.endsWith('data/custom.json'));
  const escaped = clampPathToData('/tmp/evil.json', 'history.json');
  assert.ok(escaped.endsWith('data/history.json'));
});

test('config tem defaults seguros', () => {
  assert.ok(config.POLL_INTERVAL >= 10000);
  assert.ok(config.PORT >= 1 && config.PORT <= 65535);
  assert.ok(Array.isArray(config.DISK_MOUNTS) && config.DISK_MOUNTS.length > 0);
  assert.ok(Array.isArray(config.DISK_DEVS));
  assert.ok(Array.isArray(config.SERVICES));
});
test('intSetting: vazio usa o padrão; fora da faixa ou não inteiro avisa e usa o padrão', async () => {
  const { intSetting } = await import('../../server/config.js');
  const w = [];
  assert.equal(intSetting('X', '', 90, 50, 99, w), 90);
  assert.equal(intSetting('X', undefined, 90, 50, 99, w), 90);
  assert.equal(intSetting('X', ' 80 ', 90, 50, 99, w), 80);
  assert.deepEqual(w, []);
  assert.equal(intSetting('X', '120', 90, 50, 99, w), 90);
  assert.equal(intSetting('X', '85.5', 90, 50, 99, w), 90);
  assert.equal(intSetting('X', 'muito', 90, 50, 99, w), 90);
  assert.equal(w.length, 3);
  assert.match(w[0], /^X inválido \(aceita 50–99\); usando 90$/);
  assert.ok(!w.join(' ').includes('muito'), 'o valor recusado não é ecoado');
});

test('alertThresholds: padrões da V1 e valores do .env validados', async () => {
  const { alertThresholds } = await import('../../server/config.js');
  assert.deepEqual(alertThresholds(() => ''), { diskPct: 90, ramPct: 90, tempC: 60, hysteresis: 5, offlineAfter: 2 });
  const vals = { ALERT_DISK_PCT: '85', ALERT_RAM_PCT: '95', ALERT_TEMP_C: '70', ALERT_HYSTERESIS: '3', ALERT_OFFLINE_AFTER: '11' };
  const w = [];
  assert.deepEqual(alertThresholds((k) => vals[k], w), { diskPct: 85, ramPct: 95, tempC: 70, hysteresis: 3, offlineAfter: 2 });
  assert.deepEqual(w, ['ALERT_OFFLINE_AFTER inválido (aceita 1–10); usando 2']);
  assert.deepEqual(config.ALERTS, alertThresholds(() => ''), 'sem ALERT_* no ambiente de teste');
});
