// 7. Relatórios (prancheta "V2 · Relatórios"): resumo do período (7, 30, 90 dias ou datas
// escolhidas), tabela por dia no fuso local (B5) e exportação em CSV, JSON ou PDF.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import {
  dailySummary, dailyTraffic, uptimeIn, meanOf, peakOf, timeline, levelOf, fullestDisk,
} from '../core/analysis.js';
import { $, icon, panelHead, onClick } from './common.js';

const DAY = 86400e3;
const KEYS = ['cpu', 'ramPct', 'tempC', 'rxMbps', 'txMbps'];
const RANGES = { 7: '7 dias', 30: '30 dias', 90: '90 dias' };
const view = { days: 7, from: null, to: null };
const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch { return 'local'; } };
export const sub = () => `Resumo por dia no seu fuso horário (${tz()}) e exportação dos dados`;

export const actions = () => html`<div class="segmented is-text" role="group" aria-label="Período do relatório">
  ${Object.entries(RANGES).map(([d, t]) => html`<button type="button" data-days="${d}" aria-pressed="${!view.from && view.days === Number(d)}">${t}</button>`)}
  <button type="button" data-days="custom" aria-pressed="${Boolean(view.from)}">Personalizado</button></div>`;

export function onAction(ctx, e) {
  const b = e.target.closest('[data-days]');
  if (!b) return;
  if (b.dataset.days === 'custom') {
    ctx.local.custom = true;
    if (!view.from) { view.from = f.localDay(Date.now() - 6 * DAY); view.to = f.localDay(Date.now()); }
  } else {
    ctx.local.custom = false;
    view.days = Number(b.dataset.days);
    view.from = null;
    view.to = null;
  }
  load(ctx);
}

function range() {
  if (view.from && view.to) {
    const from = new Date(`${view.from}T00:00:00`).getTime();
    const to = Math.min(Date.now(), new Date(`${view.to}T23:59:59`).getTime());
    return { from: Math.max(from, Date.now() - 90 * DAY), to: Math.max(to, from + 3600e3) };
  }
  const to = Date.now();
  return { from: to - view.days * DAY, to };
}

const gb = (b) => `${f.num(b / 1024 ** 3, b < 10 * 1024 ** 3 ? 1 : 0)}`;

function cards(ctx) {
  const b = ctx.local.buckets;
  if (!b) return html`${[1, 2, 3, 4, 5].map(() => html`<div class="skel soft card-skel"></div>`)}`;
  const { from, to } = range();
  const outs = (ctx.state.outages?.outages || []).filter((o) => Date.parse(o.from) <= to && (!o.to || Date.parse(o.to) >= from));
  const since = ctx.state.outages?.uptime?.from ? Date.parse(ctx.state.outages.uptime.from) : -Infinity;
  const up = uptimeIn(outs, from, to, { sinceMs: since });
  const cpuPeak = peakOf(b, 'cpu');
  const ramPeak = peakOf(b, 'ramPct');
  const disk = fullestDisk(ctx.state.sample);
  const dk = disk ? b.map((x) => x.m?.[`disk:${disk.mount}:avail`]?.[2]).filter(Number.isFinite) : [];
  const pk = disk ? b.map((x) => x.m?.[`disk:${disk.mount}:pct`]?.[2]).filter(Number.isFinite) : [];
  const grew = dk.length > 1 ? dk[0] - dk[dk.length - 1] : null;
  const traffic = dailyTraffic(b, ctx.state.meta?.pollIntervalMs).reduce((a, d) => ({ rx: a.rx + d.rx, tx: a.tx + d.tx }), { rx: 0, tx: 0 });
  const when = (p) => (p ? `${WEEKDAY[new Date(p.t).getDay()]} ${f.time(p.t)}` : '');
  const card = (label, value, note) => html`<article class="card"><span class="card-label">${label}</span><span class="big md">${value}</span><span class="note">${note}</span></article>`;
  return html`
    ${card('Disponibilidade', up === null ? '—' : `${f.num(up, 2)}%`, outs.length ? `${outs.length} queda${outs.length > 1 ? 's' : ''} · ${f.duration(outs.reduce((s, o) => s + o.durationSec, 0))} fora` : 'nenhuma queda')}
    ${card('CPU média', f.pct(meanOf(b, 'cpu')), cpuPeak ? `pico ${f.pct(cpuPeak.value)} · ${when(cpuPeak)}` : 'sem dados')}
    ${card('Memória média', f.pct(meanOf(b, 'ramPct')), ramPeak ? `pico ${f.pct(ramPeak.value)}` : 'sem dados')}
    ${card(disk ? disk.mount : 'Disco', grew === null ? '—' : `${grew >= 0 ? '+' : '−'}${f.bytes(Math.abs(grew))}`, pk.length > 1 ? `${f.pct(pk[0])} → ${f.pct(pk[pk.length - 1])} no período` : 'sem dados no período')}
    ${card('Rede', `${gb(traffic.rx + traffic.tx)} GB`, `↓ ${gb(traffic.rx)} · ↑ ${gb(traffic.tx)}`)}`;
}

function table(ctx) {
  const b = ctx.local.buckets;
  if (!b) return html`<p class="empty">Carregando resumo…</p>`;
  const daily = dailySummary(b, KEYS);
  if (!daily.length) return html`<p class="empty">Sem dados neste período.</p>`;
  const traffic = new Map(dailyTraffic(b, ctx.state.meta?.pollIntervalMs).map((d) => [d.day, d]));
  const events = timeline({ alerts: ctx.state.alerts?.all, outages: ctx.state.outages?.outages });
  const since = ctx.state.outages?.uptime?.from ? Date.parse(ctx.state.outages.uptime.from) : -Infinity;
  const t = ctx.state.meta?.thresholds || ctx.state.config?.thresholds || {};
  const today = f.localDay(Date.now());
  const mm = (m, k, d = 0) => (m[k] ? `${f.num(m[k].avg, d)} / ${f.num(m[k].max, d)}%` : '—');
  return html`<div class="table-wrap"><table class="table daily">
    <thead><tr><th scope="col">Dia</th><th scope="col" class="num">Disponível</th><th scope="col" class="num">CPU méd / máx</th>
      <th scope="col" class="num">RAM méd / máx</th><th scope="col" class="num">Temp máx</th><th scope="col" class="num">Rede ↓ / ↑</th><th scope="col" class="num">Eventos</th></tr></thead>
    <tbody>${daily.map((d) => {
    const start = new Date(`${d.day}T00:00:00`).getTime();
    const up = uptimeIn(ctx.state.outages?.outages, start, start + DAY, { sinceMs: since });
    const ev = events.filter((e) => f.localDay(e.ts) === d.day);
    const crit = ev.filter((e) => e.kind === 'queda' || levelOf(e) === 'crit').length;
    const warn = ev.filter((e) => e.kind === 'alerta' && levelOf(e) === 'warn').length;
    const hot = d.m.tempC && t.tempC && d.m.tempC.max >= t.tempC;
    const tr = traffic.get(d.day);
    const label = `${d.day === today ? 'hoje' : WEEKDAY[new Date(start).getDay()]} · ${d.day.slice(8)}/${d.day.slice(5, 7)}`;
    return html`<tr class="${crit ? 'row-crit' : warn ? 'row-warn' : ''}">
        <td>${label}</td>
        <td class="num mono${up !== null && up < 100 ? ' ink-crit' : ''}">${up === null ? '—' : `${f.num(up, up < 100 ? 2 : 0)}%${up < 100 ? ' ▼' : ''}`}</td>
        <td class="num mono">${mm(d.m, 'cpu')}</td>
        <td class="num mono">${mm(d.m, 'ramPct')}</td>
        <td class="num mono${hot ? ' ink-warn' : ''}">${d.m.tempC ? `${f.num(d.m.tempC.max)} °C${hot ? ' ▲' : ''}` : '—'}</td>
        <td class="num mono">${tr ? `${gb(tr.rx)} / ${gb(tr.tx)} GB` : '—'}</td>
        <td class="num">${crit ? html`<span class="pill is-crit">${crit} ${crit > 1 ? 'críticos' : 'crítico'}</span>` : ''}${warn ? html` <span class="pill is-warn">${warn} atenção</span>` : ''}${crit || warn ? '' : html`<span class="ink-3">—</span>`}</td>
      </tr>`;
  })}</tbody></table></div>`;
}

function exportPanel(ctx) {
  const { from, to } = range();
  const link = (format) => ctx.api.exportUrl({ format, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  const opt = (ic, title, text) => html`<span class="export-icon">${icon(ic, 18)}</span><span class="export-text"><span class="export-title">${title}</span><span class="note">${text}</span></span>`;
  return html`<div class="export-grid">
    <a class="export-btn" href="${link('csv')}" download>${opt('sheet', 'Planilha (CSV)', 'abre no Excel e no LibreOffice · protegido contra fórmulas')}</a>
    <a class="export-btn" href="${link('json')}" download>${opt('braces', 'Dados brutos (JSON)', 'todas as amostras do período, com versão do formato')}</a>
    <button class="export-btn" type="button" data-print>${opt('printer', 'Imprimir / PDF', 'versão clara e limpa deste resumo, pronta para salvar em PDF')}</button>
  </div>`;
}

function customForm() {
  return html`<form class="custom-range" id="rl-custom">
    <div class="field"><label for="rl-from">De</label><input class="input" type="date" id="rl-from" value="${view.from}" min="${f.localDay(Date.now() - 89 * DAY)}" max="${f.localDay(Date.now())}" required></div>
    <div class="field"><label for="rl-to">Até</label><input class="input" type="date" id="rl-to" value="${view.to}" min="${f.localDay(Date.now() - 89 * DAY)}" max="${f.localDay(Date.now())}" required></div>
    <button class="btn btn-soft" type="submit">Aplicar</button>
    <span class="note">até 90 dias para trás</span>
  </form>`;
}

function load(ctx) {
  const { from, to } = range();
  ctx.local.buckets = null;
  update(ctx);
  // Baldes de ~1 h (no máximo 2000 por pedido): suficientes para o resumo diário e os totais.
  const limit = Math.min(2000, Math.max(24, Math.ceil((to - from) / 3600e3)));
  ctx.api.buckets({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit })
    .then((r) => { ctx.local.buckets = r.buckets || []; update(ctx); })
    .catch(() => { ctx.local.buckets = []; update(ctx); });
  mount(document.getElementById('viewActions'), actions()); // botão do período marcado
}

export function render(ctx) {
  ctx.local.custom = Boolean(view.from);
  mount(ctx.el, html`
    <div id="rl-custom-box"></div>
    <section class="grid-cards narrow" aria-label="Resumo do período" id="rl-cards"></section>
    <section class="panel flush" aria-label="Resumo diário">
      ${panelHead('Resumo diário', 'valores calculados de todas as amostras do dia · picos preservados')}
      <div id="rl-table"></div>
    </section>
    <section class="panel no-print" aria-label="Exportar">
      ${panelHead('Exportar', 'usa o período escolhido acima · gerado na sua máquina, sem tocar no servidor')}
      <div id="rl-export"></div>
    </section>`);
  onClick(ctx, (e) => { if (e.target.closest('[data-print]')) window.print(); });
  ctx.el.addEventListener('submit', (e) => {
    if (e.target.id !== 'rl-custom') return;
    e.preventDefault();
    const a = $('#rl-from', ctx.el).value;
    const b = $('#rl-to', ctx.el).value;
    if (!a || !b) return;
    [view.from, view.to] = a <= b ? [a, b] : [b, a];
    load(ctx);
  });
  load(ctx);
}

export function update(ctx) {
  // O formulário de datas só é refeito ao abrir/fechar (as coletas ao vivo não apagam o que se digita).
  if (Boolean($('#rl-custom', ctx.el)) !== ctx.local.custom) mount($('#rl-custom-box', ctx.el), ctx.local.custom ? customForm() : '');
  mount($('#rl-cards', ctx.el), cards(ctx));
  mount($('#rl-table', ctx.el), table(ctx));
  mount($('#rl-export', ctx.el), exportPanel(ctx));
}
