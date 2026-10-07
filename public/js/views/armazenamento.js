// 3. Armazenamento: espaço, inodes, previsão de disco cheio e SMART por mount; I/O,
// utilização e latência por disco.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { diskEta, keysWith } from '../core/analysis.js';
import { chartPanel, drawCharts, badge, SMART_LEVEL, SMART_TEXT, $ } from './common.js';

const MAX_SERIES = 4; // paleta categórica validada tem 4 cores; acima disso, os 4 primeiros

function etaBadge(state, mount_) {
  const eta = diskEta(state.buckets || [], mount_);
  if (eta.status === 'enchendo') return badge(eta.days < 90 ? 'warn' : 'neutral', `enche em ${f.days(eta.days)}`);
  if (eta.status === 'estavel') return badge('ok', 'estável');
  return badge('neutral', 'aguardando ~1 dia');
}

function table(state) {
  const s = state.sample;
  const disks = s?.disks || [];
  if (!disks.length) return html`<p class="empty">Nenhum ponto de montagem coletado ainda.</p>`;
  const smartOf = (dev) => (s.smart || []).find((x) => x.dev === dev);
  return html`
    <div class="table-wrap"><table>
      <thead><tr><th>Ponto de montagem</th><th>Disco</th><th>Uso</th><th>Livre</th><th>Inodes</th><th>SMART</th><th>Previsão</th></tr></thead>
      <tbody>${disks.map((d) => {
    const sm = smartOf(d.dev);
    return html`<tr>
          <td><b>${d.mount}</b></td>
          <td>${d.dev || d.source || '—'}</td>
          <td><div class="bar" title="${f.pct(d.pct)}"><div class="bar-fill" data-pct="${d.pct ?? 0}"></div></div> ${f.pct(d.pct)} · ${f.bytes(d.usedBytes)} de ${f.bytes(d.sizeBytes)}</td>
          <td>${f.bytes(d.availBytes)}</td>
          <td>${f.pct(d.inodesPct)}</td>
          <td>${sm ? badge(SMART_LEVEL[sm.status] || 'neutral', SMART_TEXT[sm.status] || sm.status) : badge('neutral', 'não monitorado')}</td>
          <td>${etaBadge(state, d.mount)}</td>
        </tr>`;
  })}</tbody>
    </table></div>
    ${s.smartAt ? html`<p class="hint">SMART verificado ${f.ago(s.smartAt)} (1 vez por hora).</p>` : ''}`;
}

function specs(state) {
  const b = state.buckets || [];
  const mounts = keysWith(b, 'disk:', ':pct').slice(0, MAX_SERIES);
  const devs = [...new Set(keysWith(b, 'io:').map((k) => k.split(':')[1]))].slice(0, MAX_SERIES);
  return [
    { id: 'ar-uso', format: (v) => f.pct(v), range: [0, 100], series: mounts.map((k, i) => ({ label: k.slice(5, -4), key: k, color: i })) },
    { id: 'ar-io', format: f.mbs, series: devs.flatMap((d, i) => [
      { label: `${d} leitura`, key: `io:${d}:read`, color: i }, { label: `${d} escrita`, key: `io:${d}:write`, color: i, dash: true }]) },
    { id: 'ar-util', format: (v) => f.pct(v), range: [0, 100], series: devs.map((d, i) => ({ label: d, key: `io:${d}:util`, color: i })) },
    { id: 'ar-lat', format: f.ms, series: devs.map((d, i) => ({ label: d, key: `io:${d}:lat`, color: i })) },
  ];
}

export function render(ctx) {
  mount(ctx.el, html`
    <section class="panel"><h3 class="panel-title">Espaço por ponto de montagem</h3><div id="ar-table"></div></section>
    <div class="grid-2">
      ${chartPanel('ar-uso', 'Uso de espaço')}
      ${chartPanel('ar-io', 'Leitura e gravação', 'tracejado = gravação')}
      ${chartPanel('ar-util', 'Ocupação do disco (% do tempo)', 'perto de 100% = disco saturado')}
      ${chartPanel('ar-lat', 'Latência média por operação')}
    </div>`);
  ctx.chartSpecs = specs(ctx.state);
  update(ctx);
}

export function update(ctx) {
  mount($('#ar-table', ctx.el), table(ctx.state));
  for (const el of ctx.el.querySelectorAll('.bar-fill[data-pct]')) el.style.width = `${Math.min(100, Number(el.dataset.pct) || 0)}%`;
  drawCharts(ctx, ctx.el, ctx.chartSpecs || specs(ctx.state));
}
