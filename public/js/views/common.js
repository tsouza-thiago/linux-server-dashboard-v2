// Peças comuns das telas: cartões de gráfico, selos de status e o desenho das séries a
// partir dos baldes de /api/history?formato=baldes.
import { html } from '../core/html.js';
import { series, xs } from '../core/analysis.js';
import { timeChart } from '../charts/timeseries.js';

export const $ = (sel, root = document) => root.querySelector(sel);

/** Painel com título, nota e área do gráfico (`data-chart` = id do gráfico). */
export const chartPanel = (id, title, note = '') => html`
  <section class="panel chart-panel">
    <h3 class="panel-title">${title}${note ? html` <span class="hint">${note}</span>` : ''}</h3>
    <div class="chart-box" data-chart="${id}"></div>
  </section>`;

/** Selo de estado: sempre cor + ícone + texto (nunca só cor). */
export function badge(level, text) {
  const icon = { ok: '✓', warn: '▲', bad: '●', neutral: '–', info: 'i' }[level] || '–';
  return html`<span class="badge badge-${level}"><span aria-hidden="true">${icon}</span> ${text}</span>`;
}

export const SMART_LEVEL = { PASSED: 'ok', FAILED: 'bad' };
export const SMART_TEXT = {
  PASSED: 'SMART ok', FAILED: 'SMART falhou', SEM_PERMISSAO: 'SMART sem permissão',
  SEM_SMARTCTL: 'smartctl ausente', DESCONHECIDO: 'SMART desconhecido',
};

/**
 * Cria (ou atualiza) os gráficos declarados em `specs` dentro de `root`.
 * spec: { id, series: [{ label, key, stat?, color?, dash? }], format, range?, height? }
 */
export function drawCharts(ctx, root, specs) {
  const buckets = ctx.state.buckets || [];
  const x = xs(buckets);
  for (const spec of specs) {
    const ys = spec.series.map((s) => series(buckets, s.key, s.stat || 'avg'));
    let entry = ctx.charts.get(spec.id);
    if (!entry) {
      const el = root.querySelector(`[data-chart="${spec.id}"]`);
      if (!el) continue;
      entry = timeChart(el, {
        series: spec.series, format: spec.format, range: spec.range, height: spec.height,
        sparkline: spec.sparkline, annotations: () => ctx.state.annotations || [],
      });
      if (!entry) continue;
      ctx.charts.set(spec.id, entry);
    }
    entry.setData(x, ys, ctx.state.bucketsRange);
  }
}

export const emptyState = (text) => html`<div class="empty">${text}</div>`;
