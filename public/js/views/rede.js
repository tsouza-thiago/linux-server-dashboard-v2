// 4. Rede: vazão de entrada/saída, totais desde o boot e erros/descartes da interface.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { chartPanel, drawCharts, $ } from './common.js';

const CHARTS = [
  { id: 'rd-vazao', format: f.mbps, series: [
    { label: 'entrada média', key: 'rxMbps' }, { label: 'entrada pico', key: 'rxMbps', stat: 'max', dash: true },
    { label: 'saída média', key: 'txMbps', color: 1 }, { label: 'saída pico', key: 'txMbps', stat: 'max', color: 1, dash: true }] },
];

function summary(s) {
  const n = s?.net;
  if (!n) return html`<p class="empty">Interface de rede não configurada (NET_IF no .env).</p>`;
  const row = (k, v) => html`<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  return html`
    ${row('Interface', n.iface)}
    ${row('Entrada agora', f.mbps(n.rxMbps))}${row('Saída agora', f.mbps(n.txMbps))}
    ${row('Recebido desde o boot', f.bytes(n.rxBytes))}${row('Enviado desde o boot', f.bytes(n.txBytes))}
    ${row('Erros (entrada / saída)', `${f.num(n.rxErrors)} / ${f.num(n.txErrors)}`)}
    ${row('Descartes (entrada / saída)', `${f.num(n.rxDrops)} / ${f.num(n.txDrops)}`)}`;
}

export function render(ctx) {
  mount(ctx.el, html`
    ${chartPanel('rd-vazao', 'Vazão', 'tracejado = pico do intervalo')}
    <section class="panel"><h3 class="panel-title">Interface</h3><div id="rd-summary"></div></section>`);
  update(ctx);
}

export function update(ctx) {
  mount($('#rd-summary', ctx.el), summary(ctx.state.sample));
  drawCharts(ctx, ctx.el, CHARTS);
}
