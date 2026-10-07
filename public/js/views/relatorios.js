// 7. Relatórios: resumo por dia (fuso local, B5) dos últimos 30 dias e exportação do
// período escolhido em CSV ou JSON.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { dailySummary } from '../core/analysis.js';
import { PERIODS } from '../core/router.js';
import { $ } from './common.js';

const KEYS = ['cpu', 'ramPct', 'tempC', 'rxMbps', 'txMbps', 'load1'];
const mm = (m, key, fn, which = ['avg', 'max']) => (m[key] ? which.map((w) => fn(m[key][w])).join(' / ') : '—');

function table(daily) {
  if (!daily) return html`<p class="empty">Carregando resumo…</p>`;
  if (!daily.length) return html`<p class="empty">Sem dados nos últimos 30 dias.</p>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Dia</th><th>CPU média / pico</th><th>Load média / pico</th><th>RAM média / pico</th><th>Temp. mín / máx</th><th>Rede pico ↓ / ↑</th><th>Coletas</th></tr></thead>
    <tbody>${daily.map((d) => html`<tr>
      <td><b>${d.day.split('-').reverse().join('/')}</b></td>
      <td>${mm(d.m, 'cpu', (v) => f.pct(v))}</td>
      <td>${mm(d.m, 'load1', (v) => f.num(v, 2))}</td>
      <td>${mm(d.m, 'ramPct', (v) => f.pct(v))}</td>
      <td>${mm(d.m, 'tempC', f.celsius, ['min', 'max'])}</td>
      <td>${d.m.rxMbps ? `${f.mbps(d.m.rxMbps.max)} / ${f.mbps(d.m.txMbps?.max)}` : '—'}</td>
      <td>${d.n}</td></tr>`)}</tbody>
  </table></div>`;
}

export function render(ctx) {
  const to = new Date();
  const from = new Date(to.getTime() - PERIODS[ctx.state.period]);
  const link = (format) => ctx.api.exportUrl({ format, from: from.toISOString(), to: to.toISOString() });
  mount(ctx.el, html`
    <section class="panel">
      <h3 class="panel-title">Exportar <span class="hint">período escolhido no topo (${ctx.state.period})</span></h3>
      <p class="toolbar">
        <a class="btn-ghost" href="${link('csv')}" download>Baixar CSV</a>
        <a class="btn-ghost" href="${link('json')}" download>Baixar JSON</a>
        <button class="btn-ghost" id="rl-print" type="button">Imprimir</button>
      </p>
    </section>
    <section class="panel">
      <h3 class="panel-title">Resumo por dia <span class="hint">últimos 30 dias, no fuso deste computador</span></h3>
      <div id="rl-table"></div>
    </section>`);
  $('#rl-print', ctx.el).addEventListener('click', () => window.print());
  update(ctx);
  // Resumo vem de baldes de 1 h dos últimos 30 dias (720 baldes), independente do período.
  ctx.api.buckets({ from: new Date(Date.now() - 30 * 86400e3).toISOString(), to: new Date().toISOString(), limit: 720 })
    .then((r) => { ctx.local.daily = dailySummary(r.buckets || [], KEYS); update(ctx); })
    .catch(() => { ctx.local.daily = []; update(ctx); });
}

export function update(ctx) {
  mount($('#rl-table', ctx.el), table(ctx.local.daily));
}
