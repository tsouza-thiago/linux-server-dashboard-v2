// 5. Processos & serviços: estado de cada serviço
// monitorado com o histórico de quedas, os processos que mais usam memória (busca e
// ordenação sobrevivem às atualizações ao vivo) e para onde vai a memória.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { $, iconBox, meter, panelHead, skelCabeca, skelLinha, skelTabela, skelTexto } from './common.js';

/** Subtítulo da tela. */
export const sub = () => 'Serviços monitorados e os processos que mais usam memória, na última coleta';

// Colunas da tabela de processos (ordenáveis).
const COLS = [
  { key: 'pid', label: 'PID', num: true },
  { key: 'cmd', label: 'Comando' },
  { key: 'user', label: 'Usuário' },
  { key: 'mem', label: 'Memória', num: true },
  { key: 'rssKB', label: 'RSS', num: true },
  { key: 'cpu', label: 'CPU média*', num: true },
  { key: 'etimesSec', label: 'Rodando há', num: true },
];
// Estado do systemd → [nível, texto, ícone]; o resto é parado (crítico).
const SVC = {
  active: ['ok', 'ativo', 'check'], reloading: ['ok', 'recarregando', 'check'], activating: ['warn', 'iniciando', 'warn'],
  desconhecido: ['neutral', 'sem resposta', 'serious'],
};
// Busca e ordenação da tabela (ficam enquanto a tela está aberta).
const view = { filter: '', sort: { key: 'mem', dir: -1 } };

/** Um cartão por serviço, com o histórico de quedas. */
function services(state) {
  const list = Object.entries(state.sample?.services || {});
  const all = state.alerts?.all || [];
  const cards = list.map(([name, st]) => {
    const [level, text, ic] = SVC[st] || ['crit', st || 'parado', 'crit'];
    const downs = all.filter((a) => a.key === `service:${name}`);
    const last = downs[0];
    const hist = !downs.length ? 'sem quedas registradas'
      : `${downs.length} queda${downs.length > 1 ? 's' : ''} · a última em ${f.dateTime(last.ts)}${last.resolvedAt ? ` (${f.duration((Date.parse(last.resolvedAt) - Date.parse(last.ts)) / 1000)})` : ''}`;
    return html`<article class="card svc-card stale">
      ${iconBox(level, ic, 'lg')}
      <div class="svc-text"><span class="mono svc-name">${name}</span><span class="ink-${level === 'neutral' ? '2' : level}">${text}</span><span class="note">${hist}</span></div>
    </article>`;
  });
  return html`${cards}
    <article class="card svc-card svc-add">
      ${iconBox('', 'plus', 'lg')}
      <div class="svc-text"><span class="ink-2">Monitorar ${list.length ? 'outro serviço' : 'um serviço'}</span><span class="note">adicione o nome em <span class="mono">SERVICES</span> no <span class="mono">.env</span></span></div>
    </article>`;
}

/** Linhas da tabela de processos, filtradas e ordenadas. */
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
  if (!list.length) return html`<tr><td colspan="7" class="empty">${q ? 'Nada com essa busca.' : 'Sem processos na última coleta.'}</td></tr>`;
  const maxMem = Math.max(...(s.topProcs || []).map((p) => p.mem || 0), 1);
  return list.map((p) => html`<tr>
    <td class="ink-3">${p.pid}</td>
    <td title="${p.cmd}">${f.cmdName(p.cmd)}</td>
    <td class="ink-2">${p.user}</td>
    <td class="num"><span class="mem-cell">${meter({ pct: ((p.mem || 0) / maxMem) * 100, color: 's2' }, { size: 'sm' })}${f.pct(p.mem, 1)}</span></td>
    <td class="num ink-2">${f.bytes(typeof p.rssKB === 'number' ? p.rssKB * 1024 : null)}</td>
    <td class="num ink-2">${f.pct(p.cpu, 1)}</td>
    <td class="num ink-2">${f.duration(p.etimesSec)}</td></tr>`);
}

/** Cabeçalho da tabela com a ordenação atual. */
function head() {
  return html`<tr>${COLS.map((c) => {
    const on = view.sort.key === c.key;
    return html`<th scope="col" class="${c.num ? 'num' : ''}" ${on ? html`aria-sort="${view.sort.dir < 0 ? 'descending' : 'ascending'}"` : ''}>
      <button class="th-sort" type="button" data-sort="${c.key}">${c.label}${on ? (view.sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`;
  })}</tr>`;
}

/** "Para onde vai a memória": usada, cache, disponível e os maiores processos. */
function memory(s) {
  const r = s?.ram;
  const procs = (s?.topProcs || []).slice().sort((a, b) => (b.rssKB ?? 0) - (a.rssKB ?? 0));
  if (!r?.total) return html`<p class="empty">Sem dados de memória ainda.</p>`;
  const mb = (kb) => (kb || 0) / 1024;
  const top2 = procs.slice(0, 2);
  const rest = procs.slice(2);
  const restMb = rest.reduce((sum, p) => sum + mb(p.rssKB), 0);
  const topMb = procs.reduce((sum, p) => sum + mb(p.rssKB), 0);
  const othersMb = Math.max(0, r.used - topMb);
  const pct = (v) => (v / r.total) * 100;
  return html`
    ${meter([
    ...top2.map((p, i) => ({ pct: pct(mb(p.rssKB)), color: 's2', op: 1 - i * 0.2 })),
    { pct: pct(restMb), color: 's2', op: 0.6 }, { pct: pct(othersMb), color: 's2', op: 0.35 }], { size: 'lg mem-split' })}
    <div class="kv-list">
      ${top2.map((p) => html`<div class="kv"><span>${f.cmdName(p.cmd)}</span><span class="mono ink-2">${f.bytes(p.rssKB * 1024)}</span></div>`)}
      ${rest.length ? html`<div class="kv"><span>outros ${rest.length} do topo</span><span class="mono ink-2">${f.mb(restMb)}</span></div>` : ''}
      <div class="kv"><span>demais processos e kernel</span><span class="mono ink-2">${f.mb(othersMb)}</span></div>
      <div class="kv sep"><span class="ink-2">disponível</span><span class="mono ink-2">${f.mb(r.avail)}</span></div>
    </div>`;
}

/** Esqueleto no formato da tela (na coleta, são até 8 processos). */
export const ownSkeleton = (state) => html`
  <section class="grid-cards svc-grid">${Array.from({ length: Object.keys(state.sample?.services || {}).length + 1 }, () => html`
    <article class="card svc-card"><span class="icon-box lg"></span><div class="svc-text"><span class="svc-name">${skelLinha(50)}</span><span>${skelLinha(40)}</span><span class="note">${skelLinha(80)}</span></div></article>`)}</section>
  <div class="split">
    <section class="panel flush split-main">
      <div class="panel-head"><div><h2>${skelLinha(40)}</h2></div><div class="search"><label>&nbsp;</label><span class="input">&nbsp;</span></div></div>
      ${skelTabela(8, COLS.length, { cabeca: head() })}
    </section>
    <section class="panel split-side">${skelCabeca()}${skelTexto(7)}</section>
  </div>`;

/** Monta a tela inteira. */
export function render(ctx) {
  mount(ctx.el, html`
    <section class="grid-cards svc-grid" aria-label="Serviços monitorados" id="pr-services"></section>
    <div class="split">
      <section class="panel flush stale split-main" aria-label="Top processos por memória">
        <div class="panel-head">
          <div><h2>Top processos · última coleta</h2></div>
          <div class="search"><label for="pr-filter">Buscar</label><input class="input" type="search" id="pr-filter" placeholder="comando ou usuário (atalho /)" value="${view.filter}"></div>
        </div>
        <div class="table-wrap"><table class="table">
          <thead id="pr-head"></thead>
          <tbody class="mono" id="pr-rows"></tbody>
        </table></div>
        <p class="note table-foot">* A CPU de cada processo é a média desde que ele começou a rodar (é o que o servidor informa sem instalar nada). O uso de CPU <b>atual</b> está em Recursos.</p>
      </section>
      <section class="panel stale split-side" aria-label="Para onde vai a memória">
        ${panelHead('Para onde vai a memória')}
        <div class="vstack" id="pr-memory"></div>
      </section>
    </div>`);
  $('#pr-filter', ctx.el).addEventListener('input', (e) => { view.filter = e.target.value; update(ctx); });
  $('#pr-head', ctx.el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    const k = b.dataset.sort;
    view.sort = { key: k, dir: view.sort.key === k ? -view.sort.dir : (COLS.find((c) => c.key === k).num ? -1 : 1) };
    update(ctx);
    $(`[data-sort="${k}"]`, ctx.el)?.focus();
  });
  update(ctx);
}

/** Atualiza só o que muda com os dados novos. */
export function update(ctx) {
  const s = ctx.state.sample;
  mount($('#pr-services', ctx.el), services(ctx.state));
  mount($('#pr-head', ctx.el), head());
  mount($('#pr-rows', ctx.el), html`${rows(s)}`);
  mount($('#pr-memory', ctx.el), memory(s));
}

/** Leva o cursor à busca de processos (tecla /). */
export const focusSearch = (ctx) => $('#pr-filter', ctx.el)?.focus();
