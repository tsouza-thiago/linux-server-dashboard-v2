// Taxas que dependem da amostra anterior: CPU %, Mbps da rede, MB/s, % de uso e latência
// dos discos. Sem anterior, com reinício do servidor no meio (contadores zerados) ou com
// contador que andou para trás, a taxa fica null ("sem dado"), nunca 0 inventado.

const round = (v, digits = 2) => (v === null ? null : Number(v.toFixed(digits)));

function elapsedSec(sample, prev) {
  if (!prev || !prev.ts) return null;
  const sec = (Date.parse(sample.ts) - Date.parse(prev.ts)) / 1000;
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

function rebooted(sample, prev) {
  return sample.uptimeSec !== null && prev.uptimeSec !== null && prev.uptimeSec !== undefined
    && sample.uptimeSec < prev.uptimeSec;
}

const delta = (cur, old) => (cur === null || old === null || old === undefined || cur < old ? null : cur - old);

export function computeCpu(sample, prev) {
  const cur = sample.cpuTicks;
  const old = prev && prev.cpuTicks;
  if (!cur || !old || rebooted(sample, prev)) return null;
  const total = delta(cur.total, old.total);
  if (!total) return null;
  const part = (k) => (delta(cur[k], old[k]) ?? 0) / total * 100;
  const idle = part('idle');
  const iowait = part('iowait');
  return {
    pct: round(100 - idle - iowait, 1),
    user: round(part('user') + part('nice'), 1),
    system: round(part('system') + part('irq') + part('softirq'), 1),
    iowait: round(iowait, 1),
    steal: round(part('steal'), 1),
  };
}

export function computeNet(sample, prev) {
  const sec = elapsedSec(sample, prev);
  if (!sample.net || !prev || !prev.net || !sec || rebooted(sample, prev)) return;
  if (prev.net.iface && sample.net.iface && prev.net.iface !== sample.net.iface) return;
  const rx = delta(sample.net.rxBytes, prev.net.rxBytes);
  const tx = delta(sample.net.txBytes, prev.net.txBytes);
  sample.net.rxMbps = rx === null ? null : round(rx * 8 / sec / 1e6);
  sample.net.txMbps = tx === null ? null : round(tx * 8 / sec / 1e6);
}

export function computeIo(sample, prev) {
  const sec = elapsedSec(sample, prev);
  if (!sec || !prev || !Array.isArray(prev.io) || rebooted(sample, prev)) return;
  for (const cur of sample.io) {
    const old = prev.io.find((p) => p.dev === cur.dev);
    if (!old) continue;
    const rd = delta(cur.sectorsRead, old.sectorsRead);
    const wr = delta(cur.sectorsWrite, old.sectorsWrite);
    const ticks = delta(cur.ioTicksMs, old.ioTicksMs);
    const ios = (delta(cur.readIos, old.readIos) ?? 0) + (delta(cur.writeIos, old.writeIos) ?? 0);
    const waitMs = (delta(cur.readTicksMs, old.readTicksMs) ?? 0) + (delta(cur.writeTicksMs, old.writeTicksMs) ?? 0);
    cur.readMBps = rd === null ? null : round(rd * 512 / sec / 1e6);
    cur.writeMBps = wr === null ? null : round(wr * 512 / sec / 1e6);
    cur.utilPct = ticks === null ? null : round(Math.min(100, ticks / (sec * 1000) * 100), 1);
    cur.latencyMs = ios > 0 ? round(waitMs / ios, 1) : null;
  }
}

/** Preenche todas as taxas da amostra (muta `sample`). */
export function computeRates(sample, prev) {
  sample.cpu = computeCpu(sample, prev);
  computeNet(sample, prev);
  computeIo(sample, prev);
  return sample;
}
