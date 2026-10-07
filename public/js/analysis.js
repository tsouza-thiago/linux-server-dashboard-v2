window.Dash = window.Dash || {};

Dash.analysis = {
  healthScore(latest, activeAlerts) {
    const parts = [];
    let score = 100;
    const add = (label, pts, level) => {
      score = Math.max(0, score - pts);
      parts.push({ label, pts, level: level || 'ok' });
    };
    const offline = (activeAlerts || []).some((a) => a.message.startsWith('Servidor inacessível'));
    if (offline) {
      add('Servidor offline', 100, 'bad');
      return { score: 0, parts, level: 'bad' };
    }
    if (!latest) {
      add('Sem dados', 100, 'bad');
      return { score: 0, parts, level: 'bad' };
    }
    const cores = latest.cores || 1;
    const load1 = latest.load ? latest.load[0] : 0;
    if (load1 > cores * 1.5) add(`Load ${load1.toFixed(2)} alto (${cores} núcleo${cores > 1 ? 's' : ''})`, 10, 'warn');
    if (latest.ram && latest.ram.total) {
      const pct = (latest.ram.used / latest.ram.total) * 100;
      if (pct >= 90) add(`RAM ${pct.toFixed(0)}%`, 15, 'warn');
      else if (pct >= 75) add(`RAM ${pct.toFixed(0)}%`, 5, 'warn');
    }
    if (latest.tempC !== null && latest.tempC !== undefined) {
      if (latest.tempC >= 70) add(`Temp ${latest.tempC.toFixed(1)}°C`, 25, 'bad');
      else if (latest.tempC >= 60) add(`Temp ${latest.tempC.toFixed(1)}°C`, 15, 'warn');
    }
    for (const d of latest.disks || []) {
      if (d.pct >= 90) add(`Disco ${d.mount} ${d.pct}%`, 15, 'warn');
      else if (d.pct >= 80) add(`Disco ${d.mount} ${d.pct}%`, 5, 'warn');
    }
    for (const s of latest.smart || []) {
      if (s.status === 'FAILED') add(`SMART /dev/${s.dev}`, 40, 'bad');
    }
    for (const [svc, st] of Object.entries(latest.services || {})) {
      if (st !== 'active') add(`Serviço ${svc} ${st}`, 25, 'bad');
    }
    const level = score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad';
    return { score, parts, level };
  },

  diskEta(samples) {
    const byMount = {};
    for (const s of samples) {
      for (const d of s.disks || []) {
        if (!d.usedBytes && !d.sizeBytes) continue;
        (byMount[d.mount] = byMount[d.mount] || []).push({
          ts: Date.parse(s.ts), used: d.usedBytes, size: d.sizeBytes, pct: d.pct,
        });
      }
    }
    const out = [];
    for (const [mount, pts] of Object.entries(byMount)) {
      if (pts.length < 10) continue;
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (const p of pts) { sx += p.ts; sy += p.used; sxy += p.ts * p.used; sxx += p.ts * p.ts; }
      const n = pts.length;
      const denom = n * sxx - sx * sx;
      const slope = denom ? (n * sxy - sx * sy) / denom : 0;
      const last = pts[pts.length - 1];
      const growthPerDayGB = (slope * 86400000) / 1e9;
      const daysToFull = slope > 0 ? Math.floor((last.size - last.used) / (slope * 86400000)) : null;
      out.push({
        mount,
        pct: last.pct,
        usedGB: last.used / 1e9,
        sizeGB: last.size / 1e9,
        growthPerDayGB,
        daysToFull,
        samples: n,
      });
    }
    return out.sort((a, b) => (a.daysToFull ?? Infinity) - (b.daysToFull ?? Infinity));
  },

  ramPressure(samples) {
    const pts = samples
      .map((s) => (s.ram && s.ram.total ? (s.ram.used / s.ram.total) * 100 : null))
      .filter((v) => v !== null);
    if (!pts.length) return { avg: null, max: null, trend: 'flat' };
    const avg = pts.reduce((a, b) => a + b, 0) / pts.length;
    const max = Math.max(...pts);
    const third = Math.max(1, Math.floor(pts.length / 3));
    const first = pts.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const lastP = pts.slice(-third).reduce((a, b) => a + b, 0) / third;
    const diff = lastP - first;
    return {
      avg, max, first, lastP,
      trend: diff > 3 ? 'up' : diff < -3 ? 'down' : 'flat',
    };
  },

  outages(alerts) {
    const off = alerts.filter((a) => a.message.startsWith('Servidor inacessível'));
    return off.map((a) => ({
      from: a.ts,
      to: a.resolvedAt || null,
      durationSec: a.resolvedAt ? (Date.parse(a.resolvedAt) - Date.parse(a.ts)) / 1000 : null,
      status: a.status,
    }));
  },

  uptimePct(alerts, windowMs) {
    const periods = this.outages(alerts);
    let offlineMs = 0;
    const now = Date.now();
    for (const p of periods) {
      const from = Math.max(Date.parse(p.from), now - windowMs);
      const to = p.to ? Math.min(Date.parse(p.to), now) : now;
      if (to > from) offlineMs += to - from;
    }
    return { uptimePct: Math.max(0, 100 - (offlineMs / windowMs) * 100), offlineMs };
  },

  dailySummary(samples) {
    const days = {};
    for (const s of samples) {
      const day = s.ts.slice(0, 10);
      const d = days[day] || (days[day] = { day, load1: [], ram: [], temp: [], rx: [], tx: [] });
      d.load1.push(s.load ? s.load[0] : 0);
      if (s.ram && s.ram.total) d.ram.push((s.ram.used / s.ram.total) * 100);
      if (s.tempC !== null && s.tempC !== undefined) d.temp.push(s.tempC);
      if (s.net) { d.rx.push(s.net.rxMbps || 0); d.tx.push(s.net.txMbps || 0); }
    }
    const agg = (arr) => (arr.length
      ? { min: Math.min(...arr), max: Math.max(...arr), avg: arr.reduce((a, b) => a + b, 0) / arr.length }
      : null);
    return Object.values(days)
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((d) => ({ day: d.day, load1: agg(d.load1), ram: agg(d.ram), temp: agg(d.temp), rx: agg(d.rx), tx: agg(d.tx) }));
  },
};