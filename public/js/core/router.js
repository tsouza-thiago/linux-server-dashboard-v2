// Rotas por hash com o período na URL (`#/armazenamento?p=24h`): recarregar ou mandar o
// link mantém a tela e o período. Atalhos 1–8 seguem a ordem das telas.
// `group` separa a navegação (Monitorar / Analisar); `period` = a tela usa o período do topo.
export const VIEWS = [
  { id: 'visao-geral', title: 'Visão geral', key: '1', group: 'Monitorar', period: true },
  { id: 'recursos', title: 'Recursos', key: '2', group: 'Monitorar', period: true },
  { id: 'armazenamento', title: 'Armazenamento', key: '3', group: 'Monitorar', period: true },
  { id: 'rede', title: 'Rede', key: '4', group: 'Monitorar', period: true },
  { id: 'processos', title: 'Processos & serviços', key: '5', group: 'Monitorar', period: false },
  { id: 'eventos', title: 'Eventos', key: '6', group: 'Analisar', period: false },
  { id: 'relatorios', title: 'Relatórios', key: '7', group: 'Analisar', period: false },
  { id: 'ajuda', title: 'Ajuda', key: '8', group: 'Analisar', period: false },
];

/** Períodos do topo, em ms. */
export const PERIODS = {
  '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '72h': 72 * 3600e3,
  '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3,
};
const DEFAULT_VIEW = 'visao-geral';
const DEFAULT_PERIOD = '24h';

/** Lê `#/tela?p=período`; tela ou período desconhecidos voltam ao padrão. */
export function parseHash(hash) {
  const text = String(hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = text.split('?');
  const view = VIEWS.some((v) => v.id === path) ? path : DEFAULT_VIEW;
  const params = new URLSearchParams(query);
  const p = params.get('p');
  return { view, period: Object.hasOwn(PERIODS, p || '') ? p : DEFAULT_PERIOD };
}

/** Monta o hash (o período padrão não aparece na URL). */
export function buildHash({ view = DEFAULT_VIEW, period = DEFAULT_PERIOD } = {}) {
  return period === DEFAULT_PERIOD ? `#/${view}` : `#/${view}?p=${period}`;
}

/** Tela do atalho de teclado ("1"–"8"). */
export const viewByKey = (key) => VIEWS.find((v) => v.key === key) || null;
