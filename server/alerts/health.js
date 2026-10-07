// Índice de saúde (0–100) derivado dos MESMOS limiares dos alertas (ADR 0006). Antes a UI
// tinha limiares próprios (75/80/70) diferentes dos do poller (90/90/60).
import { SERVICE_OK, ramPct } from './rules.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {object|null} sample amostra mais recente
 * @param {object} t limiares (config.ALERTS)
 * @param {{offline?: boolean}} [state]
 * @returns {{score: number, level: 'ok'|'warn'|'bad', parts: {label: string, pts: number, level: string}[]}}
 */
export function healthScore(sample, t, { offline = false } = {}) {
  const parts = [];
  let score = 100;
  const add = (label, pts, level) => {
    score = Math.max(0, score - pts);
    parts.push({ label, pts, level });
  };
  if (offline) {
    add('Servidor offline', 100, 'bad');
    return { score: 0, level: 'bad', parts };
  }
  if (!sample) {
    add('Sem dados', 100, 'bad');
    return { score: 0, level: 'bad', parts };
  }
  const cores = sample.cores || 1;
  const load1 = Array.isArray(sample.load) ? sample.load[0] : null;
  if (isNum(load1) && load1 > cores * 1.5) add(`Load ${load1.toFixed(2)} alto (${cores} núcleo${cores > 1 ? 's' : ''})`, 10, 'warn');
  const ram = ramPct(sample);
  if (ram !== null) {
    if (ram >= t.ramPct) add(`RAM ${ram.toFixed(0)}%`, 15, 'warn');
    else if (ram >= t.ramPct - 15) add(`RAM ${ram.toFixed(0)}%`, 5, 'warn');
  }
  if (isNum(sample.tempC)) {
    if (sample.tempC >= t.tempC + 10) add(`Temp ${sample.tempC.toFixed(1)}°C`, 25, 'bad');
    else if (sample.tempC >= t.tempC) add(`Temp ${sample.tempC.toFixed(1)}°C`, 15, 'warn');
  }
  for (const d of sample.disks || []) {
    if (!d || !isNum(d.pct)) continue;
    if (d.pct >= t.diskPct) add(`Disco ${d.mount} ${d.pct}%`, 15, 'warn');
    else if (d.pct >= t.diskPct - 10) add(`Disco ${d.mount} ${d.pct}%`, 5, 'warn');
  }
  for (const s of sample.smart || []) {
    if (s && s.status === 'FAILED') add(`SMART /dev/${s.dev}`, 40, 'bad');
  }
  for (const [svc, st] of Object.entries(sample.services || {})) {
    if (st && st !== 'desconhecido' && !SERVICE_OK.has(st)) add(`Serviço ${svc} ${st}`, 25, 'bad');
  }
  const level = score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad';
  return { score, level, parts };
}
