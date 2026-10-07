window.Dash = window.Dash || {};

const $ = (id) => document.getElementById(id);

Dash.fmt = {
  bytes(b) {
    if (b === null || b === undefined) return '—';
    if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
    if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
    return `${b} B`;
  },
  uptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  },
  time(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('pt-BR');
  },
  timeDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  },
  pctColor(p) {
    if (p >= 90) return '#E2604F';
    if (p >= 60) return '#D6A23C';
    return '#3FA6A0';
  },
  days(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) return `~${(days / 365).toFixed(1)} ano(s)`;
    if (days >= 30) return `~${(days / 30).toFixed(1)} mês(es)`;
    return `~${days} dia(s)`;
  },
  duration(sec) {
    if (sec === null || sec === undefined) return 'em curso';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  },
  esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },
};

function setBar(el, pct, color) {
  const p = Math.min(Math.max(pct, 0), 100);
  el.style.width = `${p}%`;
  el.style.background = color || Dash.fmt.pctColor(p);
}

/* SMART do disco que contém o ponto de montagem (dev vem da coleta V2; source como reserva) */
function smartOf(sample, mount) {
  const disk = (sample.disks || []).find((d) => d.mount === mount) || {};
  const fromSource = String(disk.source || '').match(/^\/dev\/(nvme\d+n\d+|mmcblk\d+|[a-z]+)/);
  const dev = disk.dev || (fromSource && fromSource[1]);
  const match = dev && (sample.smart || []).find((x) => x.dev === dev);
  return match || {};
}

/* PASSED = ok, FAILED = ruim; sem permissão/desconhecido não é falha do disco */
function smartBadge(status) {
  if (status === 'PASSED') return 'badge-ok';
  if (status === 'FAILED') return 'badge-bad';
  return 'badge-neutral';
}

/* Pisca uma vez o elemento atualizado via SSE (DS §8); noop em testes/headless */
function flash(el) {
  if (!el || !el.classList) return;
  try {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => { try { el.classList.remove('flash'); } catch { /* noop */ } }, 700);
  } catch { /* noop */ }
}

Dash.sections = {
  health(latest) {
    // Saúde calculada no servidor com os limiares do .env; o cálculo local é só reserva.
    const { score, level, parts } = Dash.health || Dash.analysis.healthScore(latest, Dash.alerts.active);
    const color = level === 'ok' ? '#4FA98A' : level === 'warn' ? '#D6A23C' : '#E2604F';
    $('healthRing').style.background = `conic-gradient(${color} ${score * 3.6}deg, var(--bg-surface-2) 0deg)`;
    $('healthScore').textContent = score;
    $('healthScore').style.color = color;
    $('healthNote').textContent = level === 'ok' ? 'saudável' : level === 'warn' ? 'atenção' : 'crítico';
    flash($('healthBox'));
    const hero = $('healthHeroScore');
    if (hero) {
      hero.textContent = score;
      hero.style.color = color;
      const heroNote = $('healthHeroNote');
      if (heroNote) heroNote.textContent = level === 'ok' ? 'saudável' : level === 'warn' ? 'atenção' : 'crítico';
    }
    const el = $('healthBreakdown');
    if (el) {
      el.innerHTML = parts.length
        ? parts.map((p) => `
        <div class="health-part">
          <span>${Dash.fmt.esc(p.label)}</span>
          <span class="pts pts-${p.level}">-${p.pts}</span>
        </div>`).join('')
        : '<div class="stat-row"><span class="k">nenhum problema detectado</span><span class="v pts-ok">✓</span></div>';
    }
  },

  alertBar(active) {
    const el = $('alerts');
    el.innerHTML = '';
    for (const a of active || []) {
      const div = document.createElement('div');
      div.className = `alert alert-${a.level}`;
      div.innerHTML = `<span>${Dash.fmt.esc(a.message)}</span><button class="alert-ack" title="Reconhecer" data-ack="${a.id}">✓</button>`;
      el.appendChild(div);
    }
    el.querySelectorAll('[data-ack]').forEach((btn) => {
      btn.addEventListener('click', () => Dash.api.ackAlert(btn.dataset.ack));
    });
  },

  overview(latest) {
    if (!latest) return;
    $('hostLabel').textContent = latest.host || '—';
    $('osLabel').textContent = latest.os && latest.os.name ? latest.os.name : latest.host || '—';
    $('uptimeValue').textContent = Dash.fmt.uptime(latest.uptimeSec || 0);
    $('bootAt').textContent = `boot: ${Dash.fmt.timeDate(latest.bootAt)}`;
    $('coresValue').textContent = `${latest.cores ?? '—'} núcleo${(latest.cores || 1) > 1 ? 's' : ''}`;
    $('kernelLabel').textContent = latest.os && latest.os.kernel ? `kernel ${latest.os.kernel}` : '—';

    const load = latest.load || [];
    $('load1').textContent = load.length ? load[0].toFixed(2) : '—';
    $('load5').textContent = load.length > 1 ? load[1].toFixed(2) : '—';
    $('load15').textContent = load.length > 2 ? load[2].toFixed(2) : '—';
    const load1 = load.length ? load[0] : 0;
    const loadPct = Math.min(load1 * (100 / (latest.cores || 1)), 100);
    setBar($('loadBar'), loadPct, loadPct >= 90 ? '#E2604F' : '#3FA6A0');
    $('loadNote').textContent = `núcleos: ${latest.cores || 1} · ${load1 >= (latest.cores || 1) ? 'sobrecarga' : 'ok'}`;

    const r = latest.ram;
    if (r) {
      const usedPct = r.total ? (r.used / r.total) * 100 : 0;
      $('ramUsed').textContent = `${r.used} MB`;
      $('ramTotal').textContent = `/ ${r.total} MB`;
      setBar($('ramBar'), usedPct);
      $('ramNote').textContent = `livre: ${r.avail} MB · cache: ${r.cache} MB`;
      const swPct = r.swapTotal ? (r.swapUsed / r.swapTotal) * 100 : 0;
      $('swapUsed').textContent = `${r.swapUsed} MB`;
      $('swapTotal').textContent = `/ ${r.swapTotal} MB`;
      setBar($('swapBar'), swPct);
      $('swapNote').textContent = swPct >= 50 ? 'ATENÇÃO: uso alto' : 'sem pressão';
    }

    if (latest.tempC !== null && latest.tempC !== undefined) {
      $('tempValue').textContent = latest.tempC.toFixed(1);
      setBar($('tempBar'), (latest.tempC / 60) * 100);
      $('tempNote').textContent = latest.tempC >= 60 ? 'ATENÇÃO: acima do limite' : 'limite: 60°C';
    } else {
      $('tempValue').textContent = '—';
    }

    this.renderOverviewDisks(latest);
    this.renderNetBoxes(latest, '', '');
    this.renderServices(latest);
  },

  renderOverviewDisks(latest) {
    const el = $('overviewDisks');
    el.innerHTML = '';
    for (const d of latest.disks || []) {
      const smart = smartOf(latest, d.mount);
      const row = document.createElement('div');
      row.className = 'overview-disk';
      row.title = 'ver detalhes';
      row.innerHTML = `
        <span class="mount">${Dash.fmt.esc(d.mount)}</span>
        <div class="bar"><div class="bar-fill" style="width:${d.pct}%;background:${Dash.fmt.pctColor(d.pct)}"></div></div>
        <span class="pct">${d.pct}%</span>
        <span class="smart"><span class="badge ${smartBadge(smart.status)}">${Dash.fmt.esc(smart.status || '—')}</span></span>`;
      row.addEventListener('click', () => {
        Dash.diskDetailMount = d.mount;
        location.hash = '#/discos';
        Dash.sections.disks(latest);
        Dash.charts.sync();
      });
      el.appendChild(row);
    }
  },

  renderNetBoxes(latest, a, b) {
    const n = latest.net || {};
    $(`rxMbps${a}`).textContent = `${(n.rxMbps || 0).toFixed(2)} Mbps`;
    $(`txMbps${b}`).textContent = `${(n.txMbps || 0).toFixed(2)} Mbps`;
    $(`rxTotal${a}`).textContent = `total: ${Dash.fmt.bytes(n.rxBytes || 0)}`;
    $(`txTotal${b}`).textContent = `total: ${Dash.fmt.bytes(n.txBytes || 0)}`;
  },

  renderServices(latest) {
    const el = $('services');
    el.innerHTML = '';
    for (const [svc, state] of Object.entries(latest.services || {})) {
      const ok = state === 'active';
      const badge = document.createElement('span');
      badge.className = `badge ${ok ? 'badge-ok' : 'badge-bad'}`;
      badge.textContent = `${svc}: ${state}`;
      el.appendChild(badge);
    }
  },

  disks(latest) {
    if (!latest) return;
    const etas = Dash.analysis.diskEta(Dash.samples);
    const etaFor = (mount) => etas.find((e) => e.mount === mount);
    const el = $('diskCards');
    el.innerHTML = '';
    for (const d of latest.disks || []) {
      const smart = smartOf(latest, d.mount);
      const eta = etaFor(d.mount);
      const card = document.createElement('div');
      card.className = `disk-card ${Dash.diskDetailMount === d.mount ? 'selected' : ''}`;
      card.innerHTML = `
        <h3><span>${Dash.fmt.esc(d.mount)}</span><span class="badge ${smartBadge(smart.status)}">${Dash.fmt.esc(smart.status || 'SMART —')}</span></h3>
        <div class="big">${d.pct}%</div>
        <div class="bar"><div class="bar-fill" style="width:${d.pct}%;background:${Dash.fmt.pctColor(d.pct)}"></div></div>
        <div class="meta">${Dash.fmt.esc(d.used)} de ${Dash.fmt.esc(d.size)} · livre ${Dash.fmt.esc(d.avail)}</div>
        ${eta ? `<div class="eta">${eta.daysToFull !== null ? `⚠ Previsão de lotação: <b>${Dash.fmt.days(eta.daysToFull)}</b>` : 'Crescimento estável — sem previsão de lotação'} (${eta.growthPerDayGB >= 0.001 ? `+${eta.growthPerDayGB.toFixed(1)} GB/dia` : '±0 GB/dia'})</div>` : ''}`;
      card.addEventListener('click', () => {
        Dash.diskDetailMount = d.mount;
        document.querySelectorAll('.disk-card').forEach((c) => c.classList.toggle('selected', c === card));
        $('diskDetailMount').textContent = d.mount;
        Dash.charts.sync();
      });
      el.appendChild(card);
    }
    const active = el.querySelector('.disk-card.selected') || el.querySelector('.disk-card');
    if (active) active.click();
  },

  net(latest) {
    if (!latest) return;
    this.renderNetBoxes(latest, '2', '2');
  },

  procs(latest) {
    if (!latest) return;
    const tbody = $('procsTable').querySelector('tbody');
    let list = latest.topProcs || [];
    if (Dash.procsFilter) {
      const f = Dash.procsFilter.toLowerCase();
      list = list.filter((p) => p.cmd.toLowerCase().includes(f) || p.user.toLowerCase().includes(f));
    }
    const { key, dir } = Dash.procsSort;
    list = [...list].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    tbody.innerHTML = '';
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-secondary)">nenhum processo encontrado</td></tr>';
      return;
    }
    for (const p of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="num">${p.pid}</td><td>${Dash.fmt.esc(p.user)}</td><td class="num">${p.cpu.toFixed(1)}</td><td class="num">${p.mem.toFixed(1)}</td><td class="mono">${Dash.fmt.esc(p.cmd)}</td>`;
      tbody.appendChild(tr);
    }
    const heads = $('procsTable').querySelectorAll('th');
    heads.forEach((th) => th.classList.toggle('sortable', !!th.dataset.key));
  },

  alertsView() {
    const filter = Dash.alertFilter || 'active';
    const list = filter === 'active'
      ? Dash.alerts.active
      : Dash.alerts.all.filter((a) => (filter === 'all' ? true : a.level === filter));
    const el = $('alertsList');
    el.innerHTML = '';
    if (!list.length) {
      el.innerHTML = '<div class="empty">Nenhum alerta neste filtro — ajuste o filtro acima ou aguarde a próxima coleta.</div>';
      return;
    }
    for (const a of list) {
      const div = document.createElement('div');
      div.className = `alert-item alert-${a.level === 'critical' ? 'critical' : 'warning'}${a.status === 'resolved' ? ' resolved' : ''}`;
      const icon = a.level === 'critical' ? '●' : '▲';
      div.innerHTML = `
        <span class="alert-level" aria-hidden="true">${icon}</span>
        <span class="badge ${a.level === 'critical' ? 'badge-bad' : 'badge-warn'}">${a.level}</span>
        <span class="alert-msg"><b>${Dash.fmt.esc(a.message)}</b><br><span class="alert-time">${Dash.fmt.timeDate(a.ts)} · ${a.status}${a.resolvedAt ? ` · resolvido em ${Dash.fmt.timeDate(a.resolvedAt)}` : ''}</span></span>
        <span class="alert-actions">
          ${a.status === 'new' ? `<button class="btn-ghost" data-action="ack" data-id="${a.id}">Reconhecer</button>` : ''}
          ${a.status !== 'resolved' ? `<button class="btn-ghost" data-action="resolve" data-id="${a.id}">Resolver</button>` : ''}
        </span>`;
      el.appendChild(div);
    }
    el.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fn = btn.dataset.action === 'ack' ? Dash.api.ackAlert : Dash.api.resolveAlert;
        fn(btn.dataset.id);
      });
    });
  },

  annotationsView() {
    const list = Dash.annotations || [];
    const el = $('annotationsList');
    el.innerHTML = '';
    if (!list.length) {
      el.innerHTML = '<div class="empty">Nenhuma anotação ainda — clique em um ponto de um gráfico e escolha <b>Anotar neste momento</b>, ou use o formulário acima.</div>';
      return;
    }
    for (const a of list) {
      const div = document.createElement('div');
      div.className = 'annotation-item';
      div.innerHTML = `
        <span class="annotation-time">${Dash.fmt.timeDate(a.ts)}</span>
        <span class="annotation-text">${Dash.fmt.esc(a.label || a.text)}</span>
        <button class="btn-ghost" data-del="${a.id}" title="Remover anotação" aria-label="Remover anotação">Remover</button>`;
      el.appendChild(div);
    }
    el.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => Dash.api.deleteAnnotation(btn.dataset.del));
    });
  },

  analysis() {
    const latest = Dash.latest;
    if (!latest) return;
    const health = Dash.health || Dash.analysis.healthScore(latest, Dash.alerts.active);
    const ram = Dash.analysis.ramPressure(Dash.samples);
    const etas = Dash.analysis.diskEta(Dash.samples);
    const daily = Dash.analysis.dailySummary(Dash.samples);
    // Quedas e uptime vêm do registro próprio do servidor (/api/outages), não dos alertas.
    const server = Dash.outages;
    const outages = server ? server.outages : Dash.analysis.outages(Dash.alerts.all);
    const winMs = 2592000000;
    const uptime = server ? server.uptime : Dash.analysis.uptimePct(Dash.alerts.all, winMs);

    const rp = $('ramPressure');
    rp.innerHTML = `
      <div class="stat-row"><span class="k">Média (período)</span><span class="v">${ram.avg !== null ? ram.avg.toFixed(1) + '%' : '—'}</span></div>
      <div class="stat-row"><span class="k">Pico (período)</span><span class="v">${ram.max !== null ? ram.max.toFixed(1) + '%' : '—'}</span></div>
      <div class="stat-row"><span class="k">Tendência (6h)</span><span class="v trend-${ram.trend}">${ram.trend === 'up' ? '▲ subindo' : ram.trend === 'down' ? '▼ caindo' : '— estável'}</span></div>
      <div class="stat-row"><span class="k">Uso atual</span><span class="v">${latest.ram ? ((latest.ram.used / latest.ram.total) * 100).toFixed(1) + '%' : '—'}</span></div>
      <div class="stat-row"><span class="k">Swap</span><span class="v">${latest.ram ? `${latest.ram.swapUsed} / ${latest.ram.swapTotal} MB` : '—'}</span></div>`;

    const et = $('etaTable').querySelector('tbody');
    et.innerHTML = etas.length ? etas.map((e) => `
      <tr>
        <td><b>${Dash.fmt.esc(e.mount)}</b></td>
        <td>${e.usedGB.toFixed(1)} GB de ${e.sizeGB.toFixed(1)} GB (${e.pct}%)</td>
        <td>${e.growthPerDayGB >= 0.001 ? `+${e.growthPerDayGB.toFixed(1)} GB/dia` : 'estável'}</td>
        <td>${e.daysToFull !== null ? `<span class="badge ${e.daysToFull < 90 ? 'badge-warn' : 'badge-neutral'}">${Dash.fmt.days(e.daysToFull)}</span>` : '<span class="badge badge-ok">não estimável</span>'}</td>
        <td>${e.samples}</td>
      </tr>`).join('') : '<tr><td colspan="5" style="color:var(--text-secondary)">precisa de ≥10 amostras no período para estimar</td></tr>';

    const dt = $('dailyTable').querySelector('tbody');
    dt.innerHTML = daily.map((d) => `
      <tr>
        <td><b>${d.day}</b></td>
        <td>${d.load1 ? `${d.load1.min.toFixed(2)} / ${d.load1.max.toFixed(2)} / ${d.load1.avg.toFixed(2)}` : '—'}</td>
        <td>${d.ram ? `${d.ram.min.toFixed(0)} / ${d.ram.max.toFixed(0)} / ${d.ram.avg.toFixed(0)}%` : '—'}</td>
        <td>${d.temp ? `${d.temp.min.toFixed(0)} / ${d.temp.max.toFixed(0)} / ${d.temp.avg.toFixed(0)}°C` : '—'}</td>
        <td>${d.rx ? d.rx.max.toFixed(2) : '—'}</td>
        <td>${d.tx ? d.tx.max.toFixed(2) : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="color:var(--text-secondary)">sem dados no período</td></tr>';

    const ol = $('outagesList');
    ol.innerHTML = outages.length ? outages.map((o) => `
      <div class="outage-row">
        <span>${Dash.fmt.timeDate(o.from)} → ${o.to ? Dash.fmt.timeDate(o.to) : '<b>em curso</b>'}</span>
        <span>${o.to ? `duração ${Dash.fmt.duration(o.durationSec)}` : `<span class="badge badge-bad">offline</span>`}${o.reason ? ` · ${Dash.fmt.esc(o.reason)}` : ''}</span>
      </div>`).join('') : '<div class="stat-row"><span class="k">nenhum outage registrado nos últimos 30 dias</span></div>';
    const uptimeEl = document.createElement('div');
    uptimeEl.className = 'stat-row';
    uptimeEl.innerHTML = `<span class="k">Uptime (últimos 30 dias)</span><span class="v">${typeof uptime.uptimePct === 'number' ? `${uptime.uptimePct.toFixed(2)}%` : '—'}</span>`;
    ol.prepend(uptimeEl);
  },

  history() {
    const samples = Dash.samples.slice(-400).reverse();
    $('historyHint').textContent = `${samples.length} amostras exibidas${samples.length === 400 ? ' (máx)' : ''} · período ${Dash.period}`;
    const tbody = $('historyTable').querySelector('tbody');
    tbody.innerHTML = samples.map((s) => {
      const disks = (s.disks || []).map((d) => `${Dash.fmt.esc(d.mount)} ${d.pct}%`).join(' · ');
      const ramPct = s.ram && s.ram.total ? ((s.ram.used / s.ram.total) * 100).toFixed(0) : '—';
      return `<tr>
        <td class="mono">${Dash.fmt.timeDate(s.ts)}</td>
        <td class="num">${s.load ? s.load[0].toFixed(2) : '—'}</td>
        <td class="num">${ramPct}%</td>
        <td class="num">${s.tempC !== null && s.tempC !== undefined ? s.tempC.toFixed(0) + '°C' : '—'}</td>
        <td class="num">${s.net && typeof s.net.rxMbps === 'number' ? s.net.rxMbps.toFixed(2) : '—'}</td>
        <td class="num">${s.net && typeof s.net.txMbps === 'number' ? s.net.txMbps.toFixed(2) : '—'}</td>
        <td class="mono">${disks}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" style="color:var(--text-secondary)">sem amostras no período</td></tr>';
  },

  ioDevTabs() {
    const el = $('ioTabs');
    el.innerHTML = '';
    const devs = [...new Set((Dash.latest && (Dash.latest.io || []).map((x) => x.dev)) || [])];
    if (!devs.length) return;
    if (!devs.includes(Dash.ioDev)) Dash.ioDev = devs[0];
    for (const dev of devs) {
      const b = document.createElement('button');
      b.textContent = dev;
      b.className = Dash.ioDev === dev ? 'active' : '';
      b.addEventListener('click', () => {
        Dash.ioDev = dev;
        Dash.charts.sync();
        Dash.sections.ioDevTabs();
      });
      el.appendChild(b);
    }
  },

  modal: {
    open(sample) {
      const E = Dash.fmt.esc.bind(Dash.fmt);
      const disks = (sample.disks || []).map((d) => `
        <div class="k">${E(d.mount)}</div>
        <div class="v">${E(d.used)} de ${E(d.size)} · ${d.pct}% <span class="bar" style="display:inline-block;width:60px;vertical-align:middle"><span class="bar-fill" style="width:${d.pct}%;background:${Dash.fmt.pctColor(d.pct)};display:block"></span></span></div>`).join('');
      const procs = (sample.topProcs || []).slice(0, 3).map((p) => `
        <div class="k">PID ${p.pid} · ${E(p.user)}</div>
        <div class="v">${p.cpu.toFixed(1)}% CPU · ${p.mem.toFixed(1)}% MEM · ${E(p.cmd)}</div>`).join('');
      const smart = (sample.smart || []).map((s) => `<span class="badge ${smartBadge(s.status)}">${E(s.dev)}: ${E(s.status)}</span>`).join(' ');
      const services = Object.entries(sample.services || {}).map(([s, st]) => `<span class="badge ${st === 'active' ? 'badge-ok' : 'badge-bad'}">${E(s)}: ${E(st)}</span>`).join(' ');
      $('modalTitle').textContent = `Amostra — ${Dash.fmt.timeDate(sample.ts)}`;
      $('sampleModalBody').innerHTML = `
        <div class="sample-grid">
          <div class="k">Host</div><div class="v">${E(sample.host) || '—'}</div>
          <div class="k">Kernel / OS</div><div class="v">${E(sample.os?.kernel)} · ${E(sample.os?.name)}</div>
          <div class="k">Uptime</div><div class="v">${Dash.fmt.uptime(sample.uptimeSec || 0)} (boot ${Dash.fmt.timeDate(sample.bootAt)})</div>
          <div class="k">Load 1/5/15</div><div class="v">${(sample.load || []).map((l) => l.toFixed(2)).join(' / ') || '—'}</div>
          <div class="k">RAM</div><div class="v">${sample.ram ? `${sample.ram.used} / ${sample.ram.total} MB usada · ${sample.ram.avail} MB livre` : '—'}</div>
          <div class="k">Swap</div><div class="v">${sample.ram ? `${sample.ram.swapUsed} / ${sample.ram.swapTotal} MB` : '—'}</div>
          <div class="k">Temperatura</div><div class="v">${sample.tempC !== null && sample.tempC !== undefined ? sample.tempC.toFixed(1) + '°C' : '—'}</div>
          <div class="k">Rede</div><div class="v">↓ ${(sample.net?.rxMbps || 0).toFixed(2)} Mbps · ↑ ${(sample.net?.txMbps || 0).toFixed(2)} Mbps (${Dash.fmt.bytes(sample.net?.rxBytes)} / ${Dash.fmt.bytes(sample.net?.txBytes)})</div>
          ${disks}
          <div class="k full">I/O</div>
          <div class="v full">${(sample.io || []).map((io) => `${E(io.dev)}: ${(io.readMBps || 0).toFixed(2)} MB/s l · ${(io.writeMBps || 0).toFixed(2)} MB/s e`).join(' &nbsp;·&nbsp; ') || '—'}</div>
          <div class="k full">SMART</div><div class="v full">${smart || '—'}</div>
          <div class="k full">Serviços</div><div class="v full">${services || '—'}</div>
          <div class="k full">Top processos</div><div class="v full">${procs || '—'}</div>
        </div>`;
      this.sample = sample;
      $('modal').hidden = false;
    },
    close() {
      $('modal').hidden = true;
      this.sample = null;
    },
  },
};