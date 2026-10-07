// 4. Rede (prancheta "V2 · Rede"): vazão agora com o pico do período, volume do dia, erros
// e descartes, tráfego no período, volume por dia (7 dias) e os maiores picos.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { peakOf, dailyTraffic, topPeaks } from '../core/analysis.js';

const dayOf = f.localDay;
import { $, pill, big, chartBox, legend, drawCharts, panelHead } from './common.js';

export const sub = (state) => (state.sample?.net ? `Interface ${state.sample.net.iface} · tráfego, totais e erros` : 'Tráfego, totais e erros da interface de rede');

const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const WEEKDAY_LONG = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const gb = (bytes) => f.num(bytes / 1024 ** 3, bytes < 10 * 1024 ** 3 ? 1 : 0);

function cards(ctx) {
  const { state } = ctx;
  const n = state.sample?.net;
  const b = state.buckets || [];
  const rxPeak = peakOf(b, 'rxMbps');
  const txPeak = peakOf(b, 'txMbps');
  const today = (ctx.local.week ? dailyTraffic(ctx.local.week, state.meta?.pollIntervalMs) : []).find((d) => d.day === dayOf(Date.now()));
  const errs = n ? (n.rxErrors ?? 0) + (n.txErrors ?? 0) : null;
  const drops = n ? (n.rxDrops ?? 0) + (n.txDrops ?? 0) : null;
  const peakNote = (p) => (p ? `pico ${state.period} ${f.mbps(p.value)} às ${f.time(p.t)}` : 'sem pico no período');
  const rate = (v) => f.num(v, Number.isFinite(v) && v < 10 ? 1 : 0);
  return html`
    <article class="card stale">
      <span class="card-label"><span class="swatch c-s1"></span>Download agora</span>
      ${big(n ? rate(n.rxMbps) : '—', ' Mbps')}
      <span class="note mono">${peakNote(rxPeak)}</span>
    </article>
    <article class="card stale">
      <span class="card-label"><span class="swatch c-s4"></span>Upload agora</span>
      ${big(n ? rate(n.txMbps) : '—', ' Mbps')}
      <span class="note mono">${peakNote(txPeak)}</span>
    </article>
    <article class="card stale">
      <span class="card-label">Trafegado hoje</span>
      ${big(today ? gb(today.rx + today.tx) : '—', ' GB')}
      <span class="note mono">${today ? `↓ ${gb(today.rx)} GB · ↑ ${gb(today.tx)} GB` : 'calculado do histórico do dia'}</span>
    </article>
    <article class="card stale">
      <div class="card-top"><span class="card-label">Erros e descartes</span>${n ? (errs || drops ? pill('warn', 'com perdas') : pill('ok', 'limpo')) : ''}</div>
      ${big(n ? f.num(errs) : '—', n ? ` / ${f.num(drops)}` : '')}
      <span class="note mono">${n ? `desde o boot · ${f.duration(state.sample.uptimeSec)}` : 'interface não configurada (NET_IF)'}</span>
    </article>`;
}

function weekBars(ctx) {
  if (!ctx.local.week) return html`<p class="empty">Carregando os últimos 7 dias…</p>`;
  const days = dailyTraffic(ctx.local.week, ctx.state.meta?.pollIntervalMs);
  const todayKey = dayOf(Date.now());
  const list = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - (6 - i));
    const key = dayOf(d.getTime());
    const v = days.find((x) => x.day === key) || { rx: 0, tx: 0 };
    return { key, label: key === todayKey ? 'hoje' : WEEKDAY[d.getDay()], long: WEEKDAY_LONG[d.getDay()], ...v };
  });
  const max = Math.max(...list.map((d) => Math.max(d.rx, d.tx)), 1);
  const top = list.reduce((a, b) => (b.rx + b.tx > a.rx + a.tx ? b : a));
  return html`
    <div class="week-bars" role="img" aria-label="Volume trafegado por dia nos últimos 7 dias">
      ${list.map((d) => html`<div class="week-col" title="${d.label}: ↓ ${gb(d.rx)} GB · ↑ ${gb(d.tx)} GB">
        <span class="bar c-s1${d === top && d.rx > 0 ? ' hot' : ''}" data-h="${(d.rx / max) * 100}"></span><span class="bar c-s4" data-h="${(d.tx / max) * 100}"></span>
      </div>`)}
    </div>
    <div class="week-labels">${list.map((d) => html`<span>${d.label}</span>`)}</div>
    <span class="note">${top.rx + top.tx > 0 ? `maior dia: ${top.label === 'hoje' ? 'hoje' : top.long} · ${gb(top.rx + top.tx)} GB (↓ ${gb(top.rx)} · ↑ ${gb(top.tx)})` : 'sem tráfego registrado nos últimos 7 dias'}</span>`;
}

function peaksTable(state) {
  const peaks = topPeaks(state.buckets || [], ['rxMbps', 'txMbps'], { n: 3, stepMs: state.bucketsStep || 60e3 });
  if (!peaks.length) return html`<p class="empty">Sem tráfego no período.</p>`;
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">Quando</th><th scope="col">Sentido</th><th scope="col" class="num">Taxa</th><th scope="col" class="num">Duração</th></tr></thead>
    <tbody class="mono">${peaks.map((p) => html`<tr><td>${f.dateTime(p.t)}</td><td class="ink-2">${p.key === 'rxMbps' ? '↓ download' : '↑ upload'}</td>
      <td class="num">${f.mbps(p.value)}</td><td class="num ink-2">${f.duration(p.durationMs / 1000)}</td></tr>`)}</tbody>
  </table></div>`;
}

export function render(ctx) {
  mount(ctx.el, html`
    <section class="grid-cards" aria-label="Agora" id="rd-cards"></section>
    <section class="panel stale" aria-label="Tráfego">
      ${panelHead(`Tráfego · ${ctx.state.period}`, '', legend([['download', 's1'], ['upload', 's4']]))}
      ${chartBox('rd-traffic')}
    </section>
    <div class="grid-2">
      <section class="panel stale" aria-label="Volume por dia">
        ${panelHead('Volume por dia · 7 dias', '', html`<span class="page-note">GB</span>`)}
        <div id="rd-week"></div>
      </section>
      <section class="panel stale" aria-label="Maiores picos">
        ${panelHead(`Maiores picos · ${ctx.state.period}`)}
        <div id="rd-peaks"></div>
        <span class="note">média por minuto · rajadas menores que 1 min não aparecem (a coleta é 1x/min)</span>
      </section>
    </div>`);
  // Volume por dia vem de baldes de 1 h dos últimos 7 dias (independe do período escolhido).
  ctx.api.buckets({ from: new Date(Date.now() - 7 * 86400e3).toISOString(), to: new Date().toISOString(), limit: 168 })
    .then((r) => { ctx.local.week = r.buckets || []; update(ctx); })
    .catch(() => { ctx.local.week = []; update(ctx); });
  update(ctx);
}

export function update(ctx) {
  mount($('#rd-cards', ctx.el), cards(ctx));
  mount($('#rd-week', ctx.el), weekBars(ctx));
  mount($('#rd-peaks', ctx.el), peaksTable(ctx.state));
  drawCharts(ctx, ctx.el, [{
    id: 'rd-traffic', height: 260, format: f.mbps, axisFormat: (v) => f.num(v, v > 0 && v < 10 ? 1 : 0), series: [
      { label: 'download', key: 'rxMbps', color: 's1', fill: 0.18 },
      { label: 'upload', key: 'txMbps', color: 's4' }],
  }]);
}
