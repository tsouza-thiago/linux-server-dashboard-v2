// 6. Eventos (prancheta "V2 · Eventos"): disponibilidade de 90 dias, filtros por tipo e
// situação, anotar agora e a linha do tempo única (alertas, quedas e anotações) agrupada por
// dia, com reconhecer, remover, "ver no gráfico" e paginação dos antigos.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { timeline, dayStatuses, levelOf, viewOfKey, offlineMsIn } from '../core/analysis.js';
import { $, icon, iconBox, panelHead, onClick } from './common.js';

export const sub = () => 'Alertas, quedas e anotações numa linha do tempo única';

const view = { kind: 'todos', status: 'qualquer', page: 1 };
const PAGE = 40;

export const actions = () => {
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  return html`
    ${perm === 'granted' ? html`<span class="chip is-ok">${icon('bell', 14)} notificações ativas</span>`
    : perm === 'unsupported' ? '' : html`<button class="btn btn-surface" type="button" data-act="notify">${icon('bell', 16)} Ativar notificações do navegador</button>`}
    <button class="btn btn-primary" type="button" data-act="note">${icon('plus', 16, 2.5)} Nova anotação</button>`;
};

export function onAction(ctx, e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'notify') ctx.act.enableNotifications();
  else focusNew(ctx);
}

const isOpen = (e) => (e.kind === 'alerta' && (e.status === 'new' || e.status === 'ack')) || (e.kind === 'queda' && e.ongoing);
const isNew = (e) => (e.kind === 'alerta' || e.kind === 'queda') && e.status === 'new';

function matches(e) {
  if (view.kind !== 'todos' && e.kind !== view.kind) return false;
  if (view.status === 'novos') return isNew(e);
  if (view.status === 'ativos') return isOpen(e);
  return true;
}

function uptime(state) {
  const o = state.outages;
  const u = o?.uptime;
  const since = u?.from ? Date.parse(u.from) : null;
  const outs = o?.outages || [];
  const svcDown = (state.alerts?.all || []).filter((a) => (a.key || '').startsWith('service:')).length;
  const offMs = offlineMsIn(outs, Date.now() - 90 * 86400e3, Date.now());
  const days = dayStatuses({ days: 90, sinceMs: since, outages: outs, alerts: state.alerts?.all });
  const word = { ok: 'sem problemas', warn: 'alerta de atenção', crit: 'queda ou crítico', none: 'sem dados' };
  const lbl = (i) => { const d = new Date(days[i].from); return i === days.length - 1 ? 'hoje' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); };
  return html`
    <div class="panel-head">
      <div class="uptime-head">
        <h2>Disponibilidade · 90 dias</h2>
        <span class="big md">${u?.uptimePct === null || u?.uptimePct === undefined ? '—' : `${f.num(u.uptimePct, 2)}%`}</span>
        <span class="note">${outs.length} queda${outs.length === 1 ? '' : 's'} · ${svcDown} serviço${svcDown === 1 ? '' : 's'} parado${svcDown === 1 ? '' : 's'} · ${f.duration(offMs / 1000)} fora no total</span>
      </div>
      <div class="legend small">
        <span><span class="swatch" data-bg="ok"></span>sem problemas</span>
        <span><span class="swatch" data-bg="warn"></span>alerta de atenção</span>
        <span><span class="swatch" data-bg="crit"></span>queda ou crítico</span>
      </div>
    </div>
    <div class="day-bars" role="img" aria-label="Disponibilidade por dia nos últimos 90 dias">
      ${days.map((d) => html`<span class="day day-${d.status}" title="${new Date(d.from).toLocaleDateString('pt-BR')}: ${word[d.status]}"></span>`)}
    </div>
    <div class="ticks"><span>${lbl(0)}</span><span>${lbl(30)}</span><span>${lbl(60)}</span><span>hoje</span></div>
    ${since ? '' : html`<span class="note">O monitoramento ainda não tem histórico.</span>`}`;
}

function filters(all) {
  const count = (k) => all.filter((e) => k === 'todos' || e.kind === k).length;
  const seg = (name, label, opts, value) => html`<div class="segmented is-text" role="group" aria-label="${label}">${opts.map(([v, t, n]) => html`
    <button type="button" data-filter="${name}" data-value="${v}" aria-pressed="${v === value}">${t}${n !== undefined ? html` <span class="count">${n}</span>` : ''}</button>`)}</div>`;
  const openNow = all.filter(isOpen).length;
  const unack = all.filter(isNew).length;
  return html`
    ${seg('kind', 'Tipo de evento', [['todos', 'Todos', count('todos')], ['alerta', 'Alertas', count('alerta')], ['queda', 'Quedas', count('queda')], ['anotacao', 'Anotações', count('anotacao')]], view.kind)}
    ${seg('status', 'Situação', [['qualquer', 'Qualquer'], ['novos', 'Não reconhecidos'], ['ativos', 'Ativos']], view.status)}
    <span class="note filters-note">${openNow ? `${openNow} ativo${openNow > 1 ? 's' : ''} agora` : 'Nenhum alerta ativo agora'}${unack ? ` · ${unack} não reconhecido${unack > 1 ? 's' : ''}` : ''}</span>`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const day = f.localDay(ts);
  const today = f.localDay(Date.now());
  const yesterday = f.localDay(Date.now() - 86400e3);
  const dm = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return day === today ? `Hoje · ${dm}` : day === yesterday ? `Ontem · ${dm}` : dm;
}

function item(e) {
  if (e.kind === 'alerta') {
    const lvl = levelOf(e);
    const state = { new: 'aberto', ack: 'reconhecido por você', resolved: e.until ? `resolvido às ${f.time(e.until)}` : 'resolvido' }[e.status] || e.status;
    const dur = e.until ? ` · durou ${f.duration((Date.parse(e.until) - Date.parse(e.ts)) / 1000)}` : '';
    return html`<li class="ev">
      <span class="ev-time mono">${f.time(e.ts)}</span>
      ${iconBox(lvl, lvl === 'crit' ? 'crit' : 'warn')}
      <div class="ev-body"><span class="ev-title">${e.text}</span>
        <span class="note"><span class="ink-${lvl}">${lvl === 'crit' ? 'Crítico' : 'Atenção'}</span>${dur} · ${state}</span></div>
      <div class="ev-actions">
        ${e.status === 'new' ? html`<span class="pill is-accent">novo</span><button class="btn btn-sm" type="button" data-ack="${e.id}">Reconhecer</button>` : ''}
        ${e.status === 'new' || e.status === 'ack' ? html`<button class="btn btn-sm btn-quiet" type="button" data-resolve="${e.id}">Resolver</button>` : ''}
        <a class="link" href="#/${viewOfKey(e.key || '')}">ver no gráfico</a>
      </div>
    </li>`;
  }
  if (e.kind === 'queda') {
    return html`<li class="ev">
      <span class="ev-time mono">${f.time(e.ts)}</span>
      ${iconBox('crit', 'outage')}
      <div class="ev-body"><span class="ev-title">${e.ongoing ? 'Servidor inacessível agora' : `Servidor inacessível por ${f.duration(e.durationSec)}`}</span>
        <span class="note"><span class="ink-crit">Crítico</span> · ${f.time(e.ts)} → ${e.until ? f.time(e.until) : 'agora'}${e.text ? ` · motivo: ${e.text}` : ''}${e.status === 'ack' ? ' · reconhecido por você' : ''}</span></div>
      ${e.id && e.status === 'new' ? html`<div class="ev-actions"><span class="pill is-accent">novo</span><button class="btn btn-sm" type="button" data-ack="${e.id}">Reconhecer</button></div>` : ''}
    </li>`;
  }
  return html`<li class="ev">
    <span class="ev-time mono">${f.time(e.ts)}</span>
    ${iconBox('', 'note')}
    <div class="ev-body"><span class="ev-title">${e.text}</span>
      <span class="note">Anotação${e.label ? ` · ${e.label}` : ''} · marcada nos gráficos</span></div>
    <div class="ev-actions"><button class="btn btn-sm btn-quiet" type="button" data-remove="${e.id}">Remover</button></div>
  </li>`;
}

function list(all) {
  const filtered = all.filter(matches);
  const shown = filtered.slice(0, view.page * PAGE);
  if (!filtered.length) return html`<p class="empty ev-empty">Nenhum evento neste filtro.</p>`;
  const groups = [];
  for (const e of shown) {
    const key = f.localDay(e.ts);
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, label: dayLabel(e.ts), items: [] });
    groups[groups.length - 1].items.push(e);
  }
  return html`${groups.map((g) => html`<h3 class="ev-day">${g.label}</h3><ul class="event-list">${g.items.map(item)}</ul>`)}
    ${filtered.length > shown.length ? html`<div class="ev-more"><button class="btn btn-quiet" type="button" id="ev-more">Carregar eventos mais antigos (${filtered.length - shown.length})</button></div>` : ''}`;
}

const allEvents = (state) => timeline({ alerts: state.alerts?.all, annotations: state.annotations, outages: state.outages?.outages });

export function render(ctx) {
  mount(ctx.el, html`
    <section class="panel" aria-label="Disponibilidade nos últimos 90 dias" id="ev-uptime"></section>
    <div class="filters" id="ev-filters"></div>
    <section class="panel flush" aria-label="Linha do tempo">
      <form class="note-bar" id="ev-form">
        <label for="ev-text">Anotar agora</label>
        <input class="input" id="ev-text" maxlength="500" placeholder="ex.: limpei a poeira do cooler" required>
        <button class="btn btn-soft" type="submit">Salvar</button>
        <span class="note">a anotação aparece como marca em todos os gráficos</span>
      </form>
      <div id="ev-list"></div>
    </section>`);
  $('#ev-form', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#ev-text', ctx.el);
    const text = input.value.trim();
    if (!text) return;
    await ctx.act.addAnnotation({ text });
    input.value = '';
  });
  onClick(ctx, (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.filter) { view[t.dataset.filter] = t.dataset.value; view.page = 1; update(ctx); }
    else if (t.dataset.ack) ctx.act.ack(t.dataset.ack);
    else if (t.dataset.resolve) ctx.act.resolve(t.dataset.resolve);
    else if (t.dataset.remove) ctx.act.removeAnnotation(t.dataset.remove);
    else if (t.id === 'ev-more') { view.page += 1; update(ctx); }
  });
  update(ctx);
}

export function update(ctx) {
  const all = allEvents(ctx.state);
  mount($('#ev-uptime', ctx.el), uptime(ctx.state));
  mount($('#ev-filters', ctx.el), filters(all));
  mount($('#ev-list', ctx.el), list(all));
}

export const focusNew = (ctx) => $('#ev-text', ctx.el)?.focus();
