// Gráficos de série temporal com uPlot (ADR 0004) no visual da V2 (D1): linhas de 2 px com
// halo no escuro, preenchimento em degradê, limites tracejados, marcas de anotação e dica
// flutuante com todos os valores do instante. Eixo de tempo REAL (B10), buracos visíveis,
// cursor sincronizado entre os gráficos da tela, arrastar/roda = zoom, duplo clique = volta.
// Cores vêm dos tokens CSS (--s1..--s4), lidas na criação: trocar o tema recria os gráficos.
const SYNC_KEY = 'painel';
const DEFAULT_COLORS = { s1: '#0E9CB0', s2: '#8064F0', s3: '#D84B8A', s4: '#3F86E8' };

const cssVar = (name, fallback) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
};

export function themeColors() {
  return {
    s1: cssVar('--s1', DEFAULT_COLORS.s1),
    s2: cssVar('--s2', DEFAULT_COLORS.s2),
    s3: cssVar('--s3', DEFAULT_COLORS.s3),
    s4: cssVar('--s4', DEFAULT_COLORS.s4),
    text: cssVar('--text-3', '#8390A4'),
    grid: cssVar('--grid', 'rgba(148,163,184,0.08)'),
    border: cssVar('--border', 'rgba(148,163,184,0.12)'),
    surface: cssVar('--surface', '#0F141D'),
    accent: cssVar('--accent', '#3EE0D0'),
    warn: cssVar('--warn', '#F5B83D'),
    crit: cssVar('--crit', '#F0525C'),
    glow: cssVar('--glow', '1') !== '0',
  };
}

/** "#0E9CB0" + alfa → "rgba(14,156,176,0.35)" (cores que não são hex passam direto). */
export function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Rótulos do eixo de tempo em PT-BR, 24 h: HH:MM até 2 dias de janela, DD/MM acima. */
export function timeTicks(splits, spanSec) {
  const opts = spanSec <= 2 * 86400
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { day: '2-digit', month: '2-digit' };
  return splits.map((s) => (s === null || s === undefined ? '' : new Date(s * 1000).toLocaleString('pt-BR', opts)));
}

/** Horário completo da dica: "07/10 15:02". */
export const tipTime = (sec) => new Date(sec * 1000).toLocaleString('pt-BR', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** `n` rótulos igualmente espaçados para a régua de tempo das faixas (último = "agora"). */
export function evenTicks(minSec, maxSec, n = 7, nowSec = Date.now() / 1000) {
  if (!Number.isFinite(minSec) || !Number.isFinite(maxSec) || maxSec <= minSec) return [];
  const span = maxSec - minSec;
  const splits = Array.from({ length: n }, (_, i) => minSec + (span * i) / (n - 1));
  const labels = timeTicks(splits, span);
  if (Math.abs(maxSec - nowSec) < span / (n * 2)) labels[n - 1] = 'agora';
  return labels;
}

/** Anotações dentro da janela visível, em segundos (mesma escala do eixo x). */
export function markersInRange(annotations, minSec, maxSec) {
  return (annotations || [])
    .map((a) => ({ x: Date.parse(a.ts) / 1000, label: a.label || a.text || '' }))
    .filter((m) => Number.isFinite(m.x) && m.x >= minSec && m.x <= maxSec);
}

/**
 * Faixa automática do eixo y: valores longe do zero (temperatura, por ex.) ganham uma faixa
 * justa em vez de achatados no topo; limites próximos (alerta de 60 °C) entram na faixa.
 */
export function autoRange(min, max, thresholds = []) {
  if (min === null || min === undefined || max === null || max === undefined) return [0, 1];
  let lo = min;
  let hi = max;
  for (const t of thresholds) if (Number.isFinite(t) && t <= max * 1.6 + 1) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
  if (lo >= 0 && lo > hi * 0.25) {
    const pad = Math.max((hi - lo) * 0.4, hi * 0.03, 0.5);
    return [Math.max(0, lo - pad), hi + pad];
  }
  return [Math.min(0, lo), Math.max(hi * 1.15, 1e-6)];
}

// ---------------- Plugins ----------------

/** Limites tracejados (atenção/crítico) e anotações como linhas verticais tracejadas. */
function overlayPlugin({ thresholds, annotations, colors }) {
  return {
    hooks: {
      draw: [(u) => {
        const { ctx, bbox } = u;
        const dpr = devicePixelRatio || 1;
        ctx.save();
        ctx.lineWidth = dpr;
        ctx.setLineDash([5 * dpr, 5 * dpr]);
        for (const t of (typeof thresholds === 'function' ? thresholds() : thresholds) || []) {
          if (!Number.isFinite(t.value)) continue;
          const y = Math.round(u.valToPos(t.value, 'y', true));
          if (y < bbox.top || y > bbox.top + bbox.height) continue;
          ctx.strokeStyle = alpha(t.level === 'crit' ? colors.crit : colors.warn, 0.6);
          ctx.beginPath();
          ctx.moveTo(bbox.left, y);
          ctx.lineTo(bbox.left + bbox.width, y);
          ctx.stroke();
        }
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.strokeStyle = alpha(colors.text, 0.7);
        for (const m of markersInRange(annotations?.() || [], u.scales.x.min, u.scales.x.max)) {
          const x = Math.round(u.valToPos(m.x, 'x', true));
          ctx.beginPath();
          ctx.moveTo(x, bbox.top);
          ctx.lineTo(x, bbox.top + bbox.height);
          ctx.stroke();
        }
        ctx.restore();
      }],
    },
  };
}

/** Halo luminoso nas linhas (só no tema escuro): redesenha o traço com sombra. */
function glowPlugin(specs, colors, seriesColors) {
  return {
    hooks: {
      draw: [(u) => {
        if (!colors.glow) return;
        const { ctx, bbox } = u;
        const dpr = devicePixelRatio || 1;
        ctx.save();
        ctx.beginPath();
        ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
        ctx.clip();
        u.series.forEach((s, i) => {
          const spec = specs[i - 1];
          const path = s._paths && s._paths.stroke;
          if (!i || !s.show || !spec || spec.dash || spec.glow === false || !path) return;
          ctx.shadowColor = alpha(seriesColors[i - 1], 0.85);
          ctx.shadowBlur = 8 * dpr;
          ctx.strokeStyle = seriesColors[i - 1];
          ctx.lineWidth = (s.width || 2) * dpr;
          ctx.lineJoin = 'round';
          ctx.stroke(path);
        });
        ctx.restore();
      }],
    },
  };
}

/** Roda do mouse = zoom no eixo do tempo, centrado no cursor. */
function wheelZoomPlugin(onZoom) {
  return {
    hooks: {
      ready: [(u) => {
        u.over.addEventListener('wheel', (e) => {
          e.preventDefault();
          const xVal = u.posToVal(u.cursor.left ?? u.over.clientWidth / 2, 'x');
          const { min, max } = u.scales.x;
          const factor = e.deltaY < 0 ? 0.75 : 1 / 0.75;
          onZoom(true);
          u.setScale('x', { min: xVal - (xVal - min) * factor, max: xVal + (max - xVal) * factor });
        }, { passive: false });
      }],
    },
  };
}

/** Dica flutuante: horário e o valor de cada série no instante do cursor. */
function tooltipPlugin(specs, format, seriesColors, tipValues) {
  let tip;
  return {
    hooks: {
      init: [(u) => {
        tip = document.createElement('div');
        tip.className = 'tip';
        tip.hidden = true;
        u.over.appendChild(tip);
        u.over.addEventListener('mouseleave', () => { tip.hidden = true; });
      }],
      setCursor: [(u) => {
        const idx = u.cursor.idx;
        if (idx === null || idx === undefined || u.cursor.left < 0) { tip.hidden = true; return; }
        const vals = tipValues ? tipValues(idx) : null;
        renderTip(tip, u.data[0][idx], specs.map((s, i) => ({
          label: s.label, color: seriesColors[i], value: vals ? vals[i] : u.data[i + 1][idx], format: s.format || format,
        })));
        tip.hidden = false;
        const left = u.cursor.left + 14;
        tip.style.left = `${left + tip.offsetWidth > u.over.clientWidth ? Math.max(0, u.cursor.left - tip.offsetWidth - 14) : left}px`;
        tip.style.top = '8px';
      }],
    },
  };
}

/** Preenche a dica com DOM (sem innerHTML: rótulos e valores entram como texto). */
export function renderTip(tip, xSec, rows) {
  tip.replaceChildren();
  const time = document.createElement('span');
  time.className = 'tip-time';
  time.textContent = tipTime(xSec);
  tip.appendChild(time);
  for (const r of rows) {
    const row = document.createElement('span');
    row.className = 'tip-row';
    const name = document.createElement('span');
    const sw = document.createElement('span');
    sw.className = 'swatch line';
    sw.style.background = r.color;
    name.append(sw, r.label);
    const val = document.createElement('span');
    val.textContent = r.value === null || r.value === undefined ? '—' : r.format(r.value);
    if (r.ink) val.className = r.ink;
    row.append(name, val);
    tip.appendChild(row);
  }
}

// ---------------- Gráfico ----------------

/**
 * Cria um gráfico.
 * @param {HTMLElement} el contêiner
 * @param {object} o
 * @param {{label: string, color?: 's1'|'s2'|'s3'|'s4', dash?: boolean, fill?: 'gradient'|number,
 *   width?: number, glow?: boolean, format?: Function}[]} o.series
 * @param {(v: number) => string} o.format formato dos valores (eixo y e dica)
 * @param {number} [o.height]
 * @param {[number, number]} [o.range] faixa fixa do eixo y (ex.: 0–100 para %)
 * @param {boolean} [o.axes] eixos visíveis (falso nas faixas e mini-gráficos)
 * @param {boolean} [o.interactive] cursor, zoom e dica (falso nos mini-gráficos)
 * @param {boolean} [o.tooltip] dica própria do gráfico (as faixas usam a dica do grupo)
 * @param {object[]|Function} [o.thresholds] [{ value, level: 'warn'|'crit' }]
 * @param {() => object[]} [o.annotations] anotações a marcar
 * @param {[number, number][]} [o.bands] pares de séries (1-based) para empilhar: [[topo, base]]
 * @param {(idx: number) => (number|null)[]} [o.tipValues] valores da dica (ex.: parcelas do empilhado)
 * @param {(idx: number|null, u: object) => void} [o.onCursor]
 * @param {(min: number, max: number) => void} [o.onZoom]
 */
export function timeChart(el, o) {
  const UPlot = globalThis.uPlot;
  if (!UPlot || !el) return null;
  const {
    series, format = String, height = 220, range, axes = true, interactive = true, tooltip = true,
    thresholds, annotations, bands, onCursor, onZoom, padRight = 0,
  } = o;
  const c = themeColors();
  const fmt = (v) => (v === null || v === undefined ? '—' : format(v));
  const axisFmt = (v) => (v === null || v === undefined ? '' : (o.axisFormat || format)(v));
  const thresholdValues = () => ((typeof thresholds === 'function' ? thresholds() : thresholds) || []).map((t) => t.value);
  const colorOf = (s, i) => c[s.color] || c[`s${(i % 4) + 1}`];
  const seriesColors = series.map(colorOf);
  let zoomed = false;
  const plugins = [glowPlugin(series, c, seriesColors), overlayPlugin({ thresholds, annotations, colors: c })];
  if (interactive) plugins.push(wheelZoomPlugin((z) => { zoomed = z; }));
  if (interactive && tooltip) plugins.push(tooltipPlugin(series, format, seriesColors, o.tipValues));

  const opts = {
    width: Math.max(el.clientWidth, 120),
    height,
    pxAlign: false,
    padding: axes ? [8, 8 + padRight, 0, 0] : [4, 0, 4, 0],
    cursor: interactive
      ? { sync: { key: o.syncKey || SYNC_KEY }, drag: { x: true, y: false }, points: { size: 8, width: 2, fill: c.surface }, y: false }
      : { show: false },
    legend: { show: false },
    select: { show: interactive },
    scales: {
      x: { time: true },
      y: range ? { range: typeof range === 'function' ? range : () => range } : { range: (u, min, max) => autoRange(min, max, thresholdValues()) },
    },
    axes: axes ? [
      { stroke: c.text, font: '11px "Geist Mono", monospace', grid: { show: false }, ticks: { show: false }, size: 28,
        values: (u, splits) => timeTicks(splits, u.scales.x.max - u.scales.x.min) },
      { stroke: c.text, font: '11px "Geist Mono", monospace', grid: { stroke: c.grid, width: 1 }, ticks: { show: false },
        size: 56, gap: 8, values: (u, vals) => vals.map(axisFmt) },
    ] : [{ show: false }, { show: false }],
    series: [
      {},
      ...series.map((s, i) => {
        const color = seriesColors[i];
        const out = {
          label: s.label,
          stroke: color,
          width: s.width ?? (s.dash ? 1.5 : 2),
          dash: s.dash ? [6, 6] : undefined,
          spanGaps: Boolean(s.spanGaps),
          // Com poucos pontos à vista (1ª coleta, zoom forte) a linha some: mostra os pontos.
          points: { show: (u, si, i0, i1) => i1 - i0 < 3, size: 6, fill: color },
        };
        if (s.fill === 'gradient') {
          out.fill = (u) => {
            const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
            g.addColorStop(0, alpha(color, 0.35));
            g.addColorStop(1, alpha(color, 0));
            return g;
          };
        } else if (typeof s.fill === 'number') out.fill = alpha(color, s.fill);
        return out;
      }),
    ],
    bands: (bands || []).map(([top, base]) => ({ series: [top, base], fill: alpha(seriesColors[top - 1], 0.55) })),
    plugins,
    hooks: {
      setSelect: [(u) => { if (u.select.width > 0) zoomed = true; }],
      setCursor: onCursor ? [(u) => onCursor(u.cursor.left >= 0 ? u.cursor.idx : null, u)] : [],
      setScale: onZoom ? [(u, key) => { if (key === 'x') onZoom(u.scales.x.min, u.scales.x.max); }] : [],
    },
  };
  const chart = new UPlot(opts, [[], ...series.map(() => [])], el);
  chart.over?.addEventListener('dblclick', () => { zoomed = false; });
  if (onCursor) chart.over?.addEventListener('mouseleave', () => onCursor(null, chart));
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => chart.setSize({ width: Math.max(el.clientWidth, 120), height }));
    ro.observe(el);
  }
  return {
    chart,
    /**
     * Troca os dados. O eixo x mostra sempre o período pedido (`xRange`, em segundos), mesmo
     * com poucas coletas: o trecho sem dado aparece vazio em vez de o eixo "inventar" anos.
     * Com zoom do usuário, mantém a janela dele.
     */
    setData(x, ys, xRange) {
      chart.setData([x, ...ys], !zoomed && !xRange);
      if (!zoomed && xRange) chart.setScale('x', { min: xRange[0], max: xRange[1] });
    },
    /** Janela imposta por outro gráfico do grupo (zoom sincronizado). */
    setWindow(min, max) {
      zoomed = true;
      chart.setScale('x', { min, max });
    },
    resetZoom() { zoomed = false; },
    get zoomed() { return zoomed; },
    destroy() { ro?.disconnect(); chart.destroy(); },
  };
}
