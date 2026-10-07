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

/** Linha do tempo única: alertas, anotações e quedas, do mais recente ao mais antigo. */
export function timeline({ alerts = [], annotations = [], outages = [] }) {
  const items = [
    ...alerts.map((a) => ({ kind: 'alerta', ts: a.ts, id: a.id, level: a.level, status: a.status, text: a.message, until: a.resolvedAt || null })),
    ...annotations.map((n) => ({ kind: 'anotacao', ts: n.ts, id: n.id, text: n.text, label: n.label || '' })),
    ...outages.map((o) => ({ kind: 'queda', ts: o.from, until: o.to, durationSec: o.durationSec, ongoing: o.ongoing, text: o.reason || '' })),
  ];
  return items.filter((i) => i.ts && !Number.isNaN(Date.parse(i.ts))).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}
