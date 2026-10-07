// Formatação PT-BR. Dado ausente vira "—", nunca zero inventado (I5).
const DASH = '—';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function num(v, digits = 0) {
  if (!isNum(v)) return DASH;
  return v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const pct = (v, digits = 0) => (isNum(v) ? `${num(v, digits)}%` : DASH);

/** Bytes em base 1024, como o `df -h`: "145 GB", "1,8 TB". */
export function bytes(v, digits) {
  if (!isNum(v)) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let x = Math.abs(v);
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  const d = digits ?? (x < 10 && i > 0 ? 1 : 0);
  return `${v < 0 ? '-' : ''}${num(x, d)} ${units[i]}`;
}

export const mb = (v) => (isNum(v) ? bytes(v * 1024 * 1024) : DASH);
export const mbps = (v) => (isNum(v) ? `${num(v, v < 10 ? 2 : 1)} Mb/s` : DASH);
export const mbs = (v) => (isNum(v) ? `${num(v, v < 10 ? 2 : 1)} MB/s` : DASH);
export const celsius = (v) => (isNum(v) ? `${num(v, 1)} °C` : DASH);
export const ms = (v) => (isNum(v) ? `${num(v, v < 10 ? 1 : 0)} ms` : DASH);

/** "2 d 3 h", "5 h 12 min", "8 min", "40 s". */
export function duration(sec) {
  if (!isNum(sec) || sec < 0) return DASH;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  if (m) return `${m} min`;
  return `${Math.round(sec)} s`;
}

const toDate = (ts) => (ts instanceof Date ? ts : new Date(typeof ts === 'number' ? ts : Date.parse(ts)));
const valid = (d) => !Number.isNaN(d.getTime());

export function time(ts) {
  if (ts === null || ts === undefined) return DASH;
  const d = toDate(ts);
  return valid(d) ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false }) : DASH;
}

export function dateTime(ts) {
  if (ts === null || ts === undefined) return DASH;
  const d = toDate(ts);
  return valid(d)
    ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    : DASH;
}

/** Dia local AAAA-MM-DD (fuso do navegador, não UTC — B5). */
export function localDay(ts) {
  const d = toDate(ts);
  if (!valid(d)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "há 3 min", "há 2 h", "agora". */
export function ago(ts, now = Date.now()) {
  const d = toDate(ts);
  if (!valid(d)) return DASH;
  const sec = Math.max(0, (now - d.getTime()) / 1000);
  if (sec < 45) return 'agora';
  return `há ${duration(sec)}`;
}

/** Prazo em dias de forma humana: "~12 dias", "~3 meses", "~1,5 ano". */
export function days(n) {
  if (!isNum(n)) return DASH;
  if (n >= 365) return `~${num(n / 365, 1)} ano(s)`;
  if (n >= 60) return `~${num(n / 30, 0)} meses`;
  return `~${num(Math.max(1, Math.round(n)))} dia(s)`;
}
