window.Dash = window.Dash || {};

(function init() {
  Dash.period = '24h';
  Dash.samples = [];
  Dash.latest = null;
  Dash.alerts = { active: [], all: [] };
  Dash.annotations = [];
  Dash.diskDetailMount = null;
  Dash.ioDev = 'sda';
  Dash.procsSort = { key: 'mem', dir: -1 };
  Dash.procsFilter = '';
  Dash.alertFilter = 'active';
  Dash.nextPollAt = null;

  const PERIOD_MS = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '72h': 259200000 };
  const THEME_KEY = 'dash_theme';

  function currentTheme() {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch { /* noop */ }
    if (stored === 'light' || stored === 'dark') return stored;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  function applyTheme(theme) {
    Dash.theme = theme;
    try { document.documentElement.dataset.theme = theme; } catch { /* noop */ }
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* noop */ }
  }

  function toggleTheme() {
    applyTheme(Dash.theme === 'dark' ? 'light' : 'dark');
    try {
      if (Dash.charts && typeof Dash.charts.retheme === 'function') Dash.charts.retheme();
    } catch { /* noop */ }
  }

  // Sessão por cookie (ADR 0007): o navegador manda o cookie sozinho; nada de token na URL
  // nem guardado pelo JavaScript. 401 abre a janela de login.
  async function apiFetch(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (res.status === 401) showLogin();
    return res;
  }

  function showLogin(message = '') {
    const box = $('login');
    if (!box) return;
    box.hidden = false;
    $('loginError').textContent = message;
    const input = $('loginToken');
    if (input && typeof input.focus === 'function') input.focus();
  }

  async function submitLogin(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    const token = String($('loginToken').value || '').trim();
    if (!token) return;
    $('loginSubmit').disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        $('loginToken').value = '';
        window.location.reload();
        return;
      }
      let msg = 'Token incorreto';
      try { msg = (await res.json()).error || msg; } catch { /* resposta sem JSON */ }
      $('loginError').textContent = res.status === 429 ? 'Muitas tentativas — aguarde 1 minuto.' : msg;
    } catch {
      $('loginError').textContent = 'Painel inacessível — confira se o serviço está rodando.';
    } finally {
      $('loginSubmit').disabled = false;
    }
  }

  async function logout(all) {
    await fetch(all ? '/api/logout-all' : '/api/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.reload();
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const s = await res.json();
      const box = $('sessionHelp');
      if (box) box.hidden = !s.authRequired;
      return s;
    } catch {
      return null;
    }
  }

  function periodRange() {
    const from = new Date(Date.now() - PERIOD_MS[Dash.period]).toISOString();
    return `from=${encodeURIComponent(from)}`;
  }

  function updateAlertBadge() {
    const n = Dash.alerts.active.length;
    const b = $('alertBadge');
    b.hidden = n === 0;
    b.textContent = n;
  }

  function setStatus(payload) {
    const meta = payload.meta || {};
    const online = !!meta.online;
    $('statusDot').className = `dot ${online ? 'dot-online' : 'dot-offline'}`;
    const st = $('statusText');
    if (st) st.textContent = online ? 'online' : 'offline';
    $('lastPollAt').textContent = Dash.fmt.time(meta.lastPollAt) + (meta.lastError ? ` · ${meta.lastError}` : '');
    Dash.nextPollAt = meta.nextPollAt ? Date.parse(meta.nextPollAt) : null;
    if (payload.health) Dash.health = payload.health;
    if (payload.sample && payload.sample.os && payload.sample.os.name) {
      $('osLabel').textContent = payload.sample.os.name;
    }
  }

  Dash.api = {
    async ackAlert(id) {
      await apiFetch(`/api/alerts/${id}/ack`, { method: 'POST' });
      await refreshAlerts();
    },
    async resolveAlert(id) {
      await apiFetch(`/api/alerts/${id}/resolve`, { method: 'POST' });
      await refreshAlerts();
    },
    async addAnnotation(sample) {
      const text = prompt(`Anotação para ${Dash.fmt.timeDate(sample.ts)}:`);
      if (!text || !text.trim()) return;
      await apiFetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts: sample.ts, text: text.trim(), label: text.trim().slice(0, 40) }),
      });
      const res = await apiFetch('/api/annotations');
      Dash.annotations = (await res.json()).annotations || [];
      Dash.charts.applyAnnotations();
      Dash.sections.annotationsView();
    },
    async deleteAnnotation(id) {
      await apiFetch(`/api/annotations/${id}`, { method: 'DELETE' });
      const res = await apiFetch('/api/annotations');
      Dash.annotations = (await res.json()).annotations || [];
      Dash.charts.applyAnnotations();
      Dash.sections.annotationsView();
    },
    async addAnnotationNow() {
      const input = $('annotationText');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await apiFetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, label: text.slice(0, 40) }),
      });
      const res = await apiFetch('/api/annotations');
      Dash.annotations = (await res.json()).annotations || [];
      Dash.charts.applyAnnotations();
      Dash.sections.annotationsView();
    },
  };

  async function refreshAlerts() {
    const res = await apiFetch('/api/alerts?limit=200');
    if (!res.ok) return;
    const data = await res.json();
    Dash.alerts.active = data.active || [];
    Dash.alerts.all = data.all || [];
    updateAlertBadge();
    Dash.sections.alertBar(Dash.alerts.active);
    Dash.sections.health(Dash.latest);
    if (Dash.router.current() === 'alertas') Dash.sections.alertsView();
  }

  // Quedas e uptime do registro próprio do servidor (atualizado em quedas e na volta).
  async function refreshOutages() {
    try {
      const res = await apiFetch('/api/outages?days=30');
      if (!res.ok) return;
      Dash.outages = await res.json();
      if (Dash.router.current() === 'analise') Dash.sections.analysis();
    } catch { /* tenta de novo no próximo evento */ }
  }

  async function refreshAll() {
    try {
      const [h, st, al, an] = await Promise.all([
        apiFetch(`/api/history?limit=720&${periodRange()}`).then((r) => r.json()),
        apiFetch('/api/status').then((r) => r.json()),
        apiFetch('/api/alerts?limit=200').then((r) => r.json()),
        apiFetch('/api/annotations').then((r) => r.json()),
      ]);
      Dash.samples = h.samples || [];
      Dash.alerts.active = al.active || [];
      Dash.alerts.all = al.all || [];
      Dash.annotations = an.annotations || [];
      setStatus(st);
      if (st.sample) Dash.latest = st.sample;
      updateAlertBadge();
      Dash.charts.resetZoom();
      Dash.charts.sync();
      Dash.charts.applyAnnotations();
      Dash.sections.health(Dash.latest);
      Dash.sections.alertBar(Dash.alerts.active);
      Dash.sections.overview(Dash.latest);
      renderActiveView();
      refreshOutages();
    } catch (err) {
      console.error('refreshAll falhou, tentando de novo em 10s', err);
      setTimeout(refreshAll, 10000);
    }
  }

  function renderActiveView() {
    const view = Dash.router.current();
    const latest = Dash.latest;
    switch (view) {
      case 'discos':
        Dash.sections.disks(latest);
        if (latest && Dash.diskDetailMount) $('diskDetailMount').textContent = Dash.diskDetailMount;
        Dash.charts.sync();
        break;
      case 'rede':
        Dash.sections.net(latest);
        Dash.sections.ioDevTabs();
        Dash.charts.sync();
        break;
      case 'processos':
        Dash.sections.procs(latest);
        break;
      case 'alertas':
        Dash.sections.alertsView();
        break;
      case 'anotacoes':
        Dash.sections.annotationsView();
        break;
      case 'analise':
        Dash.sections.analysis();
        break;
      case 'historico':
        Dash.sections.history();
        break;
      default:
        break;
    }
  }

  function openSSE() {
    const es = new EventSource('/api/stream');
    es.addEventListener('hello', (e) => {
      const payload = JSON.parse(e.data);
      setStatus(payload);
      if (payload.sample) {
        Dash.latest = payload.sample;
        Dash.sections.health(Dash.latest);
        Dash.sections.overview(Dash.latest);
        renderActiveView();
      }
    });
    es.addEventListener('sample', (e) => {
      const payload = JSON.parse(e.data);
      // Backfill após reconexão: ignora o que a tela já tem (amostras chegam em ordem).
      const last = Dash.samples.length ? Dash.samples[Dash.samples.length - 1].ts : '';
      if (payload.sample && payload.sample.ts <= last) return;
      Dash.latest = payload.sample;
      Dash.alerts.active = payload.alerts || [];
      if (payload.health) Dash.health = payload.health;
      if (Dash.outages && Dash.outages.outages.some((o) => o.ongoing)) refreshOutages();
      Dash.samples.push(payload.sample);
      const fromTs = Date.now() - PERIOD_MS[Dash.period];
      Dash.samples = Dash.samples.filter((s) => Date.parse(s.ts) >= fromTs);
      if (Dash.samples.length > 1500) Dash.samples.splice(0, Dash.samples.length - 1500);
      Dash.sections.health(Dash.latest);
      Dash.sections.alertBar(Dash.alerts.active);
      Dash.sections.overview(Dash.latest);
      updateAlertBadge();
      Dash.charts.sync();
      renderActiveView();
    });
    es.addEventListener('alerts', (e) => {
      const payload = JSON.parse(e.data);
      Dash.alerts.active = payload.alerts || [];
      Dash.alerts.all = payload.all || Dash.alerts.all;
      updateAlertBadge();
      Dash.sections.alertBar(Dash.alerts.active);
      Dash.sections.health(Dash.latest);
      if (Dash.router.current() === 'alertas') Dash.sections.alertsView();
    });
    es.addEventListener('annotations', (e) => {
      Dash.annotations = JSON.parse(e.data).annotations || [];
      Dash.charts.applyAnnotations();
      if (Dash.router.current() === 'anotacoes') Dash.sections.annotationsView();
    });
    es.addEventListener('status', (e) => {
      const payload = JSON.parse(e.data);
      setStatus(payload);
      Dash.sections.health(Dash.latest);
      if (payload.meta && payload.meta.online === false) refreshOutages();
    });
    // Sem sessão o EventSource só vê "erro": confere a sessão em vez de tentar em loop.
    es.onerror = async () => {
      $('statusDot').className = 'dot dot-offline';
      const s = await checkSession();
      if (s && s.authRequired && !s.authenticated) {
        es.close();
        showLogin('Sessão expirada — entre de novo.');
      }
    };
  }

  function setNavOpen(open) {
    const btn = $('navToggle');
    if (btn) {
      if (typeof btn.setAttribute === 'function') {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.setAttribute('aria-label', open ? 'Fechar navegação' : 'Abrir navegação');
      } else {
        btn['aria-expanded'] = open ? 'true' : 'false';
      }
    }
    try {
      document.documentElement.classList.toggle('nav-open', !!open);
    } catch { /* noop */ }
  }

  function wireUI() {
    const navToggle = $('navToggle');
    if (navToggle) navToggle.addEventListener('click', () => {
      let open = false;
      try { open = document.documentElement.classList.contains('nav-open'); } catch { /* noop */ }
      setNavOpen(!open);
    });
    const navScrim = $('navScrim');
    if (navScrim) navScrim.addEventListener('click', () => setNavOpen(false));
    try {
      document.querySelectorAll('.nav-item').forEach((a) => a.addEventListener('click', () => setNavOpen(false)));
    } catch { /* noop */ }
    $('pollBtn').addEventListener('click', async () => {
      $('pollBtn').disabled = true;
      try {
        await apiFetch('/api/poll', { method: 'POST' });
      } finally {
        setTimeout(() => { $('pollBtn').disabled = false; }, 5000);
      }
    });

    $('periodToggle').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('periodToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        Dash.period = btn.dataset.period;
        refreshAll();
      });
    });

    $('exportBtn').addEventListener('click', async () => {
      const res = await apiFetch(`/api/export?format=csv&${periodRange()}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dashboard-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

    $('procSearch').addEventListener('input', (e) => {
      Dash.procsFilter = e.target.value;
      Dash.sections.procs(Dash.latest);
    });
    $('procsTable').querySelectorAll('th').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (!key) return;
        if (Dash.procsSort.key === key) Dash.procsSort.dir *= -1;
        else Dash.procsSort = { key, dir: -1 };
        Dash.sections.procs(Dash.latest);
      });
    });

    $('alertFilters').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('alertFilters').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        Dash.alertFilter = btn.dataset.filter;
        Dash.sections.alertsView();
      });
    });

    $('modalClose').addEventListener('click', () => Dash.sections.modal.close());
    $('modal').addEventListener('click', (e) => {
      if (e.target === $('modal')) Dash.sections.modal.close();
    });
    $('modalAnnotate').addEventListener('click', () => {
      if (Dash.sections.modal.sample) Dash.api.addAnnotation(Dash.sections.modal.sample);
    });

    $('themeToggle').addEventListener('click', toggleTheme);
    $('loginForm').addEventListener('submit', submitLogin);
    $('logoutBtn').addEventListener('click', () => logout(false));
    $('logoutAllBtn').addEventListener('click', () => logout(true));

    $('annotationAdd').addEventListener('click', () => Dash.api.addAnnotationNow());
    $('annotationText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') Dash.api.addAnnotationNow();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') Dash.sections.modal.close();
    });

    setInterval(() => {
      if (!Dash.nextPollAt) return;
      const ms = Dash.nextPollAt - Date.now();
      $('countdown').textContent = ms > 0 ? `${Math.ceil(ms / 1000)}s` : 'coletando…';
    }, 500);
  }

  Dash.sections.renderActiveView = renderActiveView;

  applyTheme(currentTheme());
  Dash.charts.registerSpecs();
  Dash.router.init();
  wireUI();
  // Sem sessão (e com token exigido): só o login, sem abrir API nem SSE. Se a checagem
  // falhar (painel fora do ar), segue o fluxo normal, que trata o erro sozinho.
  checkSession().then((s) => {
    if (s && s.authRequired && !s.authenticated) {
      showLogin();
      return;
    }
    refreshAll().then(openSSE);
  });
})();