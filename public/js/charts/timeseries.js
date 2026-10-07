// Gráficos de série temporal com uPlot (ADR 0004). Eixo de tempo REAL (corrige B10: as
// anotações caem no instante certo), buracos visíveis onde não há dado, cursor sincronizado
// entre todos os gráficos da tela, arrastar = zoom no intervalo, roda = zoom, duplo clique =
// volta. Cores das séries vêm do tema (variáveis CSS --series-1..4).
const SYNC_KEY = 'painel';

const cssVar = (name, fallback) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
};

export function themeColors() {
  return {
    series: [1, 2, 3, 4].map((i) => cssVar(`--series-${i}`, ['#0E9CB0', '#8064F0', '#D84B8A', '#3F86E8'][i - 1])),
    text: cssVar('--text-secondary', '#A9B4C5'),
    grid: cssVar('--chart-grid', 'rgba(131,144,164,0.18)'),
    annotation: cssVar('--accent-primary', '#3EE0D0'),
  };
}

/** Rótulos do eixo de tempo em PT-BR, 24 h: HH:MM até 2 dias de janela, DD/MM acima. */
export function timeTicks(splits, spanSec) {
  const opts = spanSec <= 2 * 86400
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { day: '2-digit', month: '2-digit' };
  return splits.map((s) => (s === null || s === undefined ? '' : new Date(s * 1000).toLocaleString('pt-BR', opts)));
}

/** Anotações dentro da janela visível, em segundos (mesma escala do eixo x). */
export function markersInRange(annotations, minSec, maxSec) {
  return (annotations || [])
    .map((a) => ({ x: Date.parse(a.ts) / 1000, label: a.label || a.text || '' }))
    .filter((m) => Number.isFinite(m.x) && m.x >= minSec && m.x <= maxSec);
}

function annotationsPlugin(getAnnotations, color) {
  return {
    hooks: {
      draw: [(u) => {
        const [min, max] = [u.scales.x.min, u.scales.x.max];
        const { ctx, bbox } = u;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1 * devicePixelRatio;
        for (const m of markersInRange(getAnnotations(), min, max)) {
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

function wheelZoomPlugin(onZoom) {
  return {
    hooks: {
      ready: [(u) => {
        u.over.addEventListener('wheel', (e) => {
          onZoom(true);
          e.preventDefault();
          const { left } = u.cursor;
          const xVal = u.posToVal(left, 'x');
          const { min, max } = u.scales.x;
          const factor = e.deltaY < 0 ? 0.75 : 1 / 0.75;
          const nMin = xVal - (xVal - min) * factor;
          const nMax = xVal + (max - xVal) * factor;
          u.setScale('x', { min: nMin, max: nMax });
        }, { passive: false });
      }],
    },
  };
}

/**
 * Cria um gráfico.
 * @param {HTMLElement} el contêiner
 * @param {object} opts
 * @param {{label: string, color?: number, dash?: boolean, width?: number}[]} opts.series
 * @param {(v: number) => string} opts.format formato dos valores (eixo, legenda)
 * @param {number} [opts.height]
 * @param {[number, number]} [opts.range] faixa fixa do eixo y (ex.: 0–100 para %)
 * @param {() => object[]} [opts.annotations] anotações a desenhar
 */
export function timeChart(el, { series, format = String, height = 180, range, annotations, sparkline = false }) {
  const UPlot = globalThis.uPlot;
  if (!UPlot || !el) return null;
  const c = themeColors();
  const fmt = (v) => (v === null || v === undefined ? '—' : format(v));
  const opts = {
    width: Math.max(el.clientWidth, 120),
    height,
    pxAlign: false,
    cursor: sparkline ? { show: false } : { sync: { key: SYNC_KEY }, drag: { x: true, y: false } },
    legend: { show: !sparkline },
    select: { show: !sparkline },
    scales: {
      x: { time: true },
      y: range ? { range: () => range } : { range: (u, min, max) => [Math.min(0, min ?? 0), (max ?? 1) * 1.1 || 1] },
    },
    axes: sparkline ? [{ show: false }, { show: false }] : [
      { stroke: c.text, grid: { stroke: c.grid, width: 1 }, ticks: { stroke: c.grid, width: 1 },
        values: (u, splits) => timeTicks(splits, u.scales.x.max - u.scales.x.min) },
      { stroke: c.text, grid: { stroke: c.grid, width: 1 }, ticks: { show: false }, size: 64, values: (u, vals) => vals.map(fmt) },
    ],
    series: [
      { label: 'Horário', value: (u, v) => (v === null || v === undefined ? '—' : new Date(v * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })) },
      ...series.map((s, i) => ({
        label: s.label,
        stroke: c.series[(s.color ?? i) % c.series.length],
        width: s.width ?? (s.dash ? 1 : 2),
        dash: s.dash ? [4, 4] : undefined,
        // Com poucos pontos à vista (1ª coleta, zoom forte) a linha some: mostra os pontos.
        points: { show: (u, si, i0, i1) => i1 - i0 < 3, size: 6 },
        spanGaps: false,
        value: (u, v) => fmt(v),
      })),
    ],
    plugins: sparkline ? [] : [null, annotationsPlugin(annotations || (() => []), c.annotation)],
  };
  // Zoom do usuário (arrastar ou roda) sobrevive às atualizações ao vivo; duplo clique volta.
  let zoomed = false;
  if (!sparkline) {
    opts.plugins[0] = wheelZoomPlugin((z) => { zoomed = z; });
    opts.hooks = { setSelect: [(u) => { if (u.select.width > 0) zoomed = true; }] };
  }
  const chart = new UPlot(opts, [[], ...series.map(() => [])], el);
  chart.over?.addEventListener('dblclick', () => { zoomed = false; });
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
    get zoomed() { return zoomed; },
    destroy() { ro?.disconnect(); chart.destroy(); },
  };
}
