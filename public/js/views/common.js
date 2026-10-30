// Peças comuns das telas (design system V2): ícones, selos de status (sempre cor + ícone +
// texto), números grandes, medidores, gráficos a partir dos baldes de
// /api/history?formato=baldes e faixas empilhadas com cursor e zoom sincronizados.
import { html, raw } from '../core/html.js';
import { series, xs } from '../core/analysis.js';
import { timeChart, evenTicks, renderTip } from '../charts/timeseries.js';
import { ATRASO_MS, esperaVisivel, pausa } from '../core/espera.js';
import * as f from '../core/format.js';

/** Primeiro elemento que casa com o seletor (na tela inteira ou dentro de `root`). */
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
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sheet: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h8M12 11v8"/>',
  braces: '<path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  // Navegação: um ícone por tela (o nome é o id da tela; main.js usa icon(v.id))
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
// Ícone de cada nível (neutro e destaque não têm ícone).
const LEVEL_ICON = { ok: 'check', warn: 'warn', serious: 'serious', crit: 'crit', neutral: null, accent: null };

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

// Como cada estado do SMART aparece: nível (cor) e texto. Sem permissão/sem smartctl é neutro.
const SMART = {
  PASSED: { level: 'ok', text: 'PASSED' },
  FAILED: { level: 'crit', text: 'FAILED' },
  SEM_PERMISSAO: { level: 'neutral', text: 'sem permissão' },
  SEM_SMARTCTL: { level: 'neutral', text: 'smartctl ausente' },
  DESCONHECIDO: { level: 'neutral', text: 'desconhecido' },
};
/** Nível e texto de um estado SMART (desconhecido = neutro). */
export const smartOf = (status) => SMART[status] || { level: 'neutral', text: status || 'sem dado' };

// ---------------- Números e medidores ----------------
/** Número grande em Geist Mono com a unidade menor e apagada ("71%", "48 °C"). */
export function big(value, unit = '', cls = '') {
  // Sem dado, o valor é só o traço (I5): "—%" ou "— Mbps" parecem um número quebrado (#48).
  const showUnit = unit && value !== '—';
  return html`<span class="big${cls ? ` ${cls}` : ''}">${value}${showUnit ? html`<span class="unit">${unit}</span>` : ''}</span>`;
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
    // Uma dica só para o grupo inteiro: mostra o valor de todas as faixas no instante.
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    box.appendChild(tip);
    const entries = [];
    let syncing = false;
    group = {
      entries, rows, data, xRange,
      destroy() { entries.forEach((e) => e.destroy()); },
    };
    // Régua de tempo embaixo das faixas, refeita a cada zoom.
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
        // Zoom numa faixa aplica a mesma janela nas outras (sem entrar em laço: `syncing`).
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
  // Valor mais recente de cada faixa, à direita dela.
  for (const r of rows) {
    const v = box.querySelector(`[data-strip-value="${r.id}"]`);
    if (!v) continue;
    const last = [...data[rows.indexOf(r)]].reverse().find((y) => y !== null && y !== undefined);
    v.textContent = last === undefined ? '—' : (r.valueFormat || r.format)(last);
  }
}

/** Linha de uma faixa: rótulo | gráfico | valor atual. */
const stripRow = (r) => html`
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

/** Cabeçalho de painel: título, nota e um lado direito opcional. */
export const panelHead = (title, note = '', right = '') => html`
  <div class="panel-head"><div><h2>${title}</h2>${note ? html`<span class="hint">${note}</span>` : ''}</div>${right}</div>`;

// ---------------- Esqueletos (F6, ADR 0027) ----------------
// As peças usam as mesmas classes do conteúdo e têm um texto invisível: o bloco ocupa o mesmo
// espaço, com a fonte do lugar onde ele está, e a tela não pula.

/**
 * Bloco no lugar de um texto, com `w`% da largura. Com um `exemplo` do tamanho do texto final, a
 * largura vem dele (use `w` nulo) e ele quebra de linha onde o texto final quebraria.
 */
export const skelLinha = (w = 100, exemplo = '\u00a0') => html`<span class="skel skel-txt" aria-hidden="true"${w === null ? '' : html` data-w="${w}"`}>${exemplo}</span>`;

/** Cabeçalho de painel, com a nota opcional. A coluna encolhe no texto: a largura vem do exemplo. */
export const skelCabeca = (nota = false) => html`
  <div class="panel-head"><div><h2>${skelLinha(null, 'Título do painel · 24h')}</h2>${nota ? html`<span class="hint">${skelLinha(null, 'nota de exemplo deste painel, com um tamanho médio de texto')}</span>` : ''}</div></div>`;

/** Cartão de número: rótulo, número e nota. `numero` é o tamanho do `big()` ("md", "sm"…). */
export const skelCartao = ({ medidor = false, numero = '', nota = '' } = {}) => html`<article class="card">
  <span class="card-label">${skelLinha(45)}</span>
  <span class="big${numero ? ` ${numero}` : ''}">${skelLinha(60)}</span>
  ${medidor ? html`<div class="meter"></div>` : ''}
  <span class="note mono">${nota ? skelLinha(null, nota) : skelLinha(85)}</span>
</article>`;

/** Área de um gráfico, com a altura dele em pixels. */
export const skelGrafico = (altura = 220) => html`<div class="skel soft skel-grafico" data-px="${altura}"></div>`;

/** Faixas empilhadas: `linhas` com rótulo e gráfico, mais a régua de tempo. */
export const skelFaixas = (linhas, cls = '', altura = 60) => html`<div class="strips${cls ? ` ${cls}` : ''}">
  ${Array.from({ length: linhas }, () => html`<div class="strip-row"><span class="strip-label"><span class="name">${skelLinha(70)}</span></span>${skelGrafico(altura)}<span class="strip-value">${skelLinha(100)}</span></div>`)}
  <div class="ticks strip-ticks"><span>&nbsp;</span></div>
</div>`;

/** Tabela com `linhas` linhas e `colunas` colunas; `cabeca` é o `<tr>` do cabeçalho real. */
export const skelTabela = (linhas, colunas = 4, { cabeca = '', cls = '' } = {}) => html`<div class="table-wrap"><table class="table${cls ? ` ${cls}` : ''}">
  ${cabeca ? html`<thead>${cabeca}</thead>` : ''}
  <tbody>${Array.from({ length: linhas }, () => html`<tr>${Array.from({ length: colunas }, () => html`<td>${skelLinha(70)}</td>`)}</tr>`)}</tbody>
</table></div>`;

/** Parágrafo de `linhas` linhas, com larguras variadas como num texto. */
export const skelTexto = (linhas = 3) => html`<div class="skel-texto">${Array.from({ length: linhas }, (_, i) => skelLinha([96, 82, 90, 70][i % 4]))}</div>`;

/** Peças de uma região que carrega depois da tela aberta: guardam o espaço desde o início. */
export const skelRegiao = (ctx, pecas) => html`<div class="esqueleto${ctx.local.regiaoVisivel ? '' : ' oculto'}" aria-busy="true"><span class="visually-hidden">carregando</span>${pecas}</div>`;

/**
 * Busca uma parte da tela depois de aberta. Só o último pedido vale, e a resposta espera o tempo
 * mínimo se as peças já apareceram. Vindo de um esqueleto visível, as peças aparecem na hora: um
 * vão entre o esqueleto da tela e o da região piscaria. Falha entrega `null`.
 */
export function carregarRegiao(ctx, atualizar, buscar, pronto) {
  ctx.local.fimRegiao?.();
  const vez = (ctx.local.regiaoVez || 0) + 1;
  ctx.local.regiaoVez = vez;
  const vale = () => ctx.local.regiaoVez === vez && ctx.el.isConnected !== false;
  ctx.local.regiaoVisivel = Boolean(ctx.semAtraso);
  const fim = esperaVisivel(() => {
    if (!vale()) return;
    ctx.local.regiaoVisivel = true;
    atualizar(ctx);
  }, { atraso: ctx.semAtraso ? 0 : ATRASO_MS });
  ctx.semAtraso = false;
  ctx.local.fimRegiao = fim;
  const entrega = async (valor) => {
    if (!vale()) return;
    const falta = fim();
    if (falta > 0) await pausa(falta);
    if (!vale()) return;
    ctx.local.regiaoVisivel = false;
    pronto(valor);
    atualizar(ctx);
  };
  return buscar().then(entrega, () => entrega(null));
}

/** Um único ouvinte de clique por tela (o render pode rodar de novo no mesmo elemento). */
export function onClick(ctx, handler) {
  if (ctx.local.clickBound) return;
  ctx.local.clickBound = true;
  ctx.el.addEventListener('click', handler);
}

/** Deixa o botão "aguardando" até a ação terminar (F2): o `disabled` barra o duplo clique. */
export async function withBusy(btn, promessa) {
  // Desligar o botão tira o foco dele: quem usa o teclado não pode perder o lugar.
  const tinhaFoco = btn.ownerDocument?.activeElement === btn;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    return await promessa;
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (tinhaFoco) btn.focus({ preventScroll: true });
  }
}
