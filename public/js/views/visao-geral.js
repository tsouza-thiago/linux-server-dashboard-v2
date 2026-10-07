// 1. Visão geral: manchete de saúde em linguagem simples, cartões com mini-gráfico e os
// eventos mais recentes.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { headline, fullestDisk, diskEta, timeline, isOffline } from '../core/analysis.js';
import { drawCharts, badge } from './common.js';

const LEVEL = { ok: 'ok', warn: 'warn', bad: 'bad', neutral: 'neutral' };

function card(id, title, value, note) {
  return html`
    <article class="card">
      <div class="card-title">${title}</div>
      <div class="card-value">${value}</div>
      <div class="card-note">${note}</div>
      <div class="sparkline" data-chart="${id}"></div>
    </article>`;
}

function etaText(state, disk) {
  if (!disk) return '';
  const eta = diskEta(state.buckets || [], disk.mount);
  if (eta.status === 'enchendo') return `enche em ${f.days(eta.days)}`;
  if (eta.status === 'estavel') return 'uso estável';
  return 'previsão após ~1 dia de dados';
}

function eventLine(e) {
  const when = f.ago(e.ts);
  if (e.kind === 'alerta') return html`<li>${badge(e.level === 'critical' ? 'bad' : 'warn', e.level === 'critical' ? 'crítico' : 'atenção')} ${e.text} <span class="hint">${when}</span></li>`;
  if (e.kind === 'queda') return html`<li>${badge('bad', 'queda')} ${e.ongoing ? 'servidor inacessível agora' : `inacessível por ${f.duration(e.durationSec)}`} <span class="hint">${when}</span></li>`;
  return html`<li>${badge('info', e.label || 'anotação')} ${e.text} <span class="hint">${when}</span></li>`;
}

export function render(ctx) {
  const { state } = ctx;
  const s = state.sample;
  const h = headline(state.health, { online: !isOffline(state.meta) });
  const disk = fullestDisk(s);
  const svc = Object.values(s?.services || {});
  const svcOk = svc.filter((x) => x === 'active').length;
  const ramPct = s?.ram?.total ? (s.ram.used / s.ram.total) * 100 : null;
  const events = timeline({ alerts: state.alerts?.all, annotations: state.annotations, outages: state.outages?.outages }).slice(0, 6);

  mount(ctx.el, html`
    <section class="panel headline headline-${LEVEL[h.level] || 'neutral'}" aria-live="polite">
      <div class="headline-title">${badge(LEVEL[h.level] || 'neutral', h.title)}</div>
      <p class="headline-why">${h.reasons.length ? h.reasons.join(' · ') : (s ? 'Tudo dentro dos limites configurados.' : 'Assim que a primeira coleta chegar, o resumo aparece aqui.')}</p>
      ${h.score !== undefined ? html`<span class="hint">índice de saúde ${h.score}/100</span>` : ''}
    </section>
    <div class="cards">
      ${card('vg-cpu', 'Processador', s?.cpu ? f.pct(s.cpu.pct, 1) : f.num(s?.load?.[0], 2),
    s?.cpu ? `espera de disco ${f.pct(s.cpu.iowait, 1)} · load ${f.num(s?.load?.[0], 2)}` : 'CPU % a partir da 2ª coleta')}
      ${card('vg-ram', 'Memória', f.pct(ramPct), `livre ${f.mb(s?.ram?.avail)} de ${f.mb(s?.ram?.total)}`)}
      ${card('vg-disk', 'Disco mais cheio', disk ? f.pct(disk.pct) : '—', disk ? `${disk.mount} · ${etaText(state, disk)}` : 'nenhum disco')}
      ${card('vg-temp', 'Temperatura', f.celsius(s?.tempC), s?.tempSensor ? `sensor ${s.tempSensor}` : 'sem sensor')}
      ${card('vg-net', 'Rede', s?.net ? `↓ ${f.mbps(s.net.rxMbps)}` : '—', s?.net ? `↑ ${f.mbps(s.net.txMbps)} · ${s.net.iface}` : 'interface não configurada')}
      <article class="card">
        <div class="card-title">Serviços e discos</div>
        <div class="card-value">${svc.length ? `${svcOk}/${svc.length}` : '—'}</div>
        <div class="card-note">${svc.length ? 'serviços ativos' : 'nenhum serviço configurado'}${(s?.smart || []).some((x) => x.status === 'FAILED') ? ' · SMART com falha!' : ''}</div>
      </article>
    </div>
    <section class="panel">
      <h3 class="panel-title">Eventos recentes <a class="hint" href="#/eventos">ver todos</a></h3>
      ${events.length ? html`<ul class="event-list">${events.map(eventLine)}</ul>` : html`<p class="empty">Nenhum evento ainda.</p>`}
    </section>`);
  drawSparklines(ctx);
}

// Tela só de leitura rápida: a cada coleta é redesenhada inteira (sem zoom a preservar).
function drawSparklines(ctx) {
  const disk = fullestDisk(ctx.state.sample);
  drawCharts(ctx, ctx.el, [
    { id: 'vg-cpu', sparkline: true, height: 40, format: (v) => f.pct(v), series: [{ label: 'CPU', key: 'cpu' }] },
    { id: 'vg-ram', sparkline: true, height: 40, format: (v) => f.pct(v), series: [{ label: 'RAM', key: 'ramPct', color: 1 }] },
    { id: 'vg-disk', sparkline: true, height: 40, format: (v) => f.pct(v), series: [{ label: 'Disco', key: `disk:${disk?.mount}:pct`, color: 2 }] },
    { id: 'vg-temp', sparkline: true, height: 40, format: f.celsius, series: [{ label: 'Temp', key: 'tempC', color: 3 }] },
    { id: 'vg-net', sparkline: true, height: 40, format: f.mbps, series: [{ label: 'Rede', key: 'rxMbps' }] },
  ]);
}
