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