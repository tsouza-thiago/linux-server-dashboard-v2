// 6. Eventos: linha do tempo única de alertas, anotações e quedas, com filtros, ações
// (reconhecer, resolver, remover), nova anotação e o uptime de 90 dias.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { timeline } from '../core/analysis.js';
import { badge, $ } from './common.js';

const view = { kind: 'todos', status: 'todos', page: 1 };
const PAGE = 50;

function matches(e) {
  if (view.kind !== 'todos' && e.kind !== view.kind) return false;
  if (view.status === 'abertos') {
    if (e.kind === 'alerta') return e.status === 'new' || e.status === 'ack';
    if (e.kind === 'queda') return e.ongoing;
    return false;
  }
  return true;
}

function item(e) {
  if (e.kind === 'alerta') {
    const open = e.status === 'new' || e.status === 'ack';
    return html`<li class="event event-${e.level === 'critical' ? 'bad' : 'warn'}">
      <div>${badge(e.level === 'critical' ? 'bad' : 'warn', e.level === 'critical' ? 'crítico' : 'atenção')} <b>${e.text}</b></div>
      <div class="hint">${f.dateTime(e.ts)} · ${{ new: 'aberto', ack: 'reconhecido', resolved: 'resolvido' }[e.status] || e.status}${e.until ? ` em ${f.dateTime(e.until)}` : ''}</div>
      ${open ? html`<div class="event-actions">
        ${e.status === 'new' ? html`<button class="btn-ghost" data-ack="${e.id}">Reconhecer</button>` : ''}
        <button class="btn-ghost" data-resolve="${e.id}">Resolver</button></div>` : ''}
    </li>`;
  }
  if (e.kind === 'queda') {
    return html`<li class="event event-bad">
      <div>${badge('bad', 'queda')} <b>${e.ongoing ? 'Servidor inacessível agora' : `Servidor inacessível por ${f.duration(e.durationSec)}`}</b></div>
      <div class="hint">${f.dateTime(e.ts)}${e.until ? ` → ${f.dateTime(e.until)}` : ''}${e.text ? ` · ${e.text}` : ''}</div>
    </li>`;
  }
  return html`<li class="event event-info">
    <div>${badge('info', e.label || 'anotação')} <b>${e.text}</b></div>
    <div class="hint">${f.dateTime(e.ts)}</div>
    <div class="event-actions"><button class="btn-ghost" data-remove="${e.id}">Remover</button></div>
  </li>`;
}

function list(state) {
  const all = timeline({ alerts: state.alerts?.all, annotations: state.annotations, outages: state.outages?.outages }).filter(matches);
  const shown = all.slice(0, view.page * PAGE);
  if (!all.length) return html`<p class="empty">Nenhum evento neste filtro.</p>`;
  return html`<ul class="event-list">${shown.map(item)}</ul>
    ${all.length > shown.length ? html`<button class="btn-ghost" id="ev-more">Ver mais antigos (${all.length - shown.length})</button>` : ''}`;
}

function uptime(state) {
  const u = state.outages?.uptime;
  if (!u || u.uptimePct === null || u.uptimePct === undefined) return html`<span class="hint">Uptime: aguardando dados.</span>`;
  return html`<span><b>Uptime ${f.num(u.uptimePct, 2)}%</b> <span class="hint">desde ${f.dateTime(u.from)} (até 90 dias)</span></span>`;
}

export function render(ctx) {
  const sel = (name, value, opts) => html`<select id="${name}" aria-label="${name === 'ev-kind' ? 'Tipo de evento' : 'Situação'}">${opts.map(([v, t]) => html`<option value="${v}" ${v === value ? 'selected' : ''}>${t}</option>`)}</select>`;
  mount(ctx.el, html`
    <section class="panel">
      <h3 class="panel-title">Nova anotação <span class="hint">marca um momento nos gráficos (ex.: "troquei o disco")</span></h3>
      <form class="annotation-form" id="ev-form">
        <input id="ev-text" maxlength="500" placeholder="O que aconteceu? (atalho N)" aria-label="Texto da anotação" required>
        <input id="ev-label" maxlength="80" placeholder="Rótulo (opcional)" aria-label="Rótulo">
        <button type="submit">Anotar agora</button>
      </form>
    </section>
    <section class="panel">
      <div class="toolbar">
        <div id="ev-uptime"></div>
        ${sel('ev-kind', view.kind, [['todos', 'Todos os tipos'], ['alerta', 'Alertas'], ['anotacao', 'Anotações'], ['queda', 'Quedas']])}
        ${sel('ev-status', view.status, [['todos', 'Todas as situações'], ['abertos', 'Só abertos']])}
      </div>
      <div id="ev-list"></div>
    </section>`);
  $('#ev-kind', ctx.el).addEventListener('change', (e) => { view.kind = e.target.value; view.page = 1; update(ctx); });
  $('#ev-status', ctx.el).addEventListener('change', (e) => { view.status = e.target.value; view.page = 1; update(ctx); });
  $('#ev-form', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#ev-text', ctx.el).value.trim();
    if (!text) return;
    await ctx.act.addAnnotation({ text, label: $('#ev-label', ctx.el).value.trim() });
    $('#ev-text', ctx.el).value = '';
    $('#ev-label', ctx.el).value = '';
  });
  ctx.el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.ack) ctx.act.ack(t.dataset.ack);
    else if (t.dataset.resolve) ctx.act.resolve(t.dataset.resolve);
    else if (t.dataset.remove) ctx.act.removeAnnotation(t.dataset.remove);
    else if (t.id === 'ev-more') { view.page += 1; update(ctx); }
  });
  update(ctx);
}

export function update(ctx) {
  mount($('#ev-uptime', ctx.el), uptime(ctx.state));
  mount($('#ev-list', ctx.el), list(ctx.state));
}

export const focusNew = (ctx) => $('#ev-text', ctx.el)?.focus();
