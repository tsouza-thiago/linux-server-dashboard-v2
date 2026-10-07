// 2. Recursos (prancheta "V2 · Recursos"): processador por tipo (empilhado), carga, memória,
// temperatura com o limite e pressão do sistema (PSI) em faixas sincronizadas.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { keysWith, meanOf, peakOf, trendOf } from '../core/analysis.js';
import { $, pill, chip, big, n0, meter, chartBox, legend, drawCharts, drawStrips, strips, panelHead } from './common.js';

export const sub = () => 'Processador, memória, pressão do sistema e temperatura';

const thr = (state) => state.meta?.thresholds || state.config?.thresholds || {};

function nowCards(state) {
  const s = state.sample;
  const t = thr(state);
  const cpu = s?.cpu;
  const cores = s?.cores || 1;
  const load = s?.load || [];
  const r = s?.ram;
  const ramPct = r?.total ? (r.used / r.total) * 100 : null;
  const tempMax = (t.tempC || 60) * 1.15;
  return html`
    <article class="card stale">
      <span class="card-label">Processador agora</span>
      ${big(n0(cpu?.pct), '%')}
      ${meter(cpu ? [{ pct: cpu.user, color: 's1' }, { pct: cpu.system, color: 's4' }, { pct: cpu.iowait, color: 's3' }] : [{ pct: 0 }])}
      <span class="note mono">${cpu ? `usuário ${f.num(cpu.user)} · sistema ${f.num(cpu.system)} · espera de disco ${f.num(cpu.iowait)}` : 'CPU % a partir da 2ª coleta'}</span>
    </article>
    <article class="card stale">
      <span class="card-label">Carga (1 / 5 / 15 min)</span>
      ${big(f.num(load[0], 2), load.length ? ` ${f.num(load[1], 2)} · ${f.num(load[2], 2)}` : '')}
      ${meter({ pct: Number.isFinite(load[0]) ? (load[0] / cores) * 100 : 0, color: 's1' })}
      <span class="note mono">${cores} núcleo${cores > 1 ? 's' : ''}${Number.isFinite(load[0]) ? ` · ${f.pct((load[0] / cores) * 100)} da capacidade` : ''}</span>
    </article>
    <article class="card stale">
      <span class="card-label">Memória em uso</span>
      ${big(n0(ramPct), '%')}
      ${meter(r ? [{ pct: ramPct, color: 's2' }, { pct: (r.cache / r.total) * 100, color: 's2', soft: true }] : [{ pct: 0 }])}
      <span class="note mono">${r ? `em uso ${f.mb(r.used)} · cache ${f.mb(r.cache)} · disponível ${f.mb(r.avail)}` : 'sem dados de memória'}</span>
    </article>
    <article class="card stale">
      <span class="card-label">Temperatura</span>
      ${big(n0(s?.tempC), '°C')}
      ${meter({ pct: Number.isFinite(s?.tempC) ? (s.tempC / tempMax) * 100 : 0, color: 's4' }, { mark: (t.tempC / tempMax) * 100 })}
      <span class="note mono">${s?.tempSensor ? `sensor ${s.tempSensor} · ` : ''}limite ${f.celsius(t.tempC)}</span>
    </article>`;
}

function cpuSpec(state) {
  const b = state.buckets || [];
  const split = keysWith(b, 'cpuUser').length > 0;
  return split
    ? { id: 'rc-cpu', height: 240, stack: true, format: (v) => f.pct(v, v < 10 ? 1 : 0), axisFormat: (v) => f.pct(v), series: [
      { label: 'usuário', key: 'cpuUser', color: 's1', glow: false }, { label: 'sistema', key: 'cpuSystem', color: 's4', glow: false },
      { label: 'espera de disco', key: 'cpuIowait', color: 's3' }] }
    // Histórico de antes da F6 não separa usuário/sistema: total e espera de disco.
    : { id: 'rc-cpu', height: 240, format: (v) => f.pct(v), series: [
      { label: 'total', key: 'cpu', color: 's1', fill: 0.15 }, { label: 'espera de disco', key: 'cpuIowait', color: 's3' }] };
}

function ramStats(state) {
  const b = state.buckets || [];
  const peak = peakOf(b, 'ramPct');
  const tr = trendOf(b, 'ramPct');
  const mini = (k, v, extra = '') => html`<div class="mini"><span class="k">${k}</span><span class="v">${v}${extra ? html` <span class="note">${extra}</span>` : ''}</span></div>`;
  return html`
    ${mini('média', f.pct(meanOf(b, 'ramPct')))}
    ${mini('pico', f.pct(peak?.value), peak ? f.time(peak.t) : '')}
    ${mini('tendência', tr === null ? '—' : `${tr >= 0.5 ? '↗' : tr <= -0.5 ? '↘' : '→'} ${tr >= 0 ? '+' : ''}${f.num(tr, Math.abs(tr) < 10 ? 1 : 0)}%`)}
    ${mini('swap', f.mb(state.sample?.ram?.swapUsed))}`;
}

function sensors(s) {
  const list = s?.temps || [];
  if (!list.length) return '';
  return html`${list.map((x) => html`<span class="chip mono${x.type === s.tempSensor ? ' is-current' : ''}">${x.type} ${f.celsius(x.c)}${x.type === s.tempSensor ? html` <span class="ink-accent">· usado</span>` : ''}</span>`)}`;
}

const PSI_ROWS = [
  { id: 'rc-psi-cpu', label: 'CPU', key: 'psi:cpu', color: 's1' },
  { id: 'rc-psi-mem', label: 'Memória', key: 'psi:memory', color: 's2' },
  { id: 'rc-psi-io', label: 'Disco', key: 'psi:io', color: 's3' },
].map((r) => ({ ...r, format: (v) => f.pct(v, v < 1 ? 2 : 1), range: (u, min, max) => [0, Math.max(5, (max ?? 0) * 1.2)], fill: 0.12 }));

function psiPill(s) {
  const p = s?.psi;
  if (!p) return pill('neutral', 'sem PSI neste kernel', { iconOnly: null });
  const worst = Math.max(...['cpu', 'memory', 'io'].map((k) => p[k]?.some10 ?? 0));
  return worst >= 10 ? pill('warn', 'engasgando', { lg: true }) : pill('ok', 'sem engasgos', { lg: true });
}

export function render(ctx) {
  const t = thr(ctx.state);
  mount(ctx.el, html`
    <section class="grid-cards" aria-label="Agora" id="rc-now"></section>
    <section class="panel stale" aria-label="Processador por tipo">
      ${panelHead(`Processador por tipo · ${ctx.state.period}`, 'empilhado · espera de disco alta = disco lento (comum em SMR)',
    legend([['usuário', 's1', 'box'], ['sistema', 's4', 'box'], ['espera de disco', 's3', 'box']]))}
      ${chartBox('rc-cpu')}
    </section>
    <div class="grid-2">
      <section class="panel stale" aria-label="Memória">
        ${panelHead(`Memória em uso · ${ctx.state.period}`, '', html`<span class="page-note">alerta em ${f.pct(t.ramPct)}</span>`)}
        ${chartBox('rc-ram')}
        <div class="minis-4" id="rc-ram-stats"></div>
      </section>
      <section class="panel stale" aria-label="Temperatura">
        ${panelHead(`Temperatura · ${ctx.state.period}`, '', html`<span class="page-note">limite ${f.celsius(t.tempC)}</span>`)}
        ${chartBox('rc-temp')}
        <div class="chips" id="rc-sensors"></div>
      </section>
    </div>
    <section class="panel flush stale" aria-label="Pressão do sistema">
      <div class="panel-head"><div><h2>Pressão do sistema (PSI) · ${ctx.state.period}</h2><span class="hint">% do tempo em que algo ficou esperando por CPU, memória ou disco · acima de 10% o servidor "engasga"</span></div><span id="rc-psi-pill"></span></div>
      <div class="panel-body">${strips('rc-psi', PSI_ROWS.map((r) => ({ ...r, color: null })), 'psi')}</div>
    </section>`);
  update(ctx);
}

export function update(ctx) {
  const { state } = ctx;
  const t = thr(state);
  mount($('#rc-now', ctx.el), nowCards(state));
  mount($('#rc-ram-stats', ctx.el), ramStats(state));
  mount($('#rc-sensors', ctx.el), sensors(state.sample));
  mount($('#rc-psi-pill', ctx.el), psiPill(state.sample));
  drawCharts(ctx, ctx.el, [
    cpuSpec(state),
    { id: 'rc-ram', height: 170, range: [0, 100], format: (v) => f.pct(v), thresholds: [{ value: t.ramPct, level: 'warn' }],
      series: [{ label: 'RAM média', key: 'ramPct', color: 's2', fill: 0.16 }, { label: 'RAM pico', key: 'ramPct', stat: 'max', color: 's2', dash: true }] },
    { id: 'rc-temp', height: 170, format: f.celsius, axisFormat: (v) => `${f.num(v)}°`, thresholds: [{ value: t.tempC, level: 'warn' }],
      series: [{ label: 'média', key: 'tempC', color: 's4' }, { label: 'pico', key: 'tempC', stat: 'max', color: 's4', dash: true }] },
  ]);
  drawStrips(ctx, ctx.el, 'rc-psi', PSI_ROWS);
}
