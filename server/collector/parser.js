// Interpreta a saída do comando de coleta V2 (./builder.js) e monta a amostra
// schemaVersion 2. Regras:
// - Seção ausente ou ilegível vira null ("sem dado"), nunca zero inventado (invariante I5).
// - Campos usados pelo frontend da V1 são mantidos com o mesmo significado (compatibilidade
//   até a F5/F6); os novos entram ao lado deles.
// - Taxas (CPU %, Mbps, MB/s, % de uso do disco) dependem da amostra anterior e são
//   calculadas em ./rates.js.
import { COLLECTOR_VERSION } from './builder.js';

export const SCHEMA_VERSION = 2;

// Sensores preferidos para "a temperatura da CPU", em ordem.
const CPU_SENSORS = ['x86_pkg_temp', 'coretemp', 'k10temp', 'cpu-thermal', 'cpu_thermal', 'soc_thermal', 'acpitz'];
const SMART_STATES = new Set(['PASSED', 'FAILED', 'SEM_PERMISSAO', 'SEM_SMARTCTL', 'DESCONHECIDO']);

const num = (v) => {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/** Separa a saída em seções { NOME: [linhas] }. Texto antes do 1º marcador é ignorado. */
export function splitSections(stdout) {
  const sections = {};
  let current = null;
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^===([A-Z]+)===$/);
    if (m) {
      current = m[1];
      sections[current] = [];
      continue;
    }
    if (current && line.trim() !== '') sections[current].push(line);
  }
  return sections;
}

/** Formato curto estilo `df -h` (base 1024): 2.5G, 145G, 1.8T. */
export function humanBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  if (i === 0) return `${Math.round(v)}${units[i]}`;
  const shown = v < 10 ? Math.ceil(v * 10) / 10 : Math.ceil(v);
  return `${shown}${units[i]}`;
}

const parsers = {
  VER(lines, s) {
    const [version, hash] = (lines[0] || '').trim().split(/\s+/);
    s.collector.version = int(version);
    s.collector.hash = hash || null;
    s.collector.mode = (lines[1] || '').trim() || null;
  },
  HOST(lines, s) {
    s.host = (lines[0] || '').trim() || null;
  },
  OS(lines, s) {
    s.os = { kernel: (lines[0] || '').trim() || null, name: null };
    const pretty = lines.find((l) => l.startsWith('PRETTY_NAME='));
    const name = lines.find((l) => l.startsWith('NAME='));
    const pick = pretty || name;
    if (pick) s.os.name = pick.slice(pick.indexOf('=') + 1).trim().replace(/^"|"$/g, '') || null;
  },
  CPU(lines, s) {
    const n = int((lines[0] || '').trim());
    s.cores = n && n > 0 ? n : null;
  },
  UPTIME(lines, s) {
    const sec = num((lines[0] || '').trim().split(/\s+/)[0]);
    if (sec !== null && sec >= 0) {
      s.uptimeSec = sec;
      s.bootAt = new Date(Date.parse(s.ts) - sec * 1000).toISOString();
    }
  },
  LOAD(lines, s) {
    const parts = (lines[0] || '').trim().split(/\s+/).slice(0, 3).map(num);
    s.load = parts.length === 3 && parts.every((v) => v !== null) ? parts : null;
  },
  STAT(lines, s) {
    const parts = (lines[0] || '').trim().split(/\s+/);
    if (parts[0] !== 'cpu' || parts.length < 5) return;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts.slice(1).map((v) => int(v) ?? 0);
    s.cpuTicks = { user, nice, system, idle, iowait, irq, softirq, steal, total: user + nice + system + idle + iowait + irq + softirq + steal };
  },
  MEM(lines, s) {
    const kb = {};
    for (const line of lines) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) kb[m[1]] = Number(m[2]);
    }
    if (!kb.MemTotal) return;
    const mb = (v) => (v === undefined ? null : Math.round(v / 1024));
    const avail = kb.MemAvailable ?? kb.MemFree;
    const cache = (kb.Buffers || 0) + (kb.Cached || 0) + (kb.SReclaimable || 0);
    s.ram = {
      total: mb(kb.MemTotal),
      used: mb(kb.MemTotal - avail),
      free: mb(kb.MemFree),
      cache: mb(cache),
      avail: mb(avail),
      swapTotal: mb(kb.SwapTotal ?? 0),
      swapUsed: mb((kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0)),
      dirty: mb(kb.Dirty),
      writeback: mb(kb.Writeback),
    };
  },
  DF(lines, s, ctx) {
    const seen = new Set();
    s.disks = [];
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p[0] === 'Filesystem' || p.length < 7) continue;
      const [source, mount, size, used, avail, pcent, ipcent] = p;
      if (seen.has(mount)) continue;
      seen.add(mount);
      const sizeBytes = int(size);
      const usedBytes = int(used);
      const availBytes = int(avail);
      const devMatch = source.match(/^\/dev\/([a-z]+)(?:\d+)?$/) || source.match(/^\/dev\/(nvme\d+n\d+|mmcblk\d+)(?:p\d+)?$/);
      s.disks.push({
        mount,
        source,
        dev: devMatch ? devMatch[1] : null,
        size: humanBytes(sizeBytes),
        used: humanBytes(usedBytes),
        avail: humanBytes(availBytes),
        pct: int(pcent),
        sizeBytes,
        usedBytes,
        availBytes,
        inodesPct: int(ipcent),
      });
    }
    const wanted = ctx.targets?.mounts || [];
    s.missingMounts = wanted.filter((m) => !seen.has(m));
  },
  NET(lines, s, ctx) {
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const iface = line.slice(0, colon).trim();
      if (ctx.targets?.netIf && iface !== ctx.targets.netIf) continue;
      const f = line.slice(colon + 1).trim().split(/\s+/).map((v) => int(v));
      if (f.length < 16 || f.some((v) => v === null)) continue;
      s.net = {
        iface,
        rxBytes: f[0], rxErrors: f[2], rxDrops: f[3],
        txBytes: f[8], txErrors: f[10], txDrops: f[11],
        rxMbps: null, txMbps: null,
      };
      return;
    }
  },
  IO(lines, s, ctx) {
    const devs = new Set(ctx.targets?.devs || []);
    s.io = [];
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 14) continue;
      const dev = p[2];
      if (devs.size && !devs.has(dev)) continue;
      const v = p.map((x) => int(x));
      s.io.push({
        dev,
        readIos: v[3], sectorsRead: v[5], readTicksMs: v[6],
        writeIos: v[7], sectorsWrite: v[9], writeTicksMs: v[10],
        ioTicksMs: v[12],
        readMBps: null, writeMBps: null, utilPct: null, latencyMs: null,
      });
    }
  },
  PSI(lines, s) {
    const psi = {};
    for (const line of lines) {
      const [kind] = line.trim().split(/\s+/);
      const some = line.match(/some avg10=([\d.]+) avg60=([\d.]+)/);
      const full = line.match(/full avg10=([\d.]+) avg60=([\d.]+)/);
      if (!some) continue;
      psi[kind] = {
        some10: num(some[1]), some60: num(some[2]),
        full10: full ? num(full[1]) : null, full60: full ? num(full[2]) : null,
      };
    }
    s.psi = Object.keys(psi).length ? psi : null;
  },
  TEMP(lines, s) {
    const temps = [];
    for (const line of lines) {
      const [type, raw] = line.trim().split(/\s+/);
      const milli = num(raw);
      if (!type || milli === null || milli <= 0) continue;
      temps.push({ type, c: Math.round(milli / 100) / 10 });
    }
    s.temps = temps;
    const chosen = CPU_SENSORS.map((name) => temps.find((t) => t.type === name)).find(Boolean)
      || (temps.length ? temps.reduce((a, b) => (b.c > a.c ? b : a)) : null);
    s.tempC = chosen ? chosen.c : null;
    s.tempSensor = chosen ? chosen.type : null;
  },
  SMART(lines, s) {
    if (lines.length === 1 && lines[0].trim() === 'pulado') return;
    s.smart = [];
    for (const line of lines) {
      const [dev, status] = line.trim().split(/\s+/);
      if (!dev) continue;
      s.smart.push({ dev, status: SMART_STATES.has(status) ? status : 'DESCONHECIDO' });
    }
    s.smartAt = s.ts;
  },
  SERVICES(lines, s) {
    s.services = {};
    for (const line of lines) {
      const [name, state] = line.trim().split(/\s+/);
      if (name) s.services[name] = state || 'desconhecido';
    }
  },
  PS(lines, s) {
    s.topProcs = [];
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p[0] === 'USER' || p.length < 7) continue;
      const cmd = p.slice(6).join(' ');
      if (/^ps -eo /.test(cmd)) continue;
      s.topProcs.push({
        user: p[0],
        pid: int(p[1]),
        cpu: num(p[2]) ?? 0,
        mem: num(p[3]) ?? 0,
        rssKB: int(p[4]),
        etimesSec: int(p[5]),
        cmd,
      });
      if (s.topProcs.length >= 8) break;
    }
  },
};

/**
 * @param {string} stdout saída bruta do comando de coleta
 * @param {string} ts timestamp ISO da coleta
 * @param {{ targets?: object }} [ctx] alvos normalizados (para filtrar NET/IO e conferir mounts)
 */
export function parseOutput(stdout, ts, ctx = {}) {
  const sample = {
    schemaVersion: SCHEMA_VERSION,
    ts,
    collector: { version: null, hash: null, mode: null, complete: false, expectedVersion: COLLECTOR_VERSION },
    host: null,
    os: { kernel: null, name: null },
    cores: null,
    uptimeSec: null,
    bootAt: null,
    load: null,
    cpuTicks: null,
    cpu: null,
    ram: null,
    disks: [],
    missingMounts: [],
    net: null,
    io: [],
    psi: null,
    temps: [],
    tempC: null,
    tempSensor: null,
    smart: null,
    smartAt: null,
    services: {},
    topProcs: [],
  };
  const sections = splitSections(stdout);
  for (const [name, lines] of Object.entries(sections)) {
    const fn = parsers[name];
    if (!fn) continue;
    try {
      fn(lines, sample, ctx);
    } catch {
      // Seção malformada não derruba a amostra: fica como "sem dado".
    }
  }
  sample.collector.complete = 'FIM' in sections;
  return sample;
}
