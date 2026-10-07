// Orquestração da tela: tema, login, navegação, faixa de status, dados, SSE ao vivo,
// notificações do navegador e atalhos de teclado.
import { createStore } from './core/store.js';
import { api, onAuthRequired } from './core/api.js';
import { connect } from './core/sse.js';
import { VIEWS, PERIODS, parseHash, buildHash, viewByKey } from './core/router.js';
import { html, mount } from './core/html.js';
import { isOffline } from './core/analysis.js';
import * as f from './core/format.js';
import { icon } from './views/common.js';
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
const THEME_KEY = 'dash_theme';
const $ = (id) => document.getElementById(id);

const route = parseHash(location.hash);
const store = createStore({
  view: route.view, period: route.period, session: null, meta: null, sample: null, health: null,
  alerts: { active: [], all: [] }, annotations: [], outages: null, config: null, buckets: [], live: 'conectando',
  loading: true,
});

// ---------------- Tema (escuro é o padrão — D1) ----------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* armazenamento bloqueado */ }
  const dark = theme === 'dark';
  mount($('themeToggle'), icon(dark ? 'moon' : 'sun', 18));
  $('themeToggle').setAttribute('aria-label', dark ? 'Usar tema claro (T)' : 'Usar tema escuro (T)');
}
function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}
let current = null;
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  if (current) renderView(); // gráficos leem as cores do tema ao serem criados
}

// ---------------- Avisos rápidos (canto inferior direito, 4 s, "Desfazer" quando faz sentido) ----------------
const TOAST_ICON = { ok: ['check', 'ink-ok'], warn: ['warn', 'ink-warn'], crit: ['crit', 'ink-crit'] };
function toast(text, { level = 'ok', sub = '', action, ms = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  const ic = TOAST_ICON[level];
  mount(el, html`${level === 'busy' ? html`<span class="spinner" aria-hidden="true"></span>` : ic ? html`<span class="toast-icon ${ic[1]}">${icon(ic[0], 18, 2.5)}</span>` : ''}
    <span>${text}${sub ? html` <span class="toast-sub">${sub}</span>` : ''}</span>
    ${action ? html`<button class="btn-link" type="button">${action.label}</button>` : ''}`);
  if (action) el.querySelector('button').addEventListener('click', () => { action.fn(); el.remove(); });
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---------------- Login (ADR 0007) ----------------
let loginShown = false;
function setLoginError(message) {
  mount($('loginError'), message ? html`${icon('serious', 14, 2.6)}${message}` : '');
  $('loginToken').classList.toggle('is-invalid', Boolean(message));
  $('loginToken').setAttribute('aria-invalid', message ? 'true' : 'false');
}
function showLogin(message = '') {
  loginShown = true;
  $('login').hidden = false;
  $('app').inert = true;
  document.body.classList.add('login-open');
  setLoginError(message);
  $('loginFoot').textContent = `somente nesta máquina · ${location.host}`;
  $('loginToken').focus();
}
onAuthRequired(() => showLogin());
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('loginToken').value.trim();
  if (!token) return;
  $('loginSubmit').disabled = true;
  try {
    await api.login(token, { remember: $('loginRemember').checked });
    $('loginToken').value = '';
    location.reload();
  } catch (err) {
    setLoginError(err.status === 429 ? 'Muitas tentativas. Aguarde 1 minuto.'
      : err.status === 401 ? 'Token incorreto. Confira e tente de novo.' : 'Painel inacessível. Confira se o serviço está rodando.');
    $('loginToken').select();
  } finally {
    $('loginSubmit').disabled = false;
  }
});

// ---------------- Notificações do navegador (alertas novos com a aba em segundo plano) ----------------
const seenAlerts = new Set();
function notifyNewAlerts(list) {
  const fresh = (list || []).filter((a) => a.status === 'new' && !seenAlerts.has(a.id));
  for (const a of list || []) seenAlerts.add(a.id);
  if (!fresh.length || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  for (const a of fresh.slice(0, 3)) {
    try { new Notification(a.level === 'critical' ? 'Crítico' : 'Atenção', { body: a.message, tag: a.key || a.id }); } catch { /* sem suporte */ }
  }
}

// ---------------- Ações usadas pelas telas ----------------
async function refreshAlerts() {
  const a = await api.alerts();
  store.set({ alerts: { active: a.active || [], all: a.all || [] } });
}
const act = {
  async ack(id) { await api.ack(id); await refreshAlerts(); toast('Alerta reconhecido'); },
  async resolve(id) { await api.resolve(id); await refreshAlerts(); toast('Alerta resolvido'); },
  async addAnnotation({ text, label, ts }, { silent = false } = {}) {
    const r = await api.addAnnotation({ text, label, ts });
    store.set({ annotations: (await api.annotations()).annotations || [] });
    const id = r?.annotation?.id || r?.id;
    if (!silent) {
      toast('Anotação salva e marcada nos gráficos', id ? { action: { label: 'Desfazer', fn: () => act.removeAnnotation(id, { silent: true }) } } : {});
    }
  },
  async removeAnnotation(id, { silent = false } = {}) {
    const old = store.get().annotations.find((a) => a.id === id);
    await api.removeAnnotation(id);
    store.set({ annotations: (await api.annotations()).annotations || [] });
    if (!silent) toast('Anotação removida', old ? { action: { label: 'Desfazer', fn: () => act.addAnnotation(old, { silent: true }) } } : {});
  },
  async logout(all) { await api.logout(all); location.reload(); },
  async poll() {
    try {
      await api.poll();
      toast('Coletando agora…', { level: 'busy', sub: 'próxima coleta manual liberada em 5 s' });
    } catch (err) { toast(err.message, { level: 'warn' }); }
  },
  async enableNotifications() {
    if (typeof Notification === 'undefined') { toast('Este navegador não tem notificações', { level: 'warn' }); return; }
    const p = await Notification.requestPermission();
    if (p === 'granted') toast('Notificações ativadas', { sub: 'avisamos alertas novos com o painel em segundo plano' });
    else toast('Notificações bloqueadas pelo navegador', { level: 'warn', sub: '— libere no cadeado da barra de endereço' });
    if (current) refreshView();
  },
  go(view, period = store.get().period) { location.hash = buildHash({ view, period }); },
  toast,
};

// ---------------- Navegação ----------------
function renderNav() {
  const { view, alerts, period } = store.get();
  const open = alerts.active.length;
  const crit = alerts.active.some((a) => a.level === 'critical');
  const groups = [...new Set(VIEWS.map((v) => v.group))];
  mount($('nav'), html`${groups.map((g) => html`
    <span class="nav-group">${g}</span>
    ${VIEWS.filter((v) => v.group === g).map((v) => html`
      <a href="${buildHash({ view: v.id, period })}" class="nav-item" ${v.id === view ? html`aria-current="page"` : ''} title="${v.title} (${v.key})">
        ${icon(v.id, 18)}<span>${v.title}</span>${v.id === 'eventos' && open ? html`<span class="nav-badge${crit ? ' is-crit' : ''}" aria-label="${open} alerta(s) aberto(s)">${open}</span>` : ''}
      </a>`)}`)}`);
}

function renderPeriod() {
  const { view, period } = store.get();
  const show = VIEWS.find((v) => v.id === view)?.period;
  mount($('periodToggle'), show ? html`${Object.keys(PERIODS).map((p) => html`
    <button type="button" data-period="${p}" aria-pressed="${p === period}">${p}</button>`)}` : '');
}

// ---------------- Faixa de status (online / coletando / offline) ----------------
const shortOs = (os) => {
  const m = /^(\w+)[^\d]*(\d+(?:\.\d+)?)?/.exec(os?.name || '');
  return m ? `${m[1].toLowerCase()}${m[2] ? ` ${m[2]}` : ''}` : null;
};
const secondsAgo = (ts, now = Date.now()) => {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `há ${s} s` : `há ${f.duration(s)}`;
};
const nextIn = (meta) => (meta?.nextPollAt ? Math.max(0, Math.round((Date.parse(meta.nextPollAt) - Date.now()) / 1000)) : null);

function renderStrip() {
  const { meta, live, sample, config } = store.get();
  const strip = $('strip');
  const host = sample?.host || meta?.host || '—';
  const offline = isOffline(meta);
  const lost = live === 'caiu' && !offline;
  const state = offline ? 'offline' : lost || !sample ? 'coletando' : 'online';
  if (strip.dataset.state !== state) {
    // Leitor de tela: anuncia só a mudança de estado, não o relógio de cada segundo.
    $('liveRegion').textContent = { offline: 'Servidor inacessível', coletando: lost ? 'Reconectando ao painel' : 'Coletando', online: 'Servidor online' }[state];
  }
  strip.dataset.state = state;
  document.body.classList.toggle('is-offline', offline);
  const next = nextIn(meta);
  const ret = config?.retention;
  if (lost) {
    mount(strip, html`<span class="live live-busy"><span class="spinner"></span>RECONECTANDO</span>
      <span>a conexão com o painel caiu · tentando de novo…</span>`);
  } else if (offline) {
    mount(strip, html`<span class="live live-crit"><span class="live-dot"></span>OFFLINE ${meta.offlineSince ? secondsAgo(meta.offlineSince) : ''}</span>
      <span>host <b>${host}</b></span>
      ${meta.lastError ? html`<span>motivo <b>${meta.lastError}</b></span>` : ''}
      <span class="strip-opt">última coleta boa <b>${f.time(sample?.ts)}</b></span>
      ${next !== null ? html`<span class="strip-end">nova tentativa em <b>${next} s</b></span>` : ''}`);
  } else if (!sample) {
    mount(strip, html`<span class="live live-busy"><span class="spinner"></span>COLETANDO</span>
      <span>host <b>${host}</b></span><span>aguardando a 1ª resposta do servidor…</span>
      <span class="strip-end strip-opt">histórico <b>vazio</b></span>`);
  } else {
    const c = sample.collector || {};
    mount(strip, html`<span class="live live-ok"><span class="live-dot"></span>ONLINE</span>
      <span>host <b>${host}</b></span>
      ${shortOs(sample.os) ? html`<span class="strip-opt">${shortOs(sample.os)} · <b>${(/^\d+\.\d+/.exec(sample.os?.kernel || '') || ['—'])[0]}</b></span>` : ''}
      <span class="strip-opt">uptime <b>${f.duration(sample.uptimeSec)}</b></span>
      <span>coleta <b>${secondsAgo(meta?.lastPollAt || sample.ts)}</b></span>
      ${Number.isFinite(c.durationMs) ? html`<span class="strip-opt">ssh <b>${f.num(c.durationMs / 1000, 2)} s · ${f.bytes(c.outputBytes)}</b></span>` : ''}
      ${ret ? html`<span class="strip-end strip-opt">histórico <b>${ret.rawHours} h bruto · ${ret.rollupDays} d agregado</b></span>` : ''}`);
  }
  // Barra do celular
  $('mobileMeta').textContent = sample ? `${host} · ${secondsAgo(meta?.lastPollAt || sample.ts)}` : host;
  mount($('mobileLive'), offline ? html`<span class="live-dot"></span>OFFLINE`
    : sample ? html`<span class="live-dot"></span>ONLINE` : html`<span class="spinner"></span>COLETANDO`);
  $('mobileLive').className = `live ${offline ? 'live-crit' : sample ? 'live-ok' : 'live-busy'}`;
}

function renderPollBox() {
  const { meta, config } = store.get();
  const interval = meta?.pollIntervalMs || config?.pollIntervalMs || 60000;
  const next = nextIn(meta);
  $('nextPoll').textContent = next === null ? '—' : `${next} s`;
  const done = next === null ? 0 : Math.min(100, Math.max(0, 100 - (next * 1000 * 100) / interval));
  $('nextPollBar').style.width = `${done}%`;
  $('pollNote').textContent = `1 SSH / ${f.duration(interval / 1000)} · somente leitura`;
  const v = config?.version?.app;
  $('brandMeta').textContent = `${v ? `v${v} · ` : ''}${location.hostname}`;
}

// ---------------- Telas ----------------
function destroyCurrent() {
  if (!current) return;
  for (const c of current.ctx.charts.values()) c.destroy();
  current = null;
}

function renderHead() {
  const { view } = store.get();
  const meta = VIEWS.find((v) => v.id === view);
  const mod = MODULES[view];
  $('viewTitle').textContent = meta.title;
  $('mobileTitle').textContent = meta.title;
  $('viewSub').textContent = mod.sub ? mod.sub(store.get()) : '';
  mount($('viewActions'), current && mod.actions ? mod.actions(current.ctx) : '');
  renderPeriod();
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
  document.title = `${VIEWS.find((v) => v.id === view).title} · Server Dashboard`;
  renderHead();
  // Antes da 1ª resposta da API: blocos no formato final (a Visão geral tem os seus).
  if (store.get().loading && !mod.ownSkeleton) {
    ctx.pending = true;
    mount(el, html`<div class="grid-cards" aria-busy="true">${[1, 2, 3, 4].map(() => html`<div class="skel soft card-skel"></div>`)}</div><div class="skel soft panel-skel"></div>`);
    return;
  }
  mod.render(ctx);
}

function refreshView() {
  if (!current || current.ctx.pending) return renderView();
  renderHead();
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
    store.set({ buckets: r.buckets || [], bucketsStep: r.step, bucketsRange: [from.getTime() / 1000, to.getTime() / 1000] });
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
  if ('meta' in patch || 'live' in patch || 'sample' in patch || 'config' in patch) { renderStrip(); renderPollBox(); }
  if (loginShown) return;
  if ('view' in patch || 'period' in patch) return; // a navegação redesenha depois de carregar
  const relevant = ['sample', 'buckets', 'alerts', 'annotations', 'outages', 'config', 'health', 'session', 'loading'];
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
  window.scrollTo(0, 0);
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
      const interval = store.get().meta?.pollIntervalMs || 60000;
      store.set({ sample: data.sample, health: data.health ?? store.get().health, alerts: { ...store.get().alerts, active: data.alerts || [] },
        meta: { ...store.get().meta, online: true, lastPollAt: data.sample.ts, offlineSince: null, lastError: null, failures: 0,
          nextPollAt: new Date(Date.parse(data.sample.ts) + interval).toISOString() } });
      if (wasOffline) loadOutages();
    }
    scheduleBuckets();
  } else if (name === 'alerts') {
    notifyNewAlerts(data.all || data.alerts);
    store.set({ alerts: { active: data.alerts || [], all: data.all || store.get().alerts.all } });
  } else if (name === 'annotations') {
    store.set({ annotations: data.annotations || [] });
  }
}

// ---------------- Teclado ----------------
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || loginShown) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  const v = viewByKey(e.key);
  if (v) act.go(v.id);
  else if (e.key === 'c' || e.key === 'C') act.poll();
  else if (e.key === 't' || e.key === 'T') toggleTheme();
  else if (e.key === '?') act.go('ajuda');
  else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    if (store.get().view === 'eventos') eventos.focusNew(current.ctx); else { act.go('eventos'); setTimeout(() => current && eventos.focusNew(current.ctx), 80); }
  } else if (e.key === '/') {
    e.preventDefault();
    if (store.get().view === 'processos') processos.focusSearch(current.ctx); else { act.go('processos'); setTimeout(() => current && processos.focusSearch(current.ctx), 80); }
  } else if (e.key === 'Escape') closeNav();
}

function openNav() {
  document.body.classList.add('nav-open');
  $('navScrim').hidden = false;
  $('navToggle').setAttribute('aria-expanded', 'true');
  $('side').querySelector('[aria-current="page"]')?.focus();
}
function closeNav() {
  if (!document.body.classList.contains('nav-open')) return;
  document.body.classList.remove('nav-open');
  $('navScrim').hidden = true;
  $('navToggle').setAttribute('aria-expanded', 'false');
}

// ---------------- Início ----------------
async function start() {
  applyTheme(currentTheme());
  renderNav();
  renderStrip();
  renderPollBox();
  $('themeToggle').addEventListener('click', toggleTheme);
  $('pollBtn').addEventListener('click', () => act.poll());
  $('periodToggle').addEventListener('click', (e) => {
    const p = e.target.closest('[data-period]')?.dataset.period;
    if (p) location.hash = buildHash({ view: store.get().view, period: p });
  });
  $('viewActions').addEventListener('click', (e) => { if (current?.mod.onAction) current.mod.onAction(current.ctx, e); });
  $('navToggle').addEventListener('click', openNav);
  $('navClose').addEventListener('click', closeNav);
  $('navScrim').addEventListener('click', closeNav);
  $('nav').addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });
  document.addEventListener('keydown', onKey);
  setInterval(() => { renderPollBox(); renderStrip(); }, 1000);

  let session;
  try { session = await api.session(); } catch { session = null; }
  store.set({ session });
  if (session && session.authRequired && !session.authenticated) { showLogin(); return; }

  window.addEventListener('hashchange', navigate);
  await navigate(); // esqueleto no formato final enquanto os dados chegam
  try {
    const [status, alerts, notes, outages, config] = await Promise.all([
      api.status(), api.alerts(), api.annotations(), api.outages(90), api.config(),
    ]);
    for (const a of alerts.all || []) seenAlerts.add(a.id);
    store.set({
      meta: status.meta, sample: status.sample, health: status.health,
      alerts: { active: alerts.active || [], all: alerts.all || [] },
      annotations: notes.annotations || [], outages, config, loading: false,
    });
  } catch {
    store.set({ loading: false }); // 401 abre o login; painel fora do ar: o SSE avisa e tenta de novo
  }
  if (loginShown) return;
  connect({
    onEvent,
    onState: (live) => store.set({ live }),
    onAuthLost: () => showLogin('Sessão expirada. Entre de novo.'),
  });
}

start();
