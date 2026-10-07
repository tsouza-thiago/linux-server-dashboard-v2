// 1. Visão geral (prancheta "V2 · Visão geral"): saúde em linguagem simples com o anel 0–100,
// cinco indicadores com mini-gráfico, telemetria em faixas com cursor sincronizado e os
// resumos de armazenamento, eventos e processos. Estados: carregando, primeiro uso, alerta
// crítico, aviso de configuração e offline (valores da última coleta boa, em cinza).
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import {
  headline, fullestDisk, diskEta, timeline, isOffline, healthLevel, levelOf, viewOfKey, peakOf,
  dailyTraffic, series,
} from '../core/analysis.js';
import { PERIODS } from '../core/router.js';
import {
  $, icon, pill, chip, iconBox, big, n0, meter, chartBox, drawCharts, drawStrips, strips, panelHead, smartOf, onClick,
} from './common.js';

const RING = 2 * Math.PI * 58;
export const ownSkeleton = true;

// ---------------- Alerta crítico: título e "o que fazer" por tipo de alerta ----------------
export function advice(alert) {
  const key = alert?.key || '';
  const name = key.split(':')[1] || '';
  if (key.startsWith('smart:')) return { title: `O disco ${name} avisou que pode falhar`, todo: 'Faça backup agora: copie os dados importantes desse disco para outro disco hoje.' };
  if (key.startsWith('service:')) return { title: `O serviço ${name} parou`, todo: `Veja em Processos & serviços. No servidor, "systemctl status ${name}" mostra o motivo.` };
  if (key === 'servidor-inacessivel') return { title: 'Servidor inacessível', todo: 'Confira se o servidor está ligado e na rede. O painel tenta de novo a cada coleta e se recupera sozinho.' };
  if (key.startsWith('disk:')) return { title: alert.message, todo: 'Libere espaço ou mova arquivos. Veja em Armazenamento quando ele enche no ritmo atual.' };
  if (key.startsWith('ram:')) return { title: alert.message, todo: 'Veja quem consome memória em Processos & serviços.' };
  if (key.startsWith('temp:')) return { title: alert.message, todo: 'Confira ventilação, poeira e pasta térmica.' };
  return { title: alert?.message || 'Alerta', todo: '' };
}

const worst = (alerts) => (alerts || []).slice().sort((a, b) => (levelOf(b) === 'crit') - (levelOf(a) === 'crit'))[0] || null;

// ---------------- Peças ----------------
function ring(score, level) {
  const dash = Math.max(0, Math.min(1, (score ?? 0) / 100)) * RING;
  return html`<div class="ring ring-${level}">
    <svg width="136" height="136" viewBox="0 0 136 136" aria-hidden="true">
      <circle cx="68" cy="68" r="58" fill="none" class="ring-track" stroke-width="10"></circle>
      <circle cx="68" cy="68" r="58" fill="none" class="ring-value" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${RING.toFixed(1)}" transform="rotate(-90 68 68)"></circle>
    </svg>
    <div class="ring-label"><span class="ring-score">${score ?? '—'}</span><span>saúde / 100</span></div>
  </div>`;
}

function narrative(state, local = {}) {
  const s = state.sample;
  const disk = fullestDisk(s);
  const parts = [];
  if (disk) {
    const eta = diskEta(local.disk30 || state.buckets || [], disk.mount);
    if (eta.status === 'enchendo') parts.push(html`No ritmo atual, <b>${disk.mount} enche em ${f.days(eta.days)}</b>.`);
    else if (eta.status === 'estavel') parts.push(html`O disco mais cheio, <b>${disk.mount}</b>, está com ${f.pct(disk.pct)} e uso estável.`);
    else parts.push(html`O disco mais cheio, <b>${disk.mount}</b>, está com ${f.pct(disk.pct)}. A previsão de lotação aparece depois de ~1 dia de histórico.`);
  }
  const recent = (state.alerts?.all || []).find((a) => a.status === 'resolved' && Date.now() - Date.parse(a.ts) < 48 * 3600e3);
  if (recent) {
    const dur = recent.resolvedAt ? f.duration((Date.parse(recent.resolvedAt) - Date.parse(recent.ts)) / 1000) : null;
    parts.push(html` ${recent.message} ${f.ago(recent.ts)}${dur ? ` e voltou ao normal sozinho em ${dur}` : ''}.`);
  }
  return parts;
}

function hero(ctx) {
  const { state } = ctx;
  const offline = isOffline(state.meta);
  const active = state.alerts?.active || [];
  const top = worst(active);
  const h = headline(state.health, { online: !offline });
  const crit = !offline && top && levelOf(top) === 'crit';
  const level = offline || crit ? 'crit' : healthLevel(h.level);
  const uptime = state.outages?.uptime?.uptimePct;
  const ev24 = timeline({ alerts: state.alerts?.all, annotations: state.annotations, outages: state.outages?.outages })
    .filter((e) => Date.now() - Date.parse(e.ts) < 86400e3).length;
  const c = state.sample?.collector;
  const interval = state.meta?.pollIntervalMs || 60000;
  const cost = Number.isFinite(c?.durationMs) ? `${f.num((c.durationMs / 1000) * (60000 / interval), 1)} s/min` : '—';
  let badge;
  if (offline) badge = pill('crit', 'Servidor inacessível', { lg: true, iconOnly: 'outage' });
  else if (!active.length) badge = pill('ok', 'Nenhum alerta ativo', { lg: true });
  else badge = pill(levelOf(top), `${active.length} alerta${active.length > 1 ? 's' : ''} ativo${active.length > 1 ? 's' : ''}`, { lg: true });

  let title = h.title;
  let text = h.reasons.length && h.level !== 'ok' ? html`${h.reasons.join(' · ')}.` : narrative(state, ctx.local);
  let todo = null;
  if (offline) {
    title = 'Servidor inacessível';
    text = html`Os valores abaixo são da última coleta boa${state.sample?.ts ? `, às ${f.time(state.sample.ts)}` : ''}. Nada se perde: o histórico fica guardado e o painel volta sozinho quando o servidor responder.`;
  } else if (crit) {
    const a = advice(top);
    title = a.title;
    text = html`${top.message} · desde ${f.dateTime(top.ts)}`;
    todo = a.todo;
  }
  return html`
    <section class="hero hero-${level}" aria-label="Saúde do servidor">
      ${ring(offline ? 0 : h.score, level)}
      <div class="hero-text">
        ${badge}
        <h2>${title}</h2>
        <p>${text || 'Tudo dentro dos limites configurados.'}</p>
        ${todo ? html`<div class="hero-todo">
          <span><b>O que fazer:</b> ${todo}</span>
          ${top.status === 'new' ? html`<button class="btn btn-sm" type="button" data-ack="${top.id}">Reconhecer</button>` : ''}
          <a class="link" href="#/${viewOfKey(top.key)}">ver detalhes</a>
        </div>` : ''}
      </div>
      <div class="hero-minis">
        <div class="mini"><span class="k">Disponibilidade 90 d</span><span class="v big sm">${uptime === null || uptime === undefined ? '—' : `${f.num(uptime, 2)}%`}</span></div>
        <div class="mini"><span class="k">Eventos 24 h</span><span class="v big sm">${ev24}</span></div>
        <div class="mini"><span class="k">Custo no servidor</span><span class="v big sm">${cost}</span></div>
      </div>
    </section>`;
}

// Cartões: estrutura fixa (o mini-gráfico sobrevive às atualizações); só os textos mudam.
const CARDS = ['cpu', 'ram', 'disk', 'temp', 'net'];
const cardShell = (id) => html`
  <article class="card stale" id="vg-card-${id}">
    <div class="card-top"><span class="card-label" data-slot="label"></span><span data-slot="pill"></span></div>
    <span data-slot="value"></span>
    <span class="note" data-slot="note"></span>
    <div class="card-viz" data-slot="viz">${id === 'cpu' || id === 'ram' || id === 'temp' ? chartBox(`vg-${id}`, 'spark') : ''}</div>
  </article>`;

function cardContent(ctx) {
  const { state } = ctx;
  const s = state.sample;
  const t = state.meta?.thresholds || state.config?.thresholds || {};
  const ramPct = s?.ram?.total ? (s.ram.used / s.ram.total) * 100 : null;
  const cores = s?.cores || 1;
  const load1 = s?.load?.[0];
  const disk = fullestDisk(s);
  const eta = disk ? diskEta(ctx.local.disk30 || state.buckets || [], disk.mount) : null;
  const tempPeak = peakOf(state.buckets, 'tempC');
  const today = dailyTraffic((state.buckets || []).filter((b) => b.t >= new Date().setHours(0, 0, 0, 0)), state.meta?.pollIntervalMs);
  const todayBytes = today.length ? today[0].rx + today[0].tx : null;
  const coversToday = PERIODS[state.period] >= Date.now() - new Date().setHours(0, 0, 0, 0);
  return {
    cpu: {
      label: 'Processador',
      pill: !s?.cpu ? '' : Number.isFinite(load1) && load1 > cores * 1.5 ? pill('warn', 'sobrecarregado') : pill('ok', 'tranquilo'),
      value: big(n0(s?.cpu?.pct), '%'),
      note: s?.cpu ? `iowait ${f.pct(s.cpu.iowait)} · load ${f.num(load1, 2)}` : 'CPU % a partir da 2ª coleta',
    },
    ram: {
      label: 'Memória',
      pill: ramPct === null ? '' : ramPct >= t.ramPct ? pill('warn', 'acima do limite') : ramPct >= t.ramPct - 15 ? pill('warn', 'alta') : pill('ok', 'ok'),
      value: big(n0(ramPct), '%'),
      note: s?.ram ? `${f.mb(s.ram.used)} de ${f.mb(s.ram.total)} · swap ${f.mb(s.ram.swapUsed)}${s.psi?.memory ? ` · PSI ${f.pct(s.psi.memory.some10, 1)}` : ''}` : 'sem dados de memória',
    },
    disk: {
      label: 'Disco mais cheio',
      pill: !eta || eta.status === 'cedo' ? '' : eta.status === 'enchendo' ? pill(eta.days < 30 ? 'warn' : 'neutral', f.days(eta.days)) : pill('neutral', 'estável'),
      value: big(n0(disk?.pct), '%'),
      note: disk ? `${disk.mount} · ${f.bytes(disk.usedBytes)} de ${f.bytes(disk.sizeBytes)}` : 'nenhum disco',
      viz: disk ? html`<div class="card-meter">${meter({ pct: disk.pct, color: 's3', glow: true }, { size: 'lg' })}
        <div class="card-meter-foot"><span>${eta?.status === 'enchendo' ? `+${f.bytes(eta.perDayBytes)}/dia` : eta?.status === 'estavel' ? 'uso estável' : 'previsão: ~1 dia'}</span><span>alerta em ${f.pct(t.diskPct)}</span></div></div>` : '',
    },
    temp: {
      label: 'Temperatura',
      pill: !Number.isFinite(s?.tempC) ? '' : s.tempC >= t.tempC ? pill('warn', 'acima do limite') : pill('ok', 'normal'),
      value: big(n0(s?.tempC), '°C'),
      note: Number.isFinite(s?.tempC) ? `${s.tempSensor || 'sensor'}${tempPeak ? ` · pico ${f.celsius(tempPeak.value)}` : ''}` : 'sem sensor de temperatura',
    },
    net: {
      label: s?.net ? `Rede · ${s.net.iface}` : 'Rede',
      pill: html`<span class="note mono">Mbps</span>`,
      value: big(s?.net ? f.num(s.net.rxMbps, s.net.rxMbps < 10 ? 1 : 0) : '—', ' ↓'),
      note: s?.net ? `↑ ${f.mbps(s.net.txMbps)}${coversToday && todayBytes > 0 ? ` · ${f.bytes(todayBytes)} hoje` : ''}` : 'interface não configurada (NET_IF)',
      viz: netBars(state.buckets),
    },
  };
}

/** Mini barras da rede: 11 grupos do período, com os picos em destaque. */
function netBars(buckets) {
  const v = series(buckets || [], 'rxMbps', 'max');
  if (!v.some((x) => x !== null)) return html`<div class="bars"></div>`;
  const n = 11;
  const size = Math.max(1, Math.ceil(v.length / n));
  const groups = Array.from({ length: Math.ceil(v.length / size) }, (_, i) => Math.max(0, ...v.slice(i * size, (i + 1) * size).filter((x) => x !== null)));
  const max = Math.max(...groups, 1e-9);
  return html`<div class="bars" aria-hidden="true">${groups.slice(-n).map((g) => html`<span class="${g >= max * 0.6 ? 'hot' : ''}" data-h="${Math.max(6, (g / max) * 100)}"></span>`)}</div>`;
}

// Faixas da telemetria: CPU, RAM, temperatura, I/O do 1º disco e rede (só as que existem).
function telemetryRows(state) {
  const t = state.meta?.thresholds || state.config?.thresholds || {};
  const s = state.sample;
  const dev = s?.io?.[0]?.dev;
  const rows = [
    { id: 'vg-t-cpu', label: 'CPU', sub: '0–100%', key: 'cpu', color: 's1', range: [0, 100], format: (v) => f.pct(v) },
    { id: 'vg-t-ram', label: 'RAM', sub: '0–100%', key: 'ramPct', color: 's2', range: [0, 100], format: (v) => f.pct(v) },
  ];
  if (Number.isFinite(s?.tempC) || !s) {
    rows.push({ id: 'vg-t-temp', label: 'Temp', sub: `limite ${f.num(t.tempC)}°`, key: 'tempC', color: 's4', format: (v) => f.celsius(v), valueFormat: (v) => `${f.num(v)}°`,
      thresholds: [{ value: t.tempC, level: 'warn' }], fill: 0 });
  }
  if (dev) rows.push({ id: 'vg-t-io', label: `I/O ${dev}`, sub: '% ocupado', key: `io:${dev}:util`, color: 's3', range: [0, 100], format: (v) => f.pct(v), fill: 0 });
  if (s?.net) rows.push({ id: 'vg-t-net', label: 'Rede ↓', sub: 'Mbps', key: 'rxMbps', color: 's1', format: f.mbps, valueFormat: (v) => f.num(v, v < 10 ? 1 : 0), fill: 0 });
  return rows;
}

function telemetryChips(state) {
  const [from, to] = (state.bucketsRange || []).map((x) => x * 1000);
  const inRange = (ts) => { const t = Date.parse(ts); return t >= from && t <= to; };
  const alert = (state.alerts?.all || []).find((a) => inRange(a.ts));
  const note = (state.annotations || []).slice().reverse().find((a) => inRange(a.ts));
  const dur = (a) => (a.resolvedAt ? ` · ${f.duration((Date.parse(a.resolvedAt) - Date.parse(a.ts)) / 1000)}` : '');
  return html`
    ${alert ? chip(levelOf(alert), `${f.time(alert.ts)} ${alert.message}${dur(alert)}`, { mono: true }) : ''}
    ${note ? chip('', `${f.time(note.ts)} nota · ${note.text}`, { ic: 'note', mono: true }) : ''}`;
}

// ---------------- Painéis de baixo ----------------
function disksPanel(state, local) {
  const s = state.sample;
  const disks = s?.disks || [];
  const hist = local.disk30 || state.buckets || [];
  const filling = disks.map((d) => ({ d, eta: diskEta(hist, d.mount) })).filter((x) => x.eta.status === 'enchendo').sort((a, b) => a.eta.days - b.eta.days)[0];
  const hotMount = filling ? filling.d.mount : fullestDisk(s)?.mount;
  return html`
    ${panelHead('Armazenamento', '', html`<a class="link" href="#/armazenamento">detalhes</a>`)}
    ${disks.length ? disks.map((d) => {
    const eta = diskEta(local.disk30 || state.buckets || [], d.mount);
    const hot = d.mount === hotMount;
    const tail = eta.status === 'enchendo' ? `enche ${f.days(eta.days)}` : eta.status === 'estavel' ? 'estável' : `${f.bytes(d.usedBytes)} / ${f.bytes(d.sizeBytes)}`;
    return html`<div class="disk-row">
        <div class="disk-row-top"><span class="mono">${d.mount}</span><span class="ink-2">${f.pct(d.pct)} · ${tail}</span></div>
        ${meter({ pct: d.pct, color: hot ? 's3' : 's1', glow: hot })}
      </div>`;
  }) : html`<p class="empty">Nenhum ponto de montagem coletado ainda.</p>`}
    <div class="chips">
      ${(s?.smart || []).map((x) => { const sm = smartOf(x.status); return chip(sm.level, `SMART ${x.dev}${sm.level === 'ok' ? '' : ` · ${sm.text}`}`); })}
      ${s?.smartAt ? chip('', `checado ${f.ago(s.smartAt)}`, { ic: null }) : ''}
    </div>`;
}

function eventItem(e) {
  if (e.kind === 'alerta') {
    const lvl = levelOf(e);
    const dur = e.until ? ` · resolvido em ${f.duration((Date.parse(e.until) - Date.parse(e.ts)) / 1000)}` : '';
    return html`<div class="ev-mini">${iconBox(lvl, lvl === 'crit' ? 'crit' : 'warn', 'sm')}<div><span>${e.text}</span><span class="note">${lvl === 'crit' ? 'Crítico' : 'Aviso'} · ${f.dateTime(e.ts)}${dur}</span></div></div>`;
  }
  if (e.kind === 'queda') {
    return html`<div class="ev-mini">${iconBox('crit', 'outage', 'sm')}<div><span>${e.ongoing ? 'Servidor inacessível agora' : `Servidor inacessível por ${f.duration(e.durationSec)}`}</span><span class="note">Crítico · ${f.dateTime(e.ts)}${e.until ? ` → ${f.time(e.until)}` : ''}</span></div></div>`;
  }
  return html`<div class="ev-mini">${iconBox('', 'note', 'sm')}<div><span>${e.text}</span><span class="note">Anotação · ${f.dateTime(e.ts)}</span></div></div>`;
}

function eventsPanel(state) {
  const events = timeline({ alerts: state.alerts?.all, annotations: state.annotations, outages: state.outages?.outages }).slice(0, 3);
  return html`
    ${panelHead('Eventos recentes', '', html`<a class="link" href="#/eventos">linha do tempo</a>`)}
    ${events.length ? events.map(eventItem) : html`<p class="empty">Nenhum evento ainda.</p>`}
    <button class="btn btn-quiet align-start" type="button" data-annotate>${icon('plus', 16)} Anotar agora</button>`;
}

const cmdName = (cmd = '') => (cmd.split(/\s+/)[0] || '').split('/').pop() || cmd;

function procsPanel(state) {
  const s = state.sample;
  const procs = (s?.topProcs || []).slice().sort((a, b) => (b.rssKB ?? 0) - (a.rssKB ?? 0)).slice(0, 3);
  const svc = Object.entries(s?.services || {});
  return html`
    ${panelHead('Processos & serviços', '', html`<a class="link" href="#/processos">todos</a>`)}
    ${procs.length ? html`<div class="table-wrap"><table class="table compact">
      <thead><tr><th scope="col">comando</th><th scope="col" class="num">mem</th><th scope="col" class="num">rss</th></tr></thead>
      <tbody class="mono">${procs.map((p) => html`<tr><td title="${p.cmd}">${cmdName(p.cmd)}</td><td class="num">${f.pct(p.mem, 1)}</td><td class="num ink-2">${f.bytes(p.rssKB * 1024)}</td></tr>`)}</tbody>
    </table></div>` : html`<p class="empty">Sem processos na última coleta.</p>`}
    <div class="chips">${svc.map(([name, st]) => {
    const ok = ['active', 'reloading', 'activating'].includes(st);
    return html`<span class="chip ${ok ? 'is-ok' : st === 'desconhecido' ? 'is-neutral' : 'is-crit'}"><span class="dot"></span>${name} ${ok ? 'ativo' : st}</span>`;
  })}</div>`;
}

// ---------------- Estados especiais ----------------
function skeleton() {
  return html`
    <section class="hero" aria-label="Carregando" aria-busy="true">
      <div class="skel ring-skel"></div>
      <div class="hero-text"><div class="skel" data-w="40"></div><div class="skel tall" data-w="70"></div><div class="skel soft" data-w="85"></div></div>
    </section>
    <div class="grid-cards narrow">${CARDS.map(() => html`<div class="skel soft card-skel"></div>`)}</div>
    <div class="skel soft panel-skel"></div>
    <p class="note">Carregando o histórico… · blocos no formato final, nada "pula" quando os dados chegam.</p>`;
}

function firstUse(state) {
  const s = state.sample;
  if (isOffline(state.meta) || (s && s.cpu && Number.isFinite(s.cpu.pct))) return '';
  const next = state.meta?.nextPollAt ? Math.max(0, Math.round((Date.parse(state.meta.nextPollAt) - Date.now()) / 1000)) : null;
  const step = (done, text, busy) => html`<div class="step">${done ? html`<span class="step-ok">${icon('check', 12, 3)}</span>` : busy ? html`<span class="spinner"></span>` : html`<span class="step-todo"></span>`}<span class="${done || busy ? '' : 'ink-3'}">${text}</span></div>`;
  return html`<section class="panel first-use" aria-label="Primeiro uso">
    <span class="eyebrow">PRIMEIRO USO</span>
    <h2>${s ? `Conectado ao ${s.host}. Montando o painel…` : `Conectando ao ${state.meta?.host || 'servidor'}…`}</h2>
    <div class="steps">
      ${step(Boolean(s), 'Chave SSH aceita e comando de coleta respondendo', !s)}
      ${step(Boolean(s), '1ª amostra recebida: discos, memória, serviços, temperatura', false)}
      ${step(false, `CPU % e rede precisam de 2 coletas${next !== null && s ? ` · faltam ${next} s` : ''}`, Boolean(s))}
      ${step(false, 'Previsão de lotação aparece depois de ~1 dia de histórico', false)}
    </div>
  </section>`;
}

function configWarning(state) {
  const c = state.sample?.collector;
  if (!c?.hashMismatch) return '';
  return html`<section class="panel notice notice-warn" aria-label="Aviso de configuração">
    <div class="notice-row">${iconBox('warn', 'key', 'lg')}<div>
      <h2>A configuração no servidor está desatualizada</h2>
      <p>Você mudou os alvos da coleta no <span class="mono">.env</span>, mas a linha restrita no <span class="mono">authorized_keys</span> do servidor ainda é a antiga. O painel continua coletando o que já estava liberado. Veja em Ajuda › Acesso ao servidor.</p>
    </div></div>
    <span class="note mono">esperado ${c.expectedHash || '—'} · servidor ${c.hash || '—'}</span>
  </section>`;
}

// ---------------- Montagem ----------------
const sigOf = (state) => telemetryRows(state).map((r) => r.id).join(',');

export function render(ctx) {
  if (ctx.state.loading) { mount(ctx.el, skeleton()); ctx.local.skeleton = true; return; }
  ctx.local.skeleton = false;
  const rows = telemetryRows(ctx.state);
  ctx.local.sig = sigOf(ctx.state);
  mount(ctx.el, html`
    <div id="vg-top"></div>
    <div id="vg-hero"></div>
    <section class="grid-cards narrow" aria-label="Indicadores">${CARDS.map(cardShell)}</section>
    <section class="panel flush stale" aria-label="Telemetria">
      <div class="panel-head"><div><h2>Telemetria · ${ctx.state.period}</h2><span class="hint">cursor sincronizado em todas as faixas · roda do mouse = zoom · arrastar = selecionar intervalo</span></div><div class="chips" id="vg-chips"></div></div>
      <div class="panel-body">${strips('vg-tel', rows)}</div>
    </section>
    <div class="grid-3">
      <section class="panel stale" id="vg-disks" aria-label="Armazenamento"></section>
      <section class="panel" id="vg-events" aria-label="Eventos recentes"></section>
      <section class="panel stale" id="vg-procs" aria-label="Processos e serviços"></section>
    </div>`);
  onClick(ctx, (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.ack) ctx.act.ack(t.dataset.ack);
    else if ('annotate' in t.dataset) ctx.act.go('eventos');
  });
  loadDisk30(ctx);
  update(ctx);
}

/** Previsão de disco usa 30 dias (independe do período escolhido); recarrega a cada hora. */
function loadDisk30(ctx) {
  if (ctx.local.disk30At && Date.now() - ctx.local.disk30At < 3600e3) return;
  ctx.local.disk30At = Date.now();
  ctx.api.buckets({ from: new Date(Date.now() - 30 * 86400e3).toISOString(), to: new Date().toISOString(), limit: 720 })
    .then((r) => { ctx.local.disk30 = r.buckets || []; update(ctx); })
    .catch(() => {});
}

export function update(ctx) {
  if (ctx.local.skeleton || ctx.state.loading) { if (!ctx.state.loading) render(ctx); return; }
  if (sigOf(ctx.state) !== ctx.local.sig) {
    for (const c of ctx.charts.values()) c.destroy();
    ctx.charts.clear();
    render(ctx);
    return;
  }
  const { state } = ctx;
  mount($('#vg-top', ctx.el), html`${configWarning(state)}${firstUse(state)}`);
  mount($('#vg-hero', ctx.el), hero(ctx));
  const content = cardContent(ctx);
  for (const id of CARDS) {
    const card = $(`#vg-card-${id}`, ctx.el);
    const c = content[id];
    for (const slot of ['label', 'pill', 'value', 'note']) mount(card.querySelector(`[data-slot="${slot}"]`), c[slot] ?? '');
    if (c.viz !== undefined) mount(card.querySelector('[data-slot="viz"]'), c.viz);
  }
  const t = state.meta?.thresholds || state.config?.thresholds || {};
  drawCharts(ctx, ctx.el, [
    { id: 'vg-cpu', height: 44, axes: false, interactive: false, annotations: false, format: (v) => f.pct(v), series: [{ label: 'CPU', key: 'cpu', color: 's1', fill: 'gradient' }] },
    { id: 'vg-ram', height: 44, axes: false, interactive: false, annotations: false, format: (v) => f.pct(v), series: [{ label: 'RAM', key: 'ramPct', color: 's2', fill: 'gradient' }] },
    { id: 'vg-temp', height: 44, axes: false, interactive: false, annotations: false, format: f.celsius, thresholds: [{ value: t.tempC, level: 'warn' }],
      series: [{ label: 'Temperatura', key: 'tempC', color: 's4' }] },
  ]);
  mount($('#vg-chips', ctx.el), telemetryChips(state));
  drawStrips(ctx, ctx.el, 'vg-tel', telemetryRows(state));
  mount($('#vg-disks', ctx.el), disksPanel(state, ctx.local));
  mount($('#vg-events', ctx.el), eventsPanel(state));
  mount($('#vg-procs', ctx.el), procsPanel(state));
}

// Cabeçalho: exportar o período (CSV) ao lado do período e do tema.
export const actions = (ctx) => {
  const to = new Date();
  const from = new Date(to.getTime() - PERIODS[ctx.state.period]);
  return html`<a class="btn btn-surface" href="${ctx.api.exportUrl({ format: 'csv', from: from.toISOString(), to: to.toISOString() })}" download>${icon('download', 16)} Exportar</a>`;
};
