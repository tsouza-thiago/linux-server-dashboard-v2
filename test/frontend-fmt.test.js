import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from '../test-support/frontend.js';

const { Dash } = loadFrontend('sections.js');
const F = Dash.fmt;

test('fmt.bytes formata hierarquia B/KB/MB/GB/TB', () => {
  assert.equal(F.bytes(0), '0 B');
  assert.equal(F.bytes(999), '999 B');
  assert.equal(F.bytes(1500), '2 KB');
  assert.equal(F.bytes(2e6), '2 MB');
  assert.equal(F.bytes(1.5e9), '1.5 GB');
  assert.equal(F.bytes(2.5e12), '2.50 TB');
  assert.equal(F.bytes(null), '—');
  assert.equal(F.bytes(undefined), '—');
});

test('fmt.uptime formata dias/horas/minutos', () => {
  assert.equal(F.uptime(90061), '1d 1h 1m');
  assert.equal(F.uptime(59), '0d 0h 0m');
  assert.equal(F.uptime(3661), '0d 1h 1m');
});

test('fmt.time e timeDate', () => {
  assert.equal(F.time(null), '—');
  assert.equal(F.time(''), '—');
  const t = F.time('2026-08-15T14:55:01.000Z');
  assert.match(t, /^\d{2}:\d{2}:\d{2}$/);
  assert.match(F.timeDate('2026-08-15T14:55:01.000Z'), /\d{2}\/\d{2}/);
  assert.equal(F.timeDate(null), '—');
});

test('fmt.pctColor limiares (tokens DS §2)', () => {
  assert.equal(F.pctColor(95), '#E2604F');
  assert.equal(F.pctColor(90), '#E2604F');
  assert.equal(F.pctColor(60), '#D6A23C');
  assert.equal(F.pctColor(10), '#3FA6A0');
});

test('fmt.days formata previsões', () => {
  assert.equal(F.days(null), '—');
  assert.equal(F.days(undefined), '—');
  assert.match(F.days(400), /~1\.1 ano/);
  assert.match(F.days(45), /~1\.5 mês/);
  assert.match(F.days(10), /~10 dia/);
});

test('fmt.duration', () => {
  assert.equal(F.duration(null), 'em curso');
  assert.equal(F.duration(3661), '1h 1m');
  assert.equal(F.duration(61), '1m 1s');
  assert.equal(F.duration(59), '59s');
});

test('fmt.esc escapa todos os caracteres XSS', () => {
  assert.equal(F.esc('<script>'), '&lt;script&gt;');
  assert.equal(F.esc('&'), '&amp;');
  assert.equal(F.esc('"aspas"'), '&quot;aspas&quot;');
  assert.equal(F.esc("'aspas'"), '&#39;aspas&#39;');
  assert.equal(F.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(F.esc(''), '');
  assert.equal(F.esc(null), '');
  assert.equal(F.esc(123), '123');
});

test('fmt.esc não quebra texto seguro', () => {
  assert.equal(F.esc('pasta normal /mnt/disco1'), 'pasta normal /mnt/disco1');
});