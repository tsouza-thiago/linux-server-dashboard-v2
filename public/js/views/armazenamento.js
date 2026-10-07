// 3. Armazenamento (prancheta "V2 · Armazenamento"): espaço por ponto de montagem, previsão
// de lotação (30 dias + projeção no ritmo atual), atividade de cada disco em faixas
// sincronizadas e a saúde SMART com o histórico de 90 dias.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { diskEta, diskForecast, fullestDisk, keysWith } from '../core/analysis.js';
import { $, chip, big, meter, chartBox, drawCharts, drawStrips, panelHead, icon, smartOf, onClick } from './common.js';

const DAY = 86400e3;
export const sub = () => 'Espaço, previsão de lotação, saúde SMART e atividade de cada disco';

export const actions = (ctx) => {
  const at = ctx.state.sample?.smartAt;
  return html`<span class="page-note">SMART checado 1x por hora${at ? ` · última ${f.ago(at)}` : ''}</span>`;
};

const thr = (state) => state.meta?.thresholds || state.config?.thresholds || {};
const history = (ctx) => ctx.local.disk30 || ctx.state.buckets || [];

function hotMount(ctx) {
  const disks = ctx.state.sample?.disks || [];
  const filling = disks
    .map((d) => ({ d, eta: diskEta(history(ctx), d.mount) }))
    .filter((x) => x.eta.status === 'enchendo')
    .sort((a, b) => a.eta.days - b.eta.days)[0];
  return filling ? filling.d.mount : fullestDisk(ctx.state.sample)?.mount;
}

function mountCards(ctx) {
  const s = ctx.state.sample;
  const disks = s?.disks || [];
  if (!disks.length) return html`<p class="empty">Nenhum ponto de montagem coletado ainda (DISK_MOUNTS no .env).</p>`;
  const hot = hotMount(ctx);
  return html`${disks.map((d) => {
    const eta = diskEta(history(ctx), d.mount);
    const sm = (s.smart || []).find((x) => x.dev === d.dev);
    const smi = sm ? smartOf(sm.status) : null;
    const isHot = d.mount === hot;
    return html`<article class="card mount-card stale${isHot ? ' card-hot' : ''}">
      <div class="card-top"><span class="mono mount-name">${d.mount}</span><span class="note mono">${d.source || d.dev || '—'}</span></div>
      ${big(f.num(d.pct), '%', 'xl')}
      ${meter({ pct: d.pct, color: isHot ? 's3' : 's1', glow: isHot }, { size: 'lg' })}
      <div class="row-between ink-2"><span>${f.bytes(d.usedBytes)} de ${f.bytes(d.sizeBytes)}</span><span>livre ${f.bytes(d.availBytes)}</span></div>
      <div class="chips">
        <span class="chip">inodes ${f.pct(d.inodesPct)}</span>
        <span class="chip${eta.status === 'enchendo' ? ' ink-text' : ''}">${eta.status === 'enchendo' ? `enche em ${f.days(eta.days)}` : eta.status === 'estavel' ? 'estável' : 'previsão em ~1 dia'}</span>
        ${smi ? chip(smi.level, `SMART ${sm.dev}${smi.level === 'ok' ? '' : ` · ${smi.text}`}`) : ''}
      </div>
    </article>`;
  })}`;
}

// ---------------- Previsão ----------------
function forecastOf(ctx, mountPoint) {
  return diskForecast(history(ctx), mountPoint, { alertPct: thr(ctx.state).diskPct ?? 90 });
}

function forecastHead(ctx) {
  const disks = ctx.state.sample?.disks || [];
  const sel = ctx.local.mount;
  const fc = forecastOf(ctx, sel);
  const note = fc.status === 'enchendo' ? `últimos 30 dias (linha cheia) e projeção no ritmo atual de +${f.bytes(fc.perDayBytes)}/dia (tracejada)`
    : fc.status === 'estavel' ? 'últimos 30 dias · uso estável, sem projeção de lotação' : 'últimos 30 dias · a previsão aparece depois de ~1 dia de histórico';
  return panelHead(`Previsão de lotação · ${sel || '—'}`, note,
    disks.length > 1 ? html`<div class="segmented on-bg" role="group" aria-label="Disco">${disks.map((d) => html`<button type="button" data-mount="${d.mount}" aria-pressed="${d.mount === sel}">${d.mount}</button>`)}</div>` : '');
}

function forecastChips(ctx) {
  const fc = forecastOf(ctx, ctx.local.mount);
  const t = thr(ctx.state);
  const date = (ms) => new Date(ms).toLocaleDateString('pt-BR');
  return html`
    ${fc.pct !== null ? chip('accent', `hoje · ${f.pct(fc.pct)}`, { ic: null, mono: true }) : ''}
    ${fc.status === 'enchendo' ? html`
      ${chip('warn', fc.daysToAlert === 0 ? `já acima do alerta de ${f.pct(t.diskPct)}` : `alerta de ${f.pct(t.diskPct)} em ${f.days(fc.daysToAlert)} · ${date(fc.alertAt)}`, { mono: true })}
      ${chip('crit', `cheio ~${date(fc.fullAt)}`, { ic: null, mono: true })}` : ''}`;
}

function forecastSpec(ctx) {
  const m = ctx.local.mount;
  const fc = forecastOf(ctx, m);
  const now = Date.now();
  const from = now - 30 * DAY;
  const end = fc.status === 'enchendo' ? now + Math.min(Math.max(fc.days * 1.08, 30), 365) * DAY : now;
  const t = thr(ctx.state);
  return {
    id: 'ar-fc', height: 220, range: [0, 100], annotations: false, format: (v) => f.pct(v),
    thresholds: [{ value: t.diskPct, level: 'warn' }, { value: 100, level: 'crit' }],
    xRange: [from / 1000, end / 1000],
    series: [
      { label: 'uso', key: `disk:${m}:pct`, color: 's3', fill: 0.14 },
      { label: 'projeção', key: '__projecao', color: 's3', dash: true, spanGaps: true },
    ],
    // Projeção: liga o último ponto medido ao fim da janela no ritmo atual (reta).
    transform: (x, ys) => {
      if (fc.status !== 'enchendo' || !x.length) return { x, ys };
      const lastX = x[x.length - 1];
      const endX = end / 1000;
      const endPct = Math.min(100, fc.pct + ((100 - fc.pct) * (endX - now / 1000)) / (fc.days * 86400));
      const proj = x.map((_, i) => (i === x.length - 1 ? fc.pct : null));
      return { x: [...x, endX], ys: [[...ys[0], null], [...proj, endPct]] };
    },
  };
}

// ---------------- Atividade ----------------
function devs(ctx) {
  const b = ctx.state.buckets || [];
  const fromSample = (ctx.state.sample?.io || []).map((d) => d.dev);
  return [...new Set([...fromSample, ...keysWith(b, 'io:', ':util').map((k) => k.split(':')[1])])];
}
const mountOfDev = (s, dev) => (s?.disks || []).filter((d) => d.dev === dev).map((d) => d.mount).join(' ');

function ioStats(io) {
  const cell = (k, v) => html`<span class="io-cell"><span class="k">${k}</span>${v}</span>`;
  return html`${cell('ocupado', f.pct(io?.utilPct))}${cell('ler/gravar MB/s', io ? `${f.num(io.readMBps, 1)} / ${f.num(io.writeMBps, 1)}` : '—')}${cell('latência', f.ms(io?.latencyMs))}`;
}

function smartTable(ctx) {
  const s = ctx.state.sample;
  const list = s?.smart || [];
  if (!list.length) return html`<p class="empty">Nenhum disco com SMART configurado (DISK_DEVS no .env).</p>`;
  const all = ctx.state.alerts?.all || [];
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">Disco</th><th scope="col">Resultado</th><th scope="col">Checado</th><th scope="col">Últimos 90 dias</th></tr></thead>
    <tbody>${list.map((x) => {
    const sm = smartOf(x.status);
    const fails = all.filter((a) => a.key === `smart:${x.dev}`);
    let hist;
    if (x.status === 'SEM_PERMISSAO') hist = html`falta a linha de sudo para <span class="mono">/dev/${x.dev}</span> — veja <a class="link" href="#/ajuda">Ajuda</a>`;
    else if (x.status === 'SEM_SMARTCTL') hist = 'instale o smartmontools no servidor para ver a saúde';
    else if (fails.length) hist = `${fails.length} falha(s), a última em ${f.dateTime(fails[0].ts)}`;
    else hist = x.status === 'PASSED' ? 'sem falhas registradas' : '—';
    const ic = { ok: 'check', crit: 'crit' }[sm.level] || 'serious';
    return html`<tr>
        <td class="mono">${x.dev}</td>
        <td><span class="status-ink ink-${sm.level === 'neutral' ? '2' : sm.level}">${icon(ic, 14, 2.5)}${sm.text}</span></td>
        <td class="ink-2">${f.ago(s.smartAt)}</td>
        <td class="ink-2">${hist}</td></tr>`;
  })}</tbody></table></div>`;
}

// ---------------- Montagem ----------------
export function render(ctx) {
  const disks = ctx.state.sample?.disks || [];
  if (!ctx.local.mount || !disks.some((d) => d.mount === ctx.local.mount)) ctx.local.mount = hotMount(ctx) || disks[0]?.mount;
  const list = devs(ctx);
  ctx.local.devs = list.join(',');
  mount(ctx.el, html`
    <section class="grid-cards wide" aria-label="Pontos de montagem" id="ar-mounts"></section>
    <section class="panel stale" aria-label="Previsão de lotação">
      <div id="ar-fc-head"></div>
      ${chartBox('ar-fc')}
      <div class="chips" id="ar-fc-chips"></div>
    </section>
    <section class="panel flush stale" aria-label="Atividade dos discos">
      ${panelHead(`Atividade dos discos · ${ctx.state.period}`, '% do tempo ocupado · acima de 80% por muito tempo o disco vira gargalo')}
      <div class="panel-body">${list.length ? html`<div class="strips io" data-strips="ar-io">
        ${list.map((dev) => html`<div class="strip-row io-row">
          <span class="strip-label"><span class="name mono">${dev}</span><span class="sub">${mountOfDev(ctx.state.sample, dev) || 'disco'}</span></span>
          ${chartBox(`ar-io-${dev}`)}
          <div class="io-stats" data-io="${dev}"></div>
        </div>`)}
        <div class="ticks strip-ticks"></div>
      </div>` : html`<p class="empty">Sem discos para medir atividade (DISK_DEVS no .env).</p>`}</div>
    </section>
    <section class="panel stale" aria-label="Saúde SMART">
      ${panelHead('Saúde SMART')}
      <div id="ar-smart"></div>
    </section>`);
  onClick(ctx, (e) => {
    const b = e.target.closest('[data-mount]');
    if (!b) return;
    ctx.local.mount = b.dataset.mount;
    ctx.charts.get('ar-fc')?.destroy();
    ctx.charts.delete('ar-fc');
    update(ctx);
  });
  loadDisk30(ctx);
  update(ctx);
}

function loadDisk30(ctx) {
  ctx.api.buckets({ from: new Date(Date.now() - 30 * DAY).toISOString(), to: new Date().toISOString(), limit: 720 })
    .then((r) => { ctx.local.disk30 = r.buckets || []; update(ctx); })
    .catch(() => {});
}

export function update(ctx) {
  if (devs(ctx).join(',') !== ctx.local.devs) { for (const c of ctx.charts.values()) c.destroy(); ctx.charts.clear(); render(ctx); return; }
  const s = ctx.state.sample;
  mount($('#ar-mounts', ctx.el), mountCards(ctx));
  mount($('#ar-fc-head', ctx.el), forecastHead(ctx));
  mount($('#ar-fc-chips', ctx.el), forecastChips(ctx));
  if (ctx.local.mount && ctx.local.disk30) drawCharts(ctx, ctx.el, [forecastSpec(ctx)], ctx.local.disk30);
  const list = devs(ctx);
  drawStrips(ctx, ctx.el, 'ar-io', list.map((dev) => ({
    id: `ar-io-${dev}`, label: dev, key: `io:${dev}:util`, color: 's3', range: [0, 100], format: (v) => f.pct(v), fill: 0.12,
  })));
  for (const dev of list) mount($(`[data-io="${dev}"]`, ctx.el), ioStats((s?.io || []).find((d) => d.dev === dev)));
  mount($('#ar-smart', ctx.el), smartTable(ctx));
}
