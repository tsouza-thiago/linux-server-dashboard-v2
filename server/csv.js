export function csvEscape(value) {
  const s = String(value ?? '');
  const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCSV(samples) {
  const mounts = [...new Set(samples.flatMap((s) => (s.disks || []).map((d) => d.mount)))];
  // 1 par de colunas por dispositivo de I/O, como os discos (B4: antes as colunas eram
  // repetidas por linha e o cabeçalho só tinha um par)
  const devs = [...new Set(samples.flatMap((s) => (s.io || []).map((d) => d.dev)))].filter(Boolean);
  const colKey = (v) => String(v).replace(/[^a-zA-Z0-9]/g, '_');
  const headers = [
    'ts', 'host', 'uptimeSec', 'cores', 'kernel', 'load1', 'load5', 'load15',
    'ramTotalMB', 'ramUsedMB', 'ramAvailMB', 'swapTotalMB', 'swapUsedMB',
    'tempC', 'rxMbps', 'txMbps',
    ...mounts.flatMap((m) => {
      const k = colKey(m);
      return [`disk_${k}_pct`, `disk_${k}_usedGB`, `disk_${k}_availGB`];
    }),
    ...devs.flatMap((d) => [`io_${colKey(d)}_readMBps`, `io_${colKey(d)}_writeMBps`]),
  ];
  const lines = [headers.join(',')];
  for (const s of samples) {
    const row = [
      s.ts, s.host, s.uptimeSec, s.cores ?? '', s.os?.kernel ?? '',
      s.load?.[0], s.load?.[1], s.load?.[2],
      s.ram?.total ?? '', s.ram?.used ?? '', s.ram?.avail ?? '',
      s.ram?.swapTotal ?? '', s.ram?.swapUsed ?? '',
      s.tempC ?? '', s.net?.rxMbps ?? '', s.net?.txMbps ?? '',
    ];
    for (const m of mounts) {
      const d = (s.disks || []).find((x) => x.mount === m) || {};
      row.push(d.pct ?? '', d.usedBytes ? (d.usedBytes / 1e9).toFixed(2) : '', d.availBytes ? (d.availBytes / 1e9).toFixed(2) : '');
    }
    for (const dev of devs) {
      const io = (s.io || []).find((x) => x.dev === dev) || {};
      row.push(io.readMBps ?? '', io.writeMBps ?? '');
    }
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\n');
}