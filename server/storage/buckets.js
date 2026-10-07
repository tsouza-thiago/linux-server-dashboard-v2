// Agregação por balde (ADR 0005). Duas formas, as duas preservando picos (corrige B8):
// - `aggregate()`: baldes compactos { t, n, m: { métrica: [mín, máx, média] } } — formato dos
//   rollups de 5 min e da resposta `formato=baldes` de /api/history;
// - `downsample()`: amostras no formato original para o frontend atual, em que cada ponto
//   reduzido carrega o PIOR valor do balde (máximo de uso, mínimo de folga).
// Dado ausente nunca vira zero (I5): métrica sem valor no balde simplesmente não aparece.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Arredonda para gravar: inteiros grandes sem casas, demais com 2 casas. */
export function roundValue(v) {
  return Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 100) / 100;
}

/** Métricas numéricas de uma amostra (v1 ou v2), achatadas em { chave: número }. */
export function flatten(s) {
  const out = {};
  const put = (key, v) => { if (isNum(v)) out[key] = v; };
  if (Array.isArray(s.load)) { put('load1', s.load[0]); put('load5', s.load[1]); put('load15', s.load[2]); }
  if (s.cpu) { put('cpu', s.cpu.pct); put('cpuIowait', s.cpu.iowait); put('cpuSteal', s.cpu.steal); }
  if (s.ram) {
    put('ramUsed', s.ram.used);
    put('ramAvail', s.ram.avail);
    put('swapUsed', s.ram.swapUsed);
    if (isNum(s.ram.used) && isNum(s.ram.total) && s.ram.total > 0) put('ramPct', (s.ram.used / s.ram.total) * 100);
  }
  put('tempC', s.tempC);
  if (s.net) { put('rxMbps', s.net.rxMbps); put('txMbps', s.net.txMbps); }
  for (const d of s.disks || []) {
    if (!d || !d.mount) continue;
    put(`disk:${d.mount}:pct`, d.pct);
    put(`disk:${d.mount}:avail`, d.availBytes);
  }
  for (const d of s.io || []) {
    if (!d || !d.dev) continue;
    put(`io:${d.dev}:read`, d.readMBps);
    put(`io:${d.dev}:write`, d.writeMBps);
    put(`io:${d.dev}:util`, d.utilPct);
    put(`io:${d.dev}:lat`, d.latencyMs);
  }
  if (s.psi) for (const r of ['cpu', 'memory', 'io']) put(`psi:${r}`, s.psi[r]?.some10);
  return out;
}

const bucketStart = (ms, step) => Math.floor(ms / step) * step;

function newAcc(t) { return { t, n: 0, m: new Map() }; }

function addToAcc(acc, flat) {
  acc.n += 1;
  for (const [k, v] of Object.entries(flat)) {
    const cur = acc.m.get(k);
    if (!cur) acc.m.set(k, { min: v, max: v, sum: v, c: 1 });
    else {
      if (v < cur.min) cur.min = v;
      if (v > cur.max) cur.max = v;
      cur.sum += v;
      cur.c += 1;
    }
  }
}

function finishAcc(acc) {
  const m = {};
  for (const [k, a] of acc.m) m[k] = [roundValue(a.min), roundValue(a.max), roundValue(a.sum / a.c)];
  return { t: acc.t, n: acc.n, m };
}

/**
 * Agrupa amostras em baldes de `step` ms alinhados à época. Baldes sem amostra não são
 * emitidos (o buraco fica visível no gráfico). Amostras com `ts` inválido são ignoradas.
 */
export function aggregate(samples, step) {
  const accs = new Map();
  for (const s of samples) {
    const ms = Date.parse(s?.ts);
    if (!Number.isFinite(ms)) continue;
    const t = bucketStart(ms, step);
    let acc = accs.get(t);
    if (!acc) { acc = newAcc(t); accs.set(t, acc); }
    addToAcc(acc, flatten(s));
  }
  return [...accs.values()].sort((a, b) => a.t - b.t).map(finishAcc);
}

/**
 * Junta baldes menores (ex.: rollups de 5 min) em baldes de `step` ms. A média é ponderada
 * pelo número de amostras de cada balde.
 */
export function mergeBuckets(buckets, step) {
  const out = new Map();
  for (const b of buckets) {
    const t = bucketStart(b.t, step);
    let acc = out.get(t);
    if (!acc) { acc = { t, n: 0, m: new Map() }; out.set(t, acc); }
    acc.n += b.n;
    for (const [k, [min, max, avg]] of Object.entries(b.m || {})) {
      const cur = acc.m.get(k);
      if (!cur) acc.m.set(k, { min, max, sum: avg * b.n, c: b.n });
      else {
        if (min < cur.min) cur.min = min;
        if (max > cur.max) cur.max = max;
        cur.sum += avg * b.n;
        cur.c += b.n;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t).map(finishAcc);
}

const maxOf = (list, get) => {
  let best = null;
  for (const x of list) { const v = get(x); if (isNum(v) && (best === null || v > best)) best = v; }
  return best;
};
const minOf = (list, get) => {
  let best = null;
  for (const x of list) { const v = get(x); if (isNum(v) && (best === null || v < best)) best = v; }
  return best;
};
const byKey = (list, field, key) => (list || []).find((x) => x && x[field] === key);

/** Pior caso de um grupo de amostras, no formato de amostra (base: a mais recente). */
export function worstOf(group) {
  const last = group[group.length - 1];
  if (group.length === 1) return last;
  const out = { ...last, bucket: { from: group[0].ts, to: last.ts, n: group.length } };
  if (Array.isArray(last.load)) out.load = last.load.map((_, i) => maxOf(group, (s) => s.load?.[i]));
  if (last.cpu) out.cpu = { ...last.cpu, pct: maxOf(group, (s) => s.cpu?.pct), iowait: maxOf(group, (s) => s.cpu?.iowait) };
  if (last.ram) {
    out.ram = {
      ...last.ram,
      used: maxOf(group, (s) => s.ram?.used),
      swapUsed: maxOf(group, (s) => s.ram?.swapUsed),
      avail: minOf(group, (s) => s.ram?.avail),
      free: minOf(group, (s) => s.ram?.free),
    };
  }
  if ('tempC' in last) out.tempC = maxOf(group, (s) => s.tempC);
  if (last.net) out.net = { ...last.net, rxMbps: maxOf(group, (s) => s.net?.rxMbps), txMbps: maxOf(group, (s) => s.net?.txMbps) };
  if (Array.isArray(last.disks)) {
    out.disks = last.disks.map((d) => {
      const same = (s) => byKey(s.disks, 'mount', d.mount);
      return {
        ...d,
        pct: maxOf(group, (s) => same(s)?.pct),
        usedBytes: maxOf(group, (s) => same(s)?.usedBytes),
        availBytes: minOf(group, (s) => same(s)?.availBytes),
      };
    });
  }
  if (Array.isArray(last.io)) {
    out.io = last.io.map((d) => {
      const same = (s) => byKey(s.io, 'dev', d.dev);
      return {
        ...d,
        readMBps: maxOf(group, (s) => same(s)?.readMBps),
        writeMBps: maxOf(group, (s) => same(s)?.writeMBps),
        utilPct: maxOf(group, (s) => same(s)?.utilPct),
        latencyMs: maxOf(group, (s) => same(s)?.latencyMs),
      };
    });
  }
  return out;
}

/**
 * Reduz a lista para no máximo `maxPoints` pontos sem perder picos (B8): cada ponto é o pior
 * caso do seu grupo, com o `ts` da amostra mais recente do grupo (o último ponto continua
 * sendo a última amostra).
 */
export function downsample(list, maxPoints = 720) {
  if (list.length <= maxPoints) return list;
  const size = Math.ceil(list.length / maxPoints);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(worstOf(list.slice(i, i + size)));
  return out;
}
