// Rotas por hash com o período na URL (`#/armazenamento?p=24h`): recarregar ou mandar o
// link mantém a tela e o período. Atalhos 1–8 seguem a ordem das telas.
export const VIEWS = [
  { id: 'visao-geral', title: 'Visão geral', key: '1' },
  { id: 'recursos', title: 'Recursos', key: '2' },
  { id: 'armazenamento', title: 'Armazenamento', key: '3' },
  { id: 'rede', title: 'Rede', key: '4' },
  { id: 'processos', title: 'Processos & serviços', key: '5' },
  { id: 'eventos', title: 'Eventos', key: '6' },
  { id: 'relatorios', title: 'Relatórios', key: '7' },
  { id: 'ajuda', title: 'Ajuda', key: '8' },
];

export const PERIODS = {
  '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '72h': 72 * 3600e3,
  '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3,
};
export const DEFAULT_VIEW = 'visao-geral';
export const DEFAULT_PERIOD = '24h';

export function parseHash(hash) {
  const text = String(hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = text.split('?');
  const view = VIEWS.some((v) => v.id === path) ? path : DEFAULT_VIEW;
  const params = new URLSearchParams(query);
  const p = params.get('p');
  return { view, period: Object.hasOwn(PERIODS, p || '') ? p : DEFAULT_PERIOD };
}

export function buildHash({ view = DEFAULT_VIEW, period = DEFAULT_PERIOD } = {}) {
  return period === DEFAULT_PERIOD ? `#/${view}` : `#/${view}?p=${period}`;
}

export const viewByKey = (key) => VIEWS.find((v) => v.key === key) || null;
