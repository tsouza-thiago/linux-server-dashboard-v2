import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, isPlaceholderHost, sanitizeToken } from './config.js';

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

export const NET_IF = config.NET_IF;
export const DISK_MOUNTS = config.DISK_MOUNTS;
export const DISK_DEVS = config.DISK_DEVS;
export const SERVICES = config.SERVICES;
export const DEV_SET = new Set(DISK_DEVS);
export const SVC_ORDER = SERVICES;

export function buildCommand(overrides = {}) {
  const netIfRaw = overrides.netIf ?? NET_IF;
  const netIf = netIfRaw ? sanitizeToken(String(netIfRaw))[0] || '' : '';
  const mounts = overrides.diskMounts ?? DISK_MOUNTS;
  const devs = overrides.diskDevs ?? DISK_DEVS;
  const svcs = overrides.services ?? SERVICES;
  const parts = [
    "echo '===HOST==='; hostname",
    "echo '===OS==='; uname -r; head -2 /etc/os-release 2>/dev/null",
    "echo '===CPU==='; getconf _NPROCESSORS_ONLN 2>/dev/null",
    "echo '===UPTIME==='; cat /proc/uptime",
    "echo '===LOAD==='; cat /proc/loadavg",
    "echo '===FREE==='; LC_ALL=C free -m",
    `echo '===DF==='; LC_ALL=C df -h --output=target,size,used,avail,pcent ${mounts.join(' ')} 2>/dev/null`,
    `echo '===DFB==='; LC_ALL=C df -B1 --output=target,size,used,avail,pcent ${mounts.join(' ')} 2>/dev/null`,
  ];
  if (netIf) parts.push(`echo '===NET==='; cat /proc/net/dev | grep ${netIf}`);
  if (devs.length) {
    const awkCond = devs.map((d) => `$3=="${d}"`).join('||');
    const loop = devs.map((d) => `printf '%s:' "${d}"; smartctl -H /dev/${d} 2>/dev/null | grep -oE 'PASSED|FAILED' | head -1`).join('; ');
    parts.push(`echo '===IO==='; cat /proc/diskstats | awk '${awkCond}'`);
    parts.push(`echo '===SMART==='; ${loop}`);
  }
  parts.push(
    "echo '===TEMP==='; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null",
  );
  if (svcs.length) parts.push(`echo '===SERVICES==='; LC_ALL=C systemctl is-active ${svcs.join(' ')}`);
  parts.push("echo '===PS==='; LC_ALL=C ps aux --sort=-%mem | head -8");
  return parts.join('; ');
}

function runSSH(host, timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (!host || host.startsWith('-')) {
      return resolve({ stdout: '', stderr: '', code: 255, timedOut: false, error: 'host inválido' });
    }
    const child = spawn('ssh', [...SSH_OPTS, host, buildCommand()], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: -1, timedOut, error: err.message });
    });
  });
}

/**
 * Interpreta a saída do comando SSH único e monta a amostra JSON.
 * @param {string} stdout saída bruta do SSH (seções `===X===`)
 * @param {string} ts timestamp ISO da coleta
 * @param {object} [opts] overrides p/ isolamento de ambiente nos testes
 * @param {string[]} [opts.svcOrder] ordem dos serviços (default: SVC_ORDER do .env/SERVICES)
 * @param {Set<string>} [opts.devSet] dispositivos de IO aceitos (default: DEV_SET do .env/DISK_DEVS)
 * `collect()` usa o default (config global); testes passam valores explícitos
 * (mesmo padrão de `buildCommand(overrides)`).
 */
export function parseOutput(stdout, ts, opts = {}) {
  const svcOrder = opts.svcOrder ?? SVC_ORDER;
  const devSet = opts.devSet ?? DEV_SET;
  const sample = {
    ts,
    host: '',
    os: { kernel: '', name: '' },
    cores: null,
    uptimeSec: 0,
    bootAt: ts,
    load: [0, 0, 0],
    ram: null,
    disks: [],
    net: { rxBytes: 0, txBytes: 0, rxMbps: 0, txMbps: 0 },
    io: [],
    tempC: null,
    smart: [],
    services: {},
    topProcs: [],
  };

  let section = '';
  let svcIdx = 0;
  let osLine = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^===(.+?)===$/);
    if (m) { section = m[1].trim(); continue; }
    if (!line.trim()) continue;

    switch (section) {
      case 'HOST':
        sample.host = line.trim();
        break;
      case 'OS':
        if (osLine === 0) sample.os.kernel = line.trim();
        else {
          const m2 = line.match(/^(PRETTY_NAME|NAME)="?([^"]*)"?/);
          if (m2 && !sample.os.name) sample.os.name = m2[2].trim();
        }
        osLine++;
        break;
      case 'CPU': {
        const n = parseInt(line.trim(), 10);
        if (Number.isFinite(n) && n > 0) sample.cores = n;
        break;
      }
      case 'UPTIME': {
        const sec = parseFloat(line.trim().split(/\s+/)[0]);
        if (Number.isFinite(sec)) {
          sample.uptimeSec = sec;
          sample.bootAt = new Date(Date.parse(ts) - sec * 1000).toISOString();
        }
        break;
      }
      case 'LOAD': {
        const parts = line.trim().split(/\s+/);
        sample.load = parts.slice(0, 3).map((v) => parseFloat(v.replace(',', '.')) || 0);
        break;
      }
      case 'FREE': {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'Mem:') {
          sample.ram = {
            total: +parts[1], used: +parts[2], free: +parts[3],
            cache: +parts[5], avail: +parts[6], swapTotal: 0, swapUsed: 0,
          };
        } else if (parts[0] === 'Swap:' && sample.ram) {
          sample.ram.swapTotal = +parts[1];
          sample.ram.swapUsed = +parts[2];
        }
        break;
      }
      case 'DF':
      case 'DFB': {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'Filesystem' || parts[1] === 'on' || parts[1] === 'Size') break;
        if (parts.length >= 5) {
          const mount = parts[0];
          let disk = sample.disks.find((d) => d.mount === mount);
          if (section === 'DF') {
            disk = {
              mount,
              size: parts[1],
              used: parts[2],
              avail: parts[3],
              pct: parseInt(parts[4], 10) || 0,
              sizeBytes: 0, usedBytes: 0, availBytes: 0,
            };
            sample.disks.push(disk);
          } else if (disk) {
            disk.sizeBytes = parseInt(parts[1], 10) || 0;
            disk.usedBytes = parseInt(parts[2], 10) || 0;
            disk.availBytes = parseInt(parts[3], 10) || 0;
          }
        }
        break;
      }
      case 'NET': {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10 && parts[0].endsWith(':')) {
          sample.net.rxBytes = parseInt(parts[1], 10) || 0;
          sample.net.txBytes = parseInt(parts[9], 10) || 0;
        }
        break;
      }
      case 'IO': {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 11 && (devSet.size === 0 || devSet.has(parts[2]))) {
          sample.io.push({
            dev: parts[2],
            sectorsRead: parseInt(parts[5], 10) || 0,
            sectorsWrite: parseInt(parts[9], 10) || 0,
          });
        }
        break;
      }
      case 'TEMP': {
        const v = parseFloat(line.trim());
        if (Number.isFinite(v) && v > 0) sample.tempC = v / 1000;
        break;
      }
      case 'SMART': {
        const [dev, status] = line.split(':');
        if (dev && status) sample.smart.push({ dev, status: status.trim() });
        break;
      }
      case 'SERVICES': {
        if (svcIdx < svcOrder.length) {
          sample.services[svcOrder[svcIdx++]] = line.trim();
        }
        break;
      }
      case 'PS': {
        if (line.startsWith('USER')) break;
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10) {
          sample.topProcs.push({
            user: parts[0],
            pid: parseInt(parts[1], 10),
            cpu: parseFloat(parts[2]) || 0,
            mem: parseFloat(parts[3]) || 0,
            cmd: parts.slice(10).join(' '),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return sample;
}

export function computeNetRates(sample, prev) {
  if (!prev || !prev.net) return;
  const deltaSec = (Date.parse(sample.ts) - Date.parse(prev.ts)) / 1000;
  if (deltaSec <= 0) return;
  const rx = Math.max(0, sample.net.rxBytes - prev.net.rxBytes);
  const tx = Math.max(0, sample.net.txBytes - prev.net.txBytes);
  sample.net.rxMbps = +(rx * 8 / deltaSec / 1e6).toFixed(2);
  sample.net.txMbps = +(tx * 8 / deltaSec / 1e6).toFixed(2);
}

export function computeIoRates(sample, prev) {
  if (!prev || !prev.io || !prev.io.length) return;
  const deltaSec = (Date.parse(sample.ts) - Date.parse(prev.ts)) / 1000;
  if (deltaSec <= 0) return;
  for (const cur of sample.io) {
    const old = prev.io.find((p) => p.dev === cur.dev);
    if (!old) continue;
    const r = Math.max(0, cur.sectorsRead - old.sectorsRead) * 512 / deltaSec / 1e6;
    const w = Math.max(0, cur.sectorsWrite - old.sectorsWrite) * 512 / deltaSec / 1e6;
    cur.readMBps = +r.toFixed(2);
    cur.writeMBps = +w.toFixed(2);
  }
}

export function describeError({ code, error, stderr, timedOut }) {
  if (timedOut) return 'timeout — servidor não respondeu (rede/servidor fora do ar?)';
  if (error) return error;
  if (stderr && /Host key verification/i.test(stderr)) {
    return 'chave do servidor não autorizada — rode ./install.sh para autorizar';
  }
  if (code === 255) return 'SSH falhou (exit 255) — host não encontrado ou chave inválida';
  if (code !== null) return `SSH falhou (exit ${code})`;
  return 'sem resposta';
}

export function computeAlerts(sample) {
  const alerts = [];
  if (sample.disks) {
    for (const d of sample.disks) {
      if (d.pct >= 90) {
        alerts.push({ level: 'warning', message: `Disco ${d.mount} com ${d.pct}% usado` });
      }
    }
  }
  if (sample.ram && sample.ram.total > 0) {
    const pct = (sample.ram.used / sample.ram.total) * 100;
    if (pct >= 90) {
      alerts.push({ level: 'warning', message: `RAM usada em ${pct.toFixed(0)}%` });
    }
  }
  if (sample.tempC !== null && sample.tempC >= 60) {
    alerts.push({ level: 'warning', message: `Temperatura CPU ${sample.tempC.toFixed(1)}°C` });
  }
  if (sample.smart) {
    for (const s of sample.smart) {
      if (s.status !== 'PASSED') {
        alerts.push({ level: 'critical', message: `SMART /dev/${s.dev}: ${s.status}` });
      }
    }
  }
  for (const [svc, state] of Object.entries(sample.services)) {
    if (state !== 'active') {
      alerts.push({ level: 'critical', message: `Serviço ${svc} ${state}` });
    }
  }
  return alerts;
}

export async function collect({ host, prev, runner = runSSH }) {
  const ts = new Date().toISOString();
  const { stdout, stderr, code, timedOut, error } = await runner(host);
  if (code !== 0 || !stdout || !stdout.includes('===HOST===')) {
    const detail = describeError({ code, error, stderr, timedOut });
    return { ok: false, error: detail, ts };
  }
  const sample = parseOutput(stdout, ts);
  computeNetRates(sample, prev);
  computeIoRates(sample, prev);
  const alerts = computeAlerts(sample);
  return { ok: true, sample, alerts };
}

const isCLI = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCLI) {
  const host = config.SSH_HOST;
  if (isPlaceholderHost(host)) {
    console.error('ERRO: SSH_HOST não configurado. Rode ./install.sh ou edite o .env.');
    process.exit(1);
  }
  const res = await collect({ host, prev: null });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}