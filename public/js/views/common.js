// Peças comuns das telas (design system V2): ícones, selos de status (sempre cor + ícone +
// texto), números grandes, medidores, gráficos a partir dos baldes de
// /api/history?formato=baldes e faixas empilhadas com cursor e zoom sincronizados.
import { html, raw } from '../core/html.js';
import { series, xs } from '../core/analysis.js';
import { timeChart, evenTicks, renderTip } from '../charts/timeseries.js';
import * as f from '../core/format.js';

export const $ = (sel, root = document) => root.querySelector(sel);

// ---------------- Ícones (traço, herdam a cor do texto) ----------------
const PATHS = {
  check: '<polyline points="5 12 10 17 19 7"/>',
  warn: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/>',
  serious: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  crit: '<path d="M12 3 3 8v8l9 5 9-5V8z"/><path d="M9 9l6 6M15 9l-6 6"/>',
  outage: '<path d="M2 12h4M18 12h4M8 8l8 8M16 8l-8 8"/>',
  note: '<path d="M5 3h14v18l-7-4-7 4z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  pulse: '<polyline points="3 12 7 12 10 5 14 19 17 12 21 12"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  sheet: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h8M12 11v8"/>',
  braces: '<path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  // Navegação (prancheta "Componente · Navegação")
  'visao-geral': '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  recursos: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  armazenamento: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  rede: '<path d="M7 17V7M4 10l3-3 3 3"/><path d="M17 7v10M14 14l3 3 3-3"/>',
  processos: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  eventos: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  relatorios: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 17v-3M12 17v-6M16 17v-4"/>',
  ajuda: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17h.01"/>',
};

/** Ícone SVG por nome (os nomes são fixos no código: seguro para raw()). */
export function icon(name, size = 16, stroke = 2) {
  return raw(`<svg width="${Number(size)}" height="${Number(size)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${Number(stroke)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`);
}

// ---------------- Status ----------------
const LEVEL_ICON = { ok: 'check', warn: 'warn', serious: 'serious', crit: 'crit', neutral: null, accent: null };
const LEVEL_WORD = { ok: 'Saudável', warn: 'Atenção', serious: 'Grave', crit: 'Crítico' };
export const levelWord = (level) => LEVEL_WORD[level] || '';

/** Selo de estado: sempre cor + ícone + texto (nunca só cor). */
export function pill(level, text, { lg = false, iconOnly } = {}) {
  const ic = iconOnly ?? LEVEL_ICON[level];
  return html`<span class="pill${lg ? ' pill-lg' : ''} is-${level}">${ic ? icon(ic, lg ? 14 : 10, lg ? 3 : 4) : ''}${text}</span>`;
}

/** Etiqueta (chip) com ícone opcional. */
export function chip(level, text, { ic, mono = false } = {}) {
  const name = ic === undefined ? LEVEL_ICON[level] : ic;
  return html`<span class="chip${mono ? ' mono' : ''}${level ? ` is-${level}` : ''}">${name ? icon(name, 12, 3) : ''}${text}</span>`;
}

/** Caixa de ícone colorida pelo nível (eventos, ajuda, serviços). */
export function iconBox(level, name, size = '') {
  return html`<span class="icon-box${size ? ` ${size}` : ''}${level ? ` is-${level}` : ''}">${icon(name, size === 'sm' ? 14 : size === 'lg' ? 20 : 16, 2.5)}</span>`;
}

export const SMART = {
  PASSED: { level: 'ok', text: 'PASSED' },
  FAILED: { level: 'crit', text: 'FAILED' },
  SEM_PERMISSAO: { level: 'neutral', text: 'sem permissão' },
  SEM_SMARTCTL: { level: 'neutral', text: 'smartctl ausente' },
  DESCONHECIDO: { level: 'neutral', text: 'desconhecido' },
};
export const smartOf = (status) => SMART[status] || { level: 'neutral', text: status || 'sem dado' };

// ---------------- Números e medidores ----------------
/** Número grande em Geist Mono com a unidade menor e apagada ("71%", "48 °C"). */
export function big(value, unit = '', cls = '') {
  return html`<span class="big${cls ? ` ${cls}` : ''}">${value}${unit ? html`<span class="unit">${unit}</span>` : ''}</span>`;
}

/** Número sem unidade para o `big()`: "—" quando falta dado (I5). */
export const n0 = (v, d = 0) => f.num(v, d);

/** Medidor horizontal. `parts` = [{ pct, color, soft?, glow?, op? }] (empilha se houver mais de um). */
export function meter(parts, { size = '', mark = null } = {}) {
  const list = Array.isArray(parts) ? parts : [parts];
  const stack = list.length > 1;
  return html`<div class="meter${size ? ` ${size}` : ''}${stack ? ' stack' : ''}${mark !== null ? ' has-mark' : ''}" role="presentation">${list.map((p) => html`<div class="meter-fill${p.soft ? ' soft' : ''}${p.glow ? ' glow' : ''}" data-w="${p.pct ?? 0}" data-bg="${p.color || 's1'}"${p.op !== undefined ? html` data-op="${p.op}"` : ''}></div>`)}${mark !== null ? html`<span class="mark" data-l="${mark}"></span>` : ''}</div>`;
}

// ---------------- Gráficos ----------------
/** Contêiner de gráfico (o uPlot é criado depois por `drawCharts`). */
export const chartBox = (id, cls = '') => html`<div class="chart${cls ? ` ${cls}` : ''}" data-chart="${id}"></div>`;

/** Legenda de linhas (as cores seguem a métrica). */
export const legend = (items) => html`<div class="legend">${items.map(([label, color, shape = 'line']) => html`<span><span class="swatch ${shape === 'line' ? 'line ' : ''}c-${color}"></span>${label}</span>`)}</div>`;

/**
 * Cria (ou atualiza) os gráficos declarados em `specs` dentro de `root`.
 * spec: { id, series: [{ label, key, stat?, color?, dash?, fill? }], format, range?, height?,
 *   axes?, interactive?, thresholds?, stack?, transform? }
 */
export function drawCharts(ctx, root, specs, buckets = ctx.state.buckets || [], xRange = ctx.state.bucketsRange) {
  const x = xs(buckets);
  for (const spec of specs) {
    let ys = spec.series.map((s) => series(buckets, s.key, s.stat || 'avg'));
    let tipValues;
    if (spec.stack) {
      // Empilhado: cada série soma as anteriores; a dica mostra a parcela de cada uma.
      const rawYs = ys;
      ys = rawYs.map((_, i) => x.map((__, j) => {
        let acc = 0;
        for (let k = 0; k <= i; k += 1) { if (rawYs[k][j] === null) return null; acc += rawYs[k][j]; }
        return acc;
      }));
      tipValues = (idx) => rawYs.map((y) => y[idx]);
    }
    if (spec.transform) ({ x: spec._x, ys } = spec.transform(x, ys));
    let entry = ctx.charts.get(spec.id);
    if (!entry) {
      const el = root.querySelector(`[data-chart="${spec.id}"]`);
      if (!el) continue;
      const specSeries = spec.stack ? spec.series.map((s, i) => (i === 0 && s.fill === undefined ? { ...s, fill: 0.55 } : s)) : spec.series;
      entry = timeChart(el, {
        series: specSeries, format: spec.format, axisFormat: spec.axisFormat, range: spec.range, height: spec.height,
        axes: spec.axes !== false, interactive: spec.interactive !== false, thresholds: spec.thresholds,
        bands: spec.stack ? spec.series.slice(1).map((_, i) => [i + 2, i + 1]) : undefined,
        tipValues, annotations: spec.annotations === false ? undefined : () => ctx.state.annotations || [],
      });
      if (!entry) continue;
      ctx.charts.set(spec.id, entry);
    }
    entry.setData(spec._x || x, ys, spec.xRange || xRange);
  }
}

/**
 * Faixas empilhadas (telemetria, PSI, atividade dos discos): um gráfico por linha, sem
 * eixos, com cursor, dica e zoom compartilhados, e a régua de tempo embaixo.
 * rows: [{ id, label, key, color, format, stat?, range?, thresholds?, fill? }]
 */
export function drawStrips(ctx, root, groupId, rows, buckets = ctx.state.buckets || [], xRange = ctx.state.bucketsRange) {
  const box = root.querySelector(`[data-strips="${groupId}"]`);
  if (!box) return;
  const x = xs(buckets);
  const data = rows.map((r) => series(buckets, r.key, r.stat || 'avg'));
  let group = ctx.charts.get(groupId);
  if (!group) {
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    box.appendChild(tip);
    const entries = [];
    let syncing = false;
    group = {
      entries, tip, rows, data, xRange,
      destroy() { entries.forEach((e) => e.destroy()); },
    };
    const ticks = () => {
      const el = box.querySelector('.strip-ticks');
      const u = entries[0]?.chart;
      if (!el || !u) return;
      el.replaceChildren(...evenTicks(u.scales.x.min, u.scales.x.max).map((t) => {
        const s = document.createElement('span');
        s.textContent = t;
        return s;
      }));
    };
    group.ticks = ticks;
    rows.forEach((r, i) => {
      const el = box.querySelector(`[data-chart="${r.id}"]`);
      if (!el) return;
      const entry = timeChart(el, {
        series: [{ label: r.label, color: r.color, fill: r.fill ?? 0.12 }], format: r.format,
        height: r.height || 60, axes: false, tooltip: false, range: r.range, thresholds: r.thresholds,
        syncKey: groupId, annotations: () => ctx.state.annotations || [],
        onCursor: (idx, u) => {
          if (idx === null || idx === undefined) { tip.hidden = true; return; }
          renderTip(tip, u.data[0][idx], group.rows.map((row, k) => ({
            label: row.label, color: getComputedStyle(document.documentElement).getPropertyValue(`--${row.color}`).trim(),
            value: group.data[k][idx], format: row.format,
          })));
          tip.hidden = false;
          const left = el.offsetLeft + u.cursor.left + 12;
          tip.style.left = `${left + tip.offsetWidth > box.clientWidth ? Math.max(0, left - tip.offsetWidth - 24) : left}px`;
        },
        onZoom: () => queueMicrotask(() => {
          if (syncing) return;
          syncing = true;
          const u = entry.chart;
          if (entry.zoomed) entries.forEach((e) => { if (e !== entry) e.setWindow(u.scales.x.min, u.scales.x.max); });
          else entries.forEach((e) => { e.resetZoom(); if (group.xRange) e.chart.setScale('x', { min: group.xRange[0], max: group.xRange[1] }); });
          syncing = false;
          ticks();
        }),
      });
      if (entry) entries[i] = entry;
    });
    ctx.charts.set(groupId, group);
  }
  group.rows = rows;
  group.data = data;
  group.xRange = xRange;
  group.entries.forEach((e, i) => e && e.setData(x, [data[i]], xRange));
  group.ticks();
  for (const r of rows) {
    const v = box.querySelector(`[data-strip-value="${r.id}"]`);
    if (!v) continue;
    const last = [...data[rows.indexOf(r)]].reverse().find((y) => y !== null && y !== undefined);
    v.textContent = r.current !== undefined ? r.current : (last === undefined ? '—' : (r.valueFormat || r.format)(last));
    v.className = `strip-value${r.ink ? ` ${r.ink}` : ''}`;
  }
}

/** Linha de uma faixa: rótulo | gráfico | valor atual. */
export const stripRow = (r) => html`
  <div class="strip-row">
    <span class="strip-label"><span class="name">${r.color ? html`<span class="swatch line c-${r.color}"></span>` : ''}${r.label}</span>${r.sub ? html`<span class="sub">${r.sub}</span>` : ''}</span>
    ${chartBox(r.id)}
    <span class="strip-value" data-strip-value="${r.id}">—</span>
  </div>`;

/** Bloco de faixas com a régua de tempo. */
export const strips = (groupId, rows, cls = '') => html`
  <div class="strips${cls ? ` ${cls}` : ''}" data-strips="${groupId}">
    ${rows.map(stripRow)}
    <div class="ticks strip-ticks"></div>
  </div>`;

export const emptyState = (text) => html`<p class="empty">${text}</p>`;

/** Cabeçalho de painel: título, nota e um lado direito opcional. */
export const panelHead = (title, note = '', right = '') => html`
  <div class="panel-head"><div><h2>${title}</h2>${note ? html`<span class="hint">${note}</span>` : ''}</div>${right}</div>`;

/** Um único ouvinte de clique por tela (o render pode rodar de novo no mesmo elemento). */
export function onClick(ctx, handler) {
  if (ctx.local.clickBound) return;
  ctx.local.clickBound = true;
  ctx.el.addEventListener('click', handler);
}
