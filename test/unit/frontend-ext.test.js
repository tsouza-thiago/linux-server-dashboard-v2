import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from '../../test-support/frontend.js';

function baseCtx() {
  const c = loadAll(['analysis.js', 'sections.js']);
  c.Dash.alerts = { active: [], all: [] };
  c.Dash.samples = [];
  c.Dash.latest = null;
  c.Dash.diskDetailMount = null;
  c.Dash.ioDev = 'sda';
  c.Dash.procsSort = { key: 'mem', dir: -1 };
  c.Dash.procsFilter = '';
  c.Dash.alertFilter = 'active';
  c.Dash.period = '24h';
  c.Dash.charts = { sync() {}, applyAnnotations() {}, resetZoom() {} };
  return c;
}

test('api.ackAlert e refreshAlerts enviam Authorization Bearer quando há token', async () => {
  const calls = [];
  const ctx = loadAll(['analysis.js', 'charts.js', 'sections.js', 'router.js', 'main.js'], {
    sessionStorage: { getItem: () => 'segredo', setItem: () => {} },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({}), blob: async () => new Blob([]) };
    },
  });

  await ctx.Dash.api.ackAlert('id-1');
  const post = calls.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(post, 'POST de ack deve ocorrer');
  assert.equal(post.opts.headers.Authorization, 'Bearer segredo');

  const alerts = calls.find((c) => c.url === '/api/alerts?limit=200');
  assert.ok(alerts, 'refreshAlerts deve ser chamado após o ack');
  assert.equal(alerts.opts.headers.Authorization, 'Bearer segredo', 'refreshAlerts usa apiFetch com token');
});

test('sections.overview tolera amostra sem campo load', () => {
  const c = baseCtx();
  const s = {
    ts: '2026-08-15T09:00:00.000Z', host: 'h', os: { kernel: '', name: '' },
    cores: 1, uptimeSec: 100, bootAt: 'x', ram: null, tempC: null,
    disks: [], net: {}, services: {},
  };
  assert.doesNotThrow(() => c.Dash.sections.overview(s));
  assert.equal(c.document.getElementById('load1').textContent, '—');
  assert.equal(c.document.getElementById('load5').textContent, '—');
  assert.equal(c.document.getElementById('load15').textContent, '—');
});

test('sections.modal tolera amostra sem load', () => {
  const c = baseCtx();
  const s = {
    ts: '2026-08-15T09:00:00.000Z', host: 'h', os: { kernel: '', name: '' },
    uptimeSec: 0, bootAt: 'x', tempC: null, net: {}, services: {},
    disks: [], io: [], smart: [], topProcs: [],
  };
  assert.doesNotThrow(() => c.Dash.sections.modal.open(s));
  assert.ok(c.document.getElementById('sampleModalBody').innerHTML.includes('—'));
  c.Dash.sections.modal.close();
});

test('sections.annotationsView renderiza lista com botão remover e estado vazio', () => {
  const c = baseCtx();
  c.Dash.annotations = [];
  c.Dash.sections.annotationsView();
  assert.match(c.document.getElementById('annotationsList').innerHTML, /Nenhuma anotação/);

  c.Dash.annotations = [{
    id: 'a1', ts: '2026-08-15T09:00:00.000Z', text: 'manutenção agendada', label: '',
  }];
  c.Dash.sections.annotationsView();
  const el = c.document.getElementById('annotationsList');
  assert.equal(el.children.length, 1);
  assert.ok(el.children[0].innerHTML.includes('data-del="a1"'));
  assert.ok(el.children[0].innerHTML.includes('manutenção agendada'));
});

test('tema escuro é aplicado por padrão e persistido', () => {
  const store = {};
  const ctx = loadAll(['analysis.js', 'charts.js', 'sections.js', 'router.js', 'main.js'], {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
  });
  assert.equal(ctx.document.documentElement.dataset.theme, 'dark');
  assert.equal(store.dash_theme, 'dark');
});

test('prefers-color-scheme light escolhe tema claro', () => {
  const store = {};
  const ctx = loadAll(['analysis.js', 'charts.js', 'sections.js', 'router.js', 'main.js'], {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  assert.equal(ctx.document.documentElement.dataset.theme, 'light');
  assert.equal(store.dash_theme, 'light');
});

test('preferência salva tem precedência sobre o sistema', () => {
  const ctx = loadAll(['analysis.js', 'charts.js', 'sections.js', 'router.js', 'main.js'], {
    localStorage: {
      getItem: () => 'light',
      setItem: () => {},
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  assert.equal(ctx.document.documentElement.dataset.theme, 'light');
});