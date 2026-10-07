// Cálculos da tela, sem DOM (testáveis no Node): séries a partir dos baldes, previsão de
// disco cheio, resumo diário no fuso local (B5), manchete de saúde e linha do tempo.
import { localDay } from './format.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const AVG = 2;
const MIN = 0;
const MAX = 1;
export const STAT = { min: MIN, max: MAX, avg: AVG };

/** Valores de uma métrica alinhados aos baldes (null onde não há dado: buraco no gráfico). */
export function series(buckets, key, stat = 'avg') {
  const i = STAT[stat];
  return buckets.map((b) => {
    const v = b.m && b.m[key];
    return Array.isArray(v) && isNum(v[i]) ? v[i] : null;
  });
}

/** Eixo de tempo do uPlot (segundos), do início de cada balde. */
export const xs = (buckets) => buckets.map((b) => Math.round(b.t / 1000));

/** Chaves de um prefixo presentes nos baldes (ex.: discos `disk:` e dispositivos `io:`). */
export function keysWith(buckets, prefix, suffix) {
  const set = new Set();
  for (const b of buckets) for (const k of Object.keys(b.m || {})) if (k.startsWith(prefix) && (!suffix || k.endsWith(suffix))) set.add(k);
  return [...set].sort();
}

/**
 * Previsão de disco cheio por regressão linear do espaço livre no período. Precisa de pelo
 * menos ~1 dia de dados para não inventar tendência.
 * @returns {{status: 'cedo'|'estavel'|'enchendo', days?: number, perDayBytes?: number}}
 */
export function diskEta(buckets, mount, { minSpanMs = 24 * 3600e3 } = {}) {
  const key = `disk:${mount}:avail`;
  const pts = buckets.map((b) => [b.t, b.m?.[key]?.[AVG]]).filter(([, v]) => isNum(v));
  if (pts.length < 6 || pts[pts.length - 1][0] - pts[0][0] < minSpanMs) return { status: 'cedo' };
  const n = pts.length;
  const mx = pts.reduce((s, [t]) => s + t, 0) / n;
  const my = pts.reduce((s, [, v]) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (const [t, v] of pts) { num += (t - mx) * (v - my); den += (t - mx) ** 2; }
  const slopePerMs = den ? num / den : 0;
  const perDayBytes = -slopePerMs * 86400e3;
  const avail = pts[n - 1][1];
  // Menos de 1 MB/dia é ruído: considera estável.
  if (perDayBytes < 1024 * 1024) return { status: 'estavel', perDayBytes: Math.max(0, perDayBytes) };
  // Mais de 10 anos para encher também é "estável" na prática (evita "~34 anos" na tela).
  if (avail / perDayBytes > 3650) return { status: 'estavel', perDayBytes };
  return { status: 'enchendo', days: avail / perDayBytes, perDayBytes };
}

/**
 * Resumo por dia LOCAL (fuso do navegador; antes era UTC — B5) a partir de baldes de 1 h.
 * @returns {{day: string, n: number, m: Object<string, {min: number, max: number, avg: number}>}[]}
 */
export function dailySummary(buckets, keys) {
  const days = new Map();
  for (const b of buckets) {
    const day = localDay(b.t);
    if (!day) continue;
    let d = days.get(day);
    if (!d) { d = { day, n: 0, acc: {} }; days.set(day, d); }
    d.n += b.n || 0;
    for (const k of keys) {
      const v = b.m?.[k];
      if (!Array.isArray(v)) continue;
      const a = d.acc[k] || (d.acc[k] = { min: Infinity, max: -Infinity, sum: 0, w: 0 });
      a.min = Math.min(a.min, v[MIN]);
      a.max = Math.max(a.max, v[MAX]);
      a.sum += v[AVG] * (b.n || 1);
      a.w += b.n || 1;
    }
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).map((d) => ({
    day: d.day,
    n: d.n,
    m: Object.fromEntries(Object.entries(d.acc).map(([k, a]) => [k, { min: a.min, max: a.max, avg: a.sum / a.w }])),
  }));
}

/**
 * Servidor inacessível de verdade: o servidor marcou offline E houve falha (queda aberta ou
 * falhas seguidas). Logo depois de reiniciar o painel, antes da 1ª coleta, `online` também é
 * false, mas não houve falha nenhuma — isso não é queda.
 */
export const isOffline = (meta) => Boolean(meta && meta.online === false && (meta.offlineSince || meta.failures > 0));

/** Manchete da Visão geral a partir da saúde calculada no servidor. */
export function headline(health, { online = true } = {}) {
  if (!online) return { level: 'bad', title: 'Servidor inacessível', reasons: ['Sem resposta às últimas coletas.'] };
  if (!health) return { level: 'neutral', title: 'Aguardando a primeira coleta', reasons: [] };
  const title = health.level === 'ok' ? 'Servidor saudável' : health.level === 'warn' ? 'Atenção' : 'Crítico';
  return { level: health.level, title, score: health.score, reasons: (health.parts || []).map((p) => p.label) };
}

/** Disco mais cheio da amostra (para o cartão da Visão geral). */
export function fullestDisk(sample) {
  const list = (sample?.disks || []).filter((d) => isNum(d.pct));
  return list.length ? list.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
}

const OFFLINE_KEY = 'servidor-inacessivel';
const QUEDA_MATCH_MS = 10 * 60e3;

/**
 * Linha do tempo única: alertas, anotações e quedas, do mais recente ao mais antigo. O alerta
 * "servidor inacessível" e a queda registrada são o mesmo acontecimento: viram um item só
 * (a queda), que leva o id e a situação do alerta para "Reconhecer".
 */
export function timeline({ alerts = [], annotations = [], outages = [] }) {
  const offAlerts = alerts.filter((a) => a.key === OFFLINE_KEY);
  const used = new Set();
  const quedas = outages.map((o) => {
    const t = Date.parse(o.from);
    const a = offAlerts.find((x) => !used.has(x.id) && Math.abs(Date.parse(x.ts) - t) <= QUEDA_MATCH_MS);
    if (a) used.add(a.id);
    return { kind: 'queda', ts: o.from, until: o.to, durationSec: o.durationSec, ongoing: o.ongoing, text: o.reason || '',
      ...(a ? { id: a.id, status: a.status, key: a.key, level: a.level } : {}) };
  });
  const items = [
    ...alerts.filter((a) => !used.has(a.id)).map((a) => ({ kind: 'alerta', ts: a.ts, id: a.id, key: a.key || '', level: a.level, status: a.status, text: a.message, until: a.resolvedAt || null })),
    ...annotations.map((n) => ({ kind: 'anotacao', ts: n.ts, id: n.id, text: n.text, label: n.label || '' })),
    ...quedas,
  ];
  return items.filter((i) => i.ts && !Number.isNaN(Date.parse(i.ts))).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

// ---------------- F6: cálculos das telas redesenhadas ----------------

/** Nível visual do alerta: 'crit' (crítico) ou 'warn' (atenção). */
export const levelOf = (alert) => (alert?.level === 'critical' ? 'crit' : 'warn');

/** Para onde levar "ver no gráfico" a partir da chave estável do alerta (ADR 0006). */
export function viewOfKey(key = '') {
  if (key.startsWith('disk:') || key.startsWith('smart:')) return 'armazenamento';
  if (key.startsWith('ram:') || key.startsWith('temp:')) return 'recursos';
  if (key.startsWith('service:')) return 'processos';
  return 'eventos';
}

const DAY_MS = 86400e3;
const startOfLocalDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Tempo fora do ar (ms) dentro de [fromMs, toMs], somando as quedas. */
export function offlineMsIn(outages, fromMs, toMs, nowMs = Date.now()) {
  let off = 0;
  for (const o of outages || []) {
    const a = Math.max(Date.parse(o.from), fromMs);
    const b = Math.min(o.to ? Date.parse(o.to) : nowMs, toMs);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) off += b - a;
  }
  return off;
}

/** Disponibilidade (%) num intervalo; null antes do início do monitoramento. */
export function uptimeIn(outages, fromMs, toMs, { sinceMs = -Infinity, nowMs = Date.now() } = {}) {
  const start = Math.max(fromMs, sinceMs);
  const end = Math.min(toMs, nowMs);
  if (!(end > start)) return null;
  return Math.max(0, 100 - (offlineMsIn(outages, start, end, nowMs) / (end - start)) * 100);
}

/**
 * Um quadradinho por dia LOCAL (mais antigo → hoje) para a faixa de disponibilidade:
 * 'crit' = queda ou alerta crítico, 'warn' = alerta de atenção, 'ok' = dia monitorado sem
 * problema, 'none' = antes do monitoramento começar.
 */
export function dayStatuses({ days = 90, nowMs = Date.now(), sinceMs = null, outages = [], alerts = [] } = {}) {
  const today = startOfLocalDay(nowMs);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const from = startOfLocalDay(today - i * DAY_MS + DAY_MS / 2);
    const to = from + DAY_MS;
    const hit = (ts) => { const t = Date.parse(ts); return t >= from && t < to; };
    let status = sinceMs === null || to <= sinceMs ? 'none' : 'ok';
    const dayAlerts = (alerts || []).filter((a) => hit(a.ts));
    if (status !== 'none' && dayAlerts.some((a) => levelOf(a) === 'warn')) status = 'warn';
    if (offlineMsIn(outages, from, to, nowMs) > 0 || dayAlerts.some((a) => levelOf(a) === 'crit')) status = 'crit';
    out.push({ day: localDay(from), from, status });
  }
  return out;
}

/** Bytes trafegados estimados a partir da média por balde × coletas × intervalo. */
export function trafficOf(bucket, pollMs = 60e3) {
  const n = bucket.n || 1;
  const bytes = (key) => {
    const v = bucket.m?.[key];
    return Array.isArray(v) && isNum(v[AVG]) ? (v[AVG] * 1e6 / 8) * n * (pollMs / 1000) : 0;
  };
  return { rx: bytes('rxMbps'), tx: bytes('txMbps') };
}

/** Tráfego por dia local: [{ day, rx, tx }] do mais antigo ao mais novo. */
export function dailyTraffic(buckets, pollMs = 60e3) {
  const map = new Map();
  for (const b of buckets || []) {
    const day = localDay(b.t);
    if (!day) continue;
    const cur = map.get(day) || { day, rx: 0, tx: 0 };
    const t = trafficOf(b, pollMs);
    cur.rx += t.rx;
    cur.tx += t.tx;
    map.set(day, cur);
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** Pico (máximo) de uma métrica e quando aconteceu. */
export function peakOf(buckets, key) {
  let best = null;
  for (const b of buckets || []) {
    const v = b.m?.[key];
    if (Array.isArray(v) && isNum(v[MAX]) && (!best || v[MAX] > best.value)) best = { value: v[MAX], t: b.t };
  }
  return best;
}

/** Média ponderada pelo nº de coletas de cada balde. */
export function meanOf(buckets, key) {
  let sum = 0;
  let w = 0;
  for (const b of buckets || []) {
    const v = b.m?.[key];
    if (Array.isArray(v) && isNum(v[AVG])) { sum += v[AVG] * (b.n || 1); w += b.n || 1; }
  }
  return w ? sum / w : null;
}

/** Tendência: média do último quarto do período menos a do primeiro quarto. */
export function trendOf(buckets, key) {
  const pts = (buckets || []).map((b) => b.m?.[key]?.[AVG]).filter(isNum);
  if (pts.length < 8) return null;
  const q = Math.max(1, Math.floor(pts.length / 4));
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return avg(pts.slice(-q)) - avg(pts.slice(0, q));
}

/**
 * Maiores picos de uma ou mais métricas, sem repetir a mesma rajada: escolhe os baldes de
 * maior máximo com pelo menos `gap` baldes entre eles. Duração = baldes vizinhos acima da
 * metade do pico × intervalo do balde.
 */
export function topPeaks(buckets, keys, { n = 3, gap = 3, stepMs = 60e3 } = {}) {
  const cands = [];
  keys.forEach((key) => (buckets || []).forEach((b, i) => {
    const v = b.m?.[key];
    if (Array.isArray(v) && isNum(v[MAX]) && v[MAX] > 0) cands.push({ key, i, t: b.t, value: v[MAX] });
  }));
  cands.sort((a, b) => b.value - a.value);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= n) break;
    if (picked.some((p) => p.key === c.key && Math.abs(p.i - c.i) < gap)) continue;
    let len = 1;
    for (const dir of [-1, 1]) {
      for (let j = c.i + dir; j >= 0 && j < buckets.length; j += dir) {
        const v = buckets[j].m?.[c.key]?.[MAX];
        if (!isNum(v) || v < c.value / 2) break;
        len += 1;
      }
    }
    picked.push({ key: c.key, t: c.t, value: c.value, durationMs: len * stepMs });
  }
  return picked.sort((a, b) => b.value - a.value);
}

/**
 * Previsão do disco a partir de `diskEta` (espaço livre) e do % atual: dias até o limiar de
 * alerta e até encher, com as datas.
 */
export function diskForecast(buckets, mount, { alertPct = 90, nowMs = Date.now() } = {}) {
  const eta = diskEta(buckets, mount);
  const pts = series(buckets, `disk:${mount}:pct`).filter(isNum);
  const pct = pts.length ? pts[pts.length - 1] : null;
  if (eta.status !== 'enchendo' || pct === null) return { ...eta, pct };
  const daysToAlert = pct >= alertPct ? 0 : (eta.days * (alertPct - pct)) / Math.max(1e-6, 100 - pct);
  return { ...eta, pct, daysToAlert, fullAt: nowMs + eta.days * DAY_MS, alertAt: nowMs + daysToAlert * DAY_MS };
}

/** Status de saúde → classes visuais: ok / warn / crit. */
export const healthLevel = (level) => (level === 'bad' ? 'crit' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : 'neutral');
