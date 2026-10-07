// Orquestração da tela: tema, login, navegação, dados, SSE ao vivo e atalhos de teclado.
import { createStore } from './core/store.js';
import { api, onAuthRequired } from './core/api.js';
import { connect } from './core/sse.js';
import { VIEWS, PERIODS, parseHash, buildHash, viewByKey } from './core/router.js';
import { html, mount } from './core/html.js';
import { isOffline } from './core/analysis.js';
import * as f from './core/format.js';
import * as visaoGeral from './views/visao-geral.js';
import * as recursos from './views/recursos.js';
import * as armazenamento from './views/armazenamento.js';
import * as rede from './views/rede.js';
import * as processos from './views/processos.js';
import * as eventos from './views/eventos.js';
import * as relatorios from './views/relatorios.js';
import * as ajuda from './views/ajuda.js';

const MODULES = {
  'visao-geral': visaoGeral, recursos, armazenamento, rede, processos, eventos, relatorios, ajuda,
};
const USES_BUCKETS = new Set(['visao-geral', 'recursos', 'armazenamento', 'rede']);
const ICONS = {
  'visao-geral': 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  recursos: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  armazenamento: 'M3 6h18v5H3zM3 13h18v5H3zM7 8.5h.01M7 15.5h.01',
  rede: 'M22 12h-4l-3 9L9 3l-3 9H2',
  processos: 'M4 6h16M4 12h16M4 18h10',
  eventos: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  relatorios: 'M6 20V14M12 20V4M18 20v-9',
  ajuda: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
};
const THEME_KEY = 'dash_theme';
const $ = (id) => document.getElementById(id);

const route = parseHash(location.hash);
const store = createStore({
  view: route.view, period: route.period, session: null, meta: null, sample: null, health: null,
  alerts: { active: [], all: [] }, annotations: [], outages: null, config: null, buckets: [], live: 'conectando',
});

// ---------------- Tema (escuro é o padrão — D1) ----------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* armazenamento bloqueado */ }
}
function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  renderView(); // gráficos leem as cores do tema ao serem criados
}

// ---------------- Avisos rápidos (4 s, com "Desfazer" quando faz sentido) ----------------
function toast(text, { action, level = 'info' } = {}) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${level}`;
  mount(el, html`<span>${text}</span>${action ? html`<button class="btn-ghost" type="button">${action.label}</button>` : ''}`);
  if (action) el.querySelector('button').addEventListener('click', () => { action.fn(); el.remove(); });
  box.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------------- Login (ADR 0007) ----------------
let loginShown = false;
function showLogin(message = '') {
  loginShown = true;
  $('login').hidden = false;
  $('loginError').textContent = message;
  $('loginToken').focus();
}
onAuthRequired(() => showLogin());
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('loginToken').value.trim();
  if (!token) return;
  $('loginSubmit').disabled = true;
  try {
    await api.login(token);
    $('loginToken').value = '';
    location.reload();
  } catch (err) {
    $('loginError').textContent = err.status === 429 ? 'Muitas tentativas — aguarde 1 minuto.'
      : err.status === 401 ? 'Token incorreto' : 'Painel inacessível — confira se o serviço está rodando.';
  } finally {
    $('loginSubmit').disabled = false;
  }
});

// ---------------- Ações usadas pelas telas ----------------
async function refreshAlerts() {
  const a = await api.alerts();
  store.set({ alerts: { active: a.active || [], all: a.all || [] } });
}
const act = {
  async ack(id) { await api.ack(id); await refreshAlerts(); toast('Alerta reconhecido'); },
  async resolve(id) { await api.resolve(id); await refreshAlerts(); toast('Alerta resolvido'); },
  async addAnnotation({ text, label, ts }) {
    await api.addAnnotation({ text, label, ts });
    store.set({ annotations: (await api.annotations()).annotations || [] });
    toast('Anotação criada');
  },
  async removeAnnotation(id) {
    const old = store.get().annotations.find((a) => a.id === id);
    await api.removeAnnotation(id);
    store.set({ annotations: (await api.annotations()).annotations || [] });
    toast('Anotação removida', old ? { action: { label: 'Desfazer', fn: () => act.addAnnotation(old) } } : {});
  },
  async logout(all) { await api.logout(all); location.reload(); },
  async poll() {
    try { await api.poll(); toast('Coleta pedida — chega em segundos'); } catch (err) { toast(err.message, { level: 'warn' }); }
  },
};

// ---------------- Navegação e cabeçalho ----------------
function renderNav() {
  const { view, alerts } = store.get();
  const open = alerts.active.length;
  mount($('nav'), html`${VIEWS.map((v) => html`
    <a href="${buildHash({ view: v.id, period: store.get().period })}" class="nav-item${v.id === view ? ' active' : ''}" ${v.id === view ? html`aria-current="page"` : ''} title="${v.title} (${v.key})">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[v.id]}"/></svg>
      <span>${v.title}</span>${v.id === 'eventos' && open ? html` <span class="nav-badge" aria-label="${open} alerta(s) aberto(s)">${open}</span>` : ''}
    </a>`)}`);
  mount($('periodToggle'), html`${Object.keys(PERIODS).map((p) => html`
    <button type="button" data-period="${p}" class="${p === store.get().period ? 'active' : ''}" aria-pressed="${p === store.get().period}">${p}</button>`)}`);
}

function renderStatus() {
  const { meta, live, sample } = store.get();
  const offline = isOffline(meta);
  const text = live === 'caiu' ? 'reconectando…' : offline ? 'offline' : meta?.online ? 'online' : 'aguardando coleta';
  $('statusDot').className = `dot ${offline ? 'dot-offline' : meta?.online ? 'dot-online' : 'dot-polling'}`;
  $('statusText').textContent = text;
  $('lastPoll').textContent = meta?.lastPollAt ? f.ago(meta.lastPollAt) : '—';
  $('hostLabel').textContent = sample?.host ? `${sample.host} · ${sample.os?.name || ''}` : (meta?.host || '—');
  const banner = $('offlineBanner');
  banner.hidden = !offline;
  if (offline) {
    const next = meta.nextPollAt ? Math.max(0, Math.round((Date.parse(meta.nextPollAt) - Date.now()) / 1000)) : null;
    banner.textContent = `Servidor inacessível desde ${f.dateTime(meta.offlineSince)}${meta.lastError ? ` — ${meta.lastError}` : ''}. Valores abaixo são da última coleta.${next !== null ? ` Nova tentativa em ${next} s.` : ''}`;
  }
}

// ---------------- Telas ----------------
let current = null;
function destroyCurrent() {
  if (!current) return;
  for (const c of current.ctx.charts.values()) c.destroy();
  current = null;
}

function renderView() {
  const { view } = store.get();
  destroyCurrent();
  const mod = MODULES[view];
  const el = document.createElement('div');
  el.className = `view view-${view}`;
  $('view').replaceChildren(el);
  const ctx = { el, charts: new Map(), local: {}, api, act, get state() { return store.get(); } };
  current = { view, mod, ctx };
  $('viewTitle').textContent = VIEWS.find((v) => v.id === view).title;
  document.title = `${VIEWS.find((v) => v.id === view).title} · Server Dashboard`;
  mod.render(ctx);
}

function refreshView() {
  if (!current) return renderView();
  if (current.mod.update) current.mod.update(current.ctx);
  else renderView();
}

let bucketsTimer = null;
async function loadBuckets() {
  const { period } = store.get();
  const to = new Date();
  const from = new Date(to.getTime() - PERIODS[period]);
  try {
    const r = await api.buckets({ from: from.toISOString(), to: to.toISOString(), limit: 600 });
    store.set({ buckets: r.buckets || [], bucketsRange: [from.getTime() / 1000, to.getTime() / 1000] });
  } catch { /* 401 já abre o login; outros erros: tenta na próxima coleta */ }
}
function scheduleBuckets() {
  clearTimeout(bucketsTimer);
  bucketsTimer = setTimeout(() => { if (USES_BUCKETS.has(store.get().view)) loadBuckets(); }, 300);
}

async function loadOutages() {
  try { store.set({ outages: await api.outages(90) }); } catch { /* tenta de novo depois */ }
}

store.subscribe((state, patch) => {
  if ('alerts' in patch || 'view' in patch || 'period' in patch) renderNav();
  if ('meta' in patch || 'live' in patch || 'sample' in patch) renderStatus();
  if (loginShown) return;
  if ('view' in patch || 'period' in patch) return; // a navegação redesenha depois de carregar
  const relevant = ['sample', 'buckets', 'alerts', 'annotations', 'outages', 'config', 'health', 'session'];
  if (relevant.some((k) => k in patch)) refreshView();
});

async function navigate() {
  const { view, period } = parseHash(location.hash);
  const changed = view !== store.get().view || period !== store.get().period;
  store.set({ view, period });
  $('viewTitle').textContent = VIEWS.find((v) => v.id === view).title; // na hora, antes dos dados
  closeNav();
  if (USES_BUCKETS.has(view) && (changed || !store.get().buckets.length)) await loadBuckets();
  renderView();
  $('view').focus({ preventScroll: true });
}

// ---------------- Ao vivo (SSE) ----------------
function onEvent(name, data) {
  if (name === 'hello' || name === 'status') {
    store.set({ meta: data.meta, health: data.health ?? store.get().health, ...(data.sample ? { sample: data.sample } : {}),
      alerts: { ...store.get().alerts, active: data.alerts || store.get().alerts.active } });
    if (name === 'status' && data.meta?.online === false) loadOutages();
  } else if (name === 'sample') {
    const cur = store.get().sample;
    if (!cur || data.sample.ts > cur.ts) {
      const wasOffline = store.get().meta?.online === false;
      store.set({ sample: data.sample, health: data.health ?? store.get().health, alerts: { ...store.get().alerts, active: data.alerts || [] },
        meta: { ...store.get().meta, online: true, lastPollAt: data.sample.ts, offlineSince: null, lastError: null } });
      if (wasOffline) loadOutages();
    }
    scheduleBuckets();
  } else if (name === 'alerts') {
    store.set({ alerts: { active: data.alerts || [], all: data.all || store.get().alerts.all } });
  } else if (name === 'annotations') {
    store.set({ annotations: data.annotations || [] });
  }
}

// ---------------- Teclado ----------------
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  const v = viewByKey(e.key);
  const go = (view) => { location.hash = buildHash({ view, period: store.get().period }); };
  if (v) go(v.id);
  else if (e.key === 'c' || e.key === 'C') act.poll();
  else if (e.key === 't' || e.key === 'T') toggleTheme();
  else if (e.key === '?') go('ajuda');
  else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    if (store.get().view === 'eventos') eventos.focusNew(current.ctx); else { go('eventos'); setTimeout(() => current && eventos.focusNew(current.ctx), 50); }
  } else if (e.key === '/') {
    e.preventDefault();
    if (store.get().view === 'processos') processos.focusSearch(current.ctx); else { go('processos'); setTimeout(() => current && processos.focusSearch(current.ctx), 50); }
  } else if (e.key === 'Escape') closeNav();
}

function closeNav() {
  document.body.classList.remove('nav-open');
  $('navToggle').setAttribute('aria-expanded', 'false');
}

// ---------------- Início ----------------
async function start() {
  applyTheme(currentTheme());
  renderNav();
  renderStatus();
  $('themeToggle').addEventListener('click', toggleTheme);
  $('pollBtn').addEventListener('click', () => act.poll());
  $('periodToggle').addEventListener('click', (e) => {
    const p = e.target.closest('[data-period]')?.dataset.period;
    if (p) location.hash = buildHash({ view: store.get().view, period: p });
  });
  $('navToggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    $('navToggle').setAttribute('aria-expanded', String(open));
  });
  $('navScrim').addEventListener('click', closeNav);
  document.addEventListener('keydown', onKey);
  setInterval(renderStatus, 15000);

  let session;
  try { session = await api.session(); } catch { session = null; }
  store.set({ session });
  if (session && session.authRequired && !session.authenticated) { showLogin(); return; }

  window.addEventListener('hashchange', navigate);
  try {
    const [status, alerts, notes, outages, config] = await Promise.all([
      api.status(), api.alerts(), api.annotations(), api.outages(90), api.config(),
    ]);
    store.set({
      meta: status.meta, sample: status.sample, health: status.health,
      alerts: { active: alerts.active || [], all: alerts.all || [] },
      annotations: notes.annotations || [], outages, config,
    });
  } catch { /* 401 abre o login; painel fora do ar: o SSE avisa e tenta de novo */ }
  if (loginShown) return;
  await navigate();
  connect({
    onEvent,
    onState: (live) => store.set({ live }),
    onAuthLost: () => showLogin('Sessão expirada — entre de novo.'),
  });
}

start();
