// 5. Processos & serviços: estado de cada serviço monitorado e os processos que mais usam
// memória, com filtro e ordenação (o filtro sobrevive às atualizações ao vivo).
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { badge, $ } from './common.js';

const COLS = [
  { key: 'user', label: 'Usuário' }, { key: 'pid', label: 'PID', num: true },
  { key: 'cpu', label: 'CPU %', num: true }, { key: 'mem', label: 'Mem %', num: true },
  { key: 'rssKB', label: 'Memória', num: true }, { key: 'etimesSec', label: 'Rodando há', num: true },
  { key: 'cmd', label: 'Comando' },
];
const SVC = { active: ['ok', 'ativo'], reloading: ['ok', 'recarregando'], activating: ['warn', 'iniciando'], desconhecido: ['neutral', 'sem resposta'] };

const view = { filter: '', sort: { key: 'rssKB', dir: -1 } };

function services(s) {
  const list = Object.entries(s?.services || {});
  if (!list.length) return html`<p class="empty">Nenhum serviço monitorado (SERVICES no .env).</p>`;
  return html`<ul class="service-list">${list.map(([name, st]) => {
    const [level, text] = SVC[st] || ['bad', st];
    return html`<li><b>${name}</b> ${badge(level, text)}</li>`;
  })}</ul>`;
}

function rows(s) {
  const q = view.filter.toLowerCase();
  const { key, dir } = view.sort;
  const list = (s?.topProcs || [])
    .filter((p) => !q || `${p.user} ${p.pid} ${p.cmd}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });
  if (!list.length) return html`<tr><td colspan="7" class="empty">${q ? 'Nada com esse filtro.' : 'Sem processos na última coleta.'}</td></tr>`;
  return list.map((p) => html`<tr>
    <td>${p.user}</td><td>${p.pid}</td><td>${f.num(p.cpu, 1)}</td><td>${f.num(p.mem, 1)}</td>
    <td>${f.bytes(typeof p.rssKB === 'number' ? p.rssKB * 1024 : null)}</td><td>${f.duration(p.etimesSec)}</td>
    <td class="cmd" title="${p.cmd}">${p.cmd}</td></tr>`);
}

export function render(ctx) {
  mount(ctx.el, html`
    <section class="panel"><h3 class="panel-title">Serviços</h3><div id="pr-services"></div></section>
    <section class="panel">
      <h3 class="panel-title">Processos que mais usam memória <span class="hint">top 8 da última coleta</span></h3>
      <div class="toolbar"><input type="search" id="pr-filter" placeholder="Filtrar por usuário, PID ou comando (atalho /)" aria-label="Filtrar processos" value="${view.filter}"></div>
      <div class="table-wrap"><table>
        <thead><tr>${COLS.map((c) => html`<th><button class="th-sort" data-sort="${c.key}" aria-label="Ordenar por ${c.label}">${c.label}${view.sort.key === c.key ? (view.sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`)}</tr></thead>
        <tbody id="pr-rows"></tbody>
      </table></div>
    </section>`);
  $('#pr-filter', ctx.el).addEventListener('input', (e) => { view.filter = e.target.value; update(ctx); });
  for (const b of ctx.el.querySelectorAll('[data-sort]')) {
    b.addEventListener('click', () => {
      const k = b.dataset.sort;
      view.sort = { key: k, dir: view.sort.key === k ? -view.sort.dir : (COLS.find((c) => c.key === k).num ? -1 : 1) };
      render(ctx);
    });
  }
  update(ctx);
}

export function update(ctx) {
  mount($('#pr-services', ctx.el), services(ctx.state.sample));
  mount($('#pr-rows', ctx.el), html`${rows(ctx.state.sample)}`);
}

export const focusSearch = (ctx) => $('#pr-filter', ctx.el)?.focus();
