window.Dash = window.Dash || {};

Dash.router = {
  TITLES: {
    overview: 'Visão Geral',
    discos: 'Discos',
    rede: 'Rede',
    processos: 'Processos',
    alertas: 'Alertas',
    anotacoes: 'Anotações',
    analise: 'Análise',
    historico: 'Histórico',
    ajuda: 'Ajuda',
  },

  current() {
    const hash = location.hash || '#/';
    const view = hash.replace(/^#\//, '').split('?')[0] || 'overview';
    return this.TITLES[view] ? view : 'overview';
  },

  navigate() {
    const view = this.current();
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const el = document.getElementById('view-' + view);
    if (el) el.classList.add('active');
    document.querySelectorAll('.nav-item').forEach((a) => {
      const on = a.dataset.view === view;
      a.classList.toggle('active', on);
      try {
        if (typeof a.setAttribute === 'function' && typeof a.removeAttribute === 'function') {
          if (on) a.setAttribute('aria-current', 'page');
          else a.removeAttribute('aria-current');
        }
      } catch { /* noop */ }
    });
    const title = document.getElementById('viewTitle');
    if (title) title.textContent = this.TITLES[view];
    Dash.charts.resize();
    Dash.sections.renderActiveView();
  },

  init() {
    window.addEventListener('hashchange', () => this.navigate());
    this.navigate();
  },
};