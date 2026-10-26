// 7. Relatórios: resumo do período (7, 30, 90 dias ou datas
// escolhidas), tabela por dia no fuso local (B5) e exportação em CSV, JSON ou PDF.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import {
  reportDays, dailyTraffic, outagesIn, offlineMsIn, uptimeIn, meanOf, peakOf, timeline, levelOf, fullestDisk, reportRequests,
} from '../core/analysis.js';
import { $, icon, panelHead, onClick } from './common.js';

// Métricas resumidas por dia e os períodos oferecidos.
const DAY = 86400e3;
const KEYS = ['cpu', 'ramPct', 'tempC', 'rxMbps', 'txMbps'];
const RANGES = { 7: '7 dias', 30: '30 dias', 90: '90 dias' };
const view = { days: 7, from: null, to: null };
const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// Fuso horário do navegador (os dias do relatório seguem ele, B5).
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch { return 'local'; } };
/** Subtítulo da tela. */
export const sub = () => `Resumo por dia no seu fuso horário (${tz()}) e exportação dos dados`;

/** Escolha do período (7, 30, 90 dias ou datas). */
export const actions = () => html`<div class="segmented is-text" role="group" aria-label="Período do relatório">
  ${Object.entries(RANGES).map(([d, t]) => html`<button type="button" data-days="${d}" aria-pressed="${!view.from && view.days === Number(d)}">${t}</button>`)}
  <button type="button" data-days="custom" aria-pressed="${Boolean(view.from)}">Personalizado</button></div>`;

/** Clique na escolha do período. */
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

/** Intervalo escolhido em ms. */
function range() {
  if (view.from && view.to) {
    const from = new Date(`${view.from}T00:00:00`).getTime();
    const to = Math.min(Date.now(), new Date(`${view.to}T23:59:59`).getTime());
    return { from: Math.max(from, Date.now() - 90 * DAY), to: Math.max(to, from + 3600e3) };
  }
  const to = Date.now();
  return { from: to - view.days * DAY, to };
}

/** Cartões de resumo do período (disponibilidade, médias, picos). */
function cards(ctx) {
  const b = ctx.local.buckets;
  if (!b) return html`${[1, 2, 3, 4, 5].map(() => html`<div class="skel soft card-skel"></div>`)}`;
  const { from, to } = range();
  const outs = outagesIn(ctx.state.outages?.outages, from, to);
  const since = ctx.state.outages?.uptime?.from ? Date.parse(ctx.state.outages.uptime.from) : -Infinity;
  const monitored = ctx.state.outages?.monitored;
  const up = uptimeIn(ctx.state.outages?.outages, from, to, { sinceMs: since, monitored });
  const cpuPeak = peakOf(b, 'cpu');
  const ramPeak = peakOf(b, 'ramPct');
  const disk = fullestDisk(ctx.state.sample);
  const dk = disk ? b.map((x) => x.m?.[`disk:${disk.mount}:avail`]?.[2]).filter(Number.isFinite) : [];
  const pk = disk ? b.map((x) => x.m?.[`disk:${disk.mount}:pct`]?.[2]).filter(Number.isFinite) : [];
  const grew = dk.length > 1 ? dk[0] - dk[dk.length - 1] : null;
  const traffic = dailyTraffic(b, ctx.state.meta?.pollIntervalMs).reduce((a, d) => ({ rx: a.rx + d.rx, tx: a.tx + d.tx }), { rx: 0, tx: 0 });
  // Sem nenhuma métrica de rede no período (sem amostra ou sem NET_IF), a soma daria "0 B"
  // inventado (#54, I5): o cartão diz "sem dados", como os outros.
  const hasNet = ['rxDeltaBytes', 'txDeltaBytes', 'rxMbps', 'txMbps'].some((k) => meanOf(b, k) !== null);
  const when = (p) => (p ? `${WEEKDAY[new Date(p.t).getDay()]} ${f.time(p.t)}` : '');
  const card = (label, value, note) => html`<article class="card"><span class="card-label">${label}</span><span class="big md">${value}</span><span class="note">${note}</span></article>`;
  return html`
    ${card('Disponibilidade', up === null ? 'sem dados' : f.pct(up, 2), outs.count ? `${outs.count} queda${outs.count > 1 ? 's' : ''} · ${f.duration(outs.offlineSec)} fora` : 'nenhuma queda')}
    ${card('CPU média', f.pct(meanOf(b, 'cpu')), cpuPeak ? `pico ${f.pct(cpuPeak.value)} · ${when(cpuPeak)}` : 'sem dados')}
    ${card('Memória média', f.pct(meanOf(b, 'ramPct')), ramPeak ? `pico ${f.pct(ramPeak.value)}` : 'sem dados')}
    ${card(disk ? disk.mount : 'Disco', grew === null ? '—' : `${grew >= 0 ? '+' : '−'}${f.bytes(Math.abs(grew))}`, pk.length > 1 ? `${f.pct(pk[0])} → ${f.pct(pk[pk.length - 1])} no período` : 'sem dados no período')}
    ${card('Rede', hasNet ? f.bytes(traffic.rx + traffic.tx) : '—', hasNet ? `↓ ${f.bytes(traffic.rx)} · ↑ ${f.bytes(traffic.tx)}` : 'sem dados')}`;
}

/** Tabela por dia (fuso local) com médias, picos e eventos. */
function table(ctx) {
  const b = ctx.local.buckets;
  if (!b) return html`<p class="empty">Carregando resumo…</p>`;
  // Todos os dias do período, com ou sem amostra (#43): o dia só de queda mostra 0% e o dia
  // sem coleta, "sem dados", como na faixa de Eventos.
  const { from, to } = range();
  const daily = reportDays(b, KEYS, from, to);
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
    const up = uptimeIn(ctx.state.outages?.outages, start, start + DAY, { sinceMs: since, monitored: ctx.state.outages?.monitored });
    const ev = events.filter((e) => f.localDay(e.ts) === d.day);
    const crit = ev.filter((e) => e.kind === 'queda' || levelOf(e) === 'crit').length;
    const warn = ev.filter((e) => e.kind === 'alerta' && levelOf(e) === 'warn').length;
    // Dia com tempo fora do ar fica vermelho mesmo se a queda começou antes (como em Eventos).
    const down = offlineMsIn(ctx.state.outages?.outages, start, start + DAY) > 0;
    const hot = d.m.tempC && t.tempC && d.m.tempC.max >= t.tempC;
    const tr = traffic.get(d.day);
    const label = `${d.day === today ? 'hoje' : WEEKDAY[new Date(start).getDay()]} · ${d.day.slice(8)}/${d.day.slice(5, 7)}`;
    return html`<tr class="${crit || down ? 'row-crit' : warn ? 'row-warn' : ''}">
        <td>${label}</td>
        <td class="num mono${up !== null && up < 100 ? ' ink-crit' : ''}">${up === null ? 'sem dados' : `${f.num(up, up < 100 ? 2 : 0)}%${up < 100 ? ' ▼' : ''}`}</td>
        <td class="num mono">${mm(d.m, 'cpu')}</td>
        <td class="num mono">${mm(d.m, 'ramPct')}</td>
        <td class="num mono${hot ? ' ink-warn' : ''}">${d.m.tempC ? `${f.num(d.m.tempC.max)} °C${hot ? ' ▲' : ''}` : '—'}</td>
        <td class="num mono">${tr ? `${f.bytes(tr.rx)} / ${f.bytes(tr.tx)}` : '—'}</td>
        <td class="num">${crit ? html`<span class="pill is-crit">${crit} ${crit > 1 ? 'críticos' : 'crítico'}</span>` : ''}${warn ? html` <span class="pill is-warn">${warn} atenção</span>` : ''}${crit || warn ? '' : html`<span class="ink-3">—</span>`}</td>
      </tr>`;
  })}</tbody></table></div>`;
}

/** Exportar CSV/JSON e imprimir. */
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

/** Formulário de datas do período personalizado. */
function customForm() {
  return html`<form class="custom-range" id="rl-custom">
    <div class="field"><label for="rl-from">De</label><input class="input" type="date" id="rl-from" value="${view.from}" min="${f.localDay(Date.now() - 89 * DAY)}" max="${f.localDay(Date.now())}" required></div>
    <div class="field"><label for="rl-to">Até</label><input class="input" type="date" id="rl-to" value="${view.to}" min="${f.localDay(Date.now() - 89 * DAY)}" max="${f.localDay(Date.now())}" required></div>
    <button class="btn btn-soft" type="submit">Aplicar</button>
    <span class="note">até 90 dias para trás</span>
  </form>`;
}

/** Busca os baldes do período (uma vez por período escolhido). */
function load(ctx) {
  const { from, to } = range();
  ctx.local.buckets = null;
  update(ctx);
  // Baldes que não cruzam a meia-noite local (#68, #74): 1 h em fuso de hora inteira (até 2
  // pedidos), 30 ou 15 min nos outros (até 5). Os pedidos vão um depois do outro: o
  // servidor monta 1 resposta de cada vez, e o pico de memória dele não cresce.
  const seq = (ctx.local.loadSeq || 0) + 1;
  ctx.local.loadSeq = seq;
  const done = (buckets) => {
    if (ctx.local.loadSeq !== seq) return; // outro período foi escolhido no meio do caminho
    ctx.local.buckets = buckets;
    update(ctx);
  };
  reportRequests(from, to)
    .reduce((acc, p) => acc.then((all) => ctx.api.buckets(p).then((r) => all.concat(r.buckets || []))), Promise.resolve([]))
    .then(done, () => done([]));
  mount(document.getElementById('viewActions'), actions()); // botão do período marcado
}

/** Monta a tela inteira. */
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

/** Atualiza só o que muda com os dados novos. */
export function update(ctx) {
  // O formulário de datas só é refeito ao abrir/fechar (as coletas ao vivo não apagam o que se digita).
  if (Boolean($('#rl-custom', ctx.el)) !== ctx.local.custom) mount($('#rl-custom-box', ctx.el), ctx.local.custom ? customForm() : '');
  mount($('#rl-cards', ctx.el), cards(ctx));
  mount($('#rl-table', ctx.el), table(ctx));
  mount($('#rl-export', ctx.el), exportPanel(ctx));
}
