// 2. Recursos: CPU (com espera de disco), load, RAM/swap, pressão (PSI) e temperatura, em
// faixas com o cursor sincronizado. A linha tracejada é o pico de cada intervalo.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { chartPanel, drawCharts, $ } from './common.js';

const CHARTS = [
  { id: 'rc-cpu', format: (v) => f.pct(v), range: [0, 100], series: [
    { label: 'CPU média', key: 'cpu' }, { label: 'CPU pico', key: 'cpu', stat: 'max', dash: true }, { label: 'espera de disco', key: 'cpuIowait', color: 2 }] },
  { id: 'rc-load', format: (v) => f.num(v, 2), series: [
    { label: '1 min', key: 'load1' }, { label: '5 min', key: 'load5', color: 1 }, { label: '15 min', key: 'load15', color: 3 }] },
  { id: 'rc-ram', format: (v) => f.pct(v), range: [0, 100], series: [
    { label: 'RAM média', key: 'ramPct', color: 1 }, { label: 'RAM pico', key: 'ramPct', stat: 'max', color: 1, dash: true }] },
  { id: 'rc-swap', format: f.mb, series: [{ label: 'swap usado', key: 'swapUsed', color: 3 }] },
  { id: 'rc-psi', format: (v) => f.pct(v, v < 1 ? 2 : 1), series: [
    { label: 'CPU', key: 'psi:cpu' }, { label: 'memória', key: 'psi:memory', color: 1 }, { label: 'disco', key: 'psi:io', color: 2 }] },
  { id: 'rc-temp', format: f.celsius, series: [
    { label: 'média', key: 'tempC', color: 2 }, { label: 'pico', key: 'tempC', stat: 'max', color: 2, dash: true }] },
];

function ramDetail(s) {
  const r = s?.ram;
  if (!r) return html`<p class="empty">Sem dados de memória ainda.</p>`;
  const row = (k, v) => html`<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  return html`
    ${row('Total', f.mb(r.total))}${row('Em uso', f.mb(r.used))}${row('Disponível', f.mb(r.avail))}
    ${row('Cache e buffers', f.mb(r.cache))}${row('Swap', `${f.mb(r.swapUsed)} de ${f.mb(r.swapTotal)}`)}
    ${row('Sujo para gravar (Dirty)', f.mb(r.dirty))}${row('Gravando (Writeback)', f.mb(r.writeback))}`;
}

export function render(ctx) {
  mount(ctx.el, html`
    <div class="grid-2">
      ${chartPanel('rc-cpu', 'Processador', 'espera de disco alta = disco sofrendo')}
      ${chartPanel('rc-load', 'Load', `núcleos: ${ctx.state.sample?.cores ?? '—'}`)}
      ${chartPanel('rc-ram', 'Memória usada')}
      ${chartPanel('rc-swap', 'Swap usado')}
      ${chartPanel('rc-psi', 'Pressão (PSI, % do tempo esperando)', 'melhor sinal de engasgo em 1 núcleo')}
      ${chartPanel('rc-temp', 'Temperatura')}
    </div>
    <section class="panel">
      <h3 class="panel-title">Memória agora</h3>
      <div id="rc-ram-detail"></div>
    </section>`);
  update(ctx);
}

export function update(ctx) {
  mount($('#rc-ram-detail', ctx.el), ramDetail(ctx.state.sample));
  drawCharts(ctx, ctx.el, CHARTS);
}
