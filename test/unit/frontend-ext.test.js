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

test('sessão por cookie: a tela não guarda nem envia token; chamadas vão com o cookie do navegador', async () => {
  const calls = [];
  const ctx = loadAll(['analysis.js', 'charts.js', 'sections.js', 'router.js', 'main.js'], {
    sessionStorage: { getItem: () => 'token-antigo-da-v1', setItem: () => { throw new Error('não deve gravar token'); } },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({}), blob: async () => new Blob([]) };
    },
  });
  await ctx.Dash.api.ackAlert('id-1');
  const post = calls.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(post, 'POST de ack deve ocorrer');
  assert.equal(post.opts.credentials, 'same-origin');
  assert.equal((post.opts.headers || {}).Authorization, undefined, 'sem token no cabeçalho');
  assert.ok(calls.every((c) => !String(c.url).includes('token=')), 'sem token na URL');
});

test('401 abre a janela de login; token certo entra e recarrega; errado mostra o erro', async () => {
  let loginReply = { ok: false, status: 401, json: async () => ({ error: 'Token incorreto' }) };
  const calls = [];
  let reloaded = 0;
  const ctx = loadAll(['analysis.js', 'charts.js', 'sections.js', 'router.js', 'main.js'], {
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (url === '/api/login') return loginReply;
      if (url === '/api/session') return { ok: true, status: 200, json: async () => ({ authRequired: true, authenticated: false }) };
      return { ok: false, status: 401, json: async () => ({ error: 'Não autorizado' }) };
    },
  });
  ctx.sandbox.window.location.reload = () => { reloaded += 1; };
  const doc = ctx.document;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(doc.getElementById('login').hidden, false, 'login aparece no 401');
  assert.equal(doc.getElementById('sessionHelp').hidden, false, 'Ajuda mostra os botões de sessão');
  const submit = doc.getElementById('loginForm').listeners.submit[0];
  doc.getElementById('loginToken').value = '  errado  ';
  await submit({ preventDefault() {} });
  const sent = calls.find((c) => c.url === '/api/login');
  assert.deepEqual(JSON.parse(sent.opts.body), { token: 'errado' });
  assert.equal(doc.getElementById('loginError').textContent, 'Token incorreto');
  assert.equal(reloaded, 0);
  loginReply = { ok: false, status: 429, json: async () => ({}) };
  await submit({ preventDefault() {} });
  assert.match(doc.getElementById('loginError').textContent, /aguarde 1 minuto/);
  loginReply = { ok: true, status: 200, json: async () => ({ ok: true }) };
  doc.getElementById('loginToken').value = 'certo';
  await submit({ preventDefault() {} });
  assert.equal(reloaded, 1);
  assert.equal(doc.getElementById('loginToken').value, '');
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