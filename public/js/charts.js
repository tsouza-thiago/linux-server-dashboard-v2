window.Dash = window.Dash || {};

Chart.register(ChartZoom, window['chartjs-plugin-annotation']);

Dash.charts = {
  charts: {},
  specs: {},

  /* Paleta DS §2/§6 por tema (contraste AA em ambos); lida ao vivo p/ retheme */
  get COLORS() { return this.palette(); },

  palette() {
    try {
      if (document.documentElement.dataset.theme === 'light') {
        return ['#237A73', '#9A5D14', '#257A5C', '#C7402C', '#5F6B78', '#7E8DA6'];
      }
    } catch { /* noop */ }
    return ['#3FA6A0', '#D68A3C', '#4FA98A', '#E2604F', '#9AA4B2', '#7E8DA6'];
  },

  textColor() {
    try {
      return document.documentElement.dataset.theme === 'light' ? '#565F6B' : '#9AA4B2';
    } catch { return '#9AA4B2'; }
  },

  faintColor() {
    try {
      return document.documentElement.dataset.theme === 'light' ? '#838C97' : '#6B7684';
    } catch { return '#6B7684'; }
  },

  gridColor() {
    /* --border-hairline a 40% (DS §6) */
    try {
      return document.documentElement.dataset.theme === 'light' ? 'rgba(220,225,230,0.4)' : 'rgba(43,49,59,0.4)';
    } catch { return 'rgba(43,49,59,0.4)'; }
  },

  tooltipStyle() {
    try {
      if (document.documentElement.dataset.theme === 'light') {
        return { backgroundColor: '#FFFFFF', borderColor: '#DCE1E6', titleColor: '#1B1F24', bodyColor: '#565F6B' };
      }
    } catch { /* noop */ }
    return { backgroundColor: '#181C22', borderColor: '#2B313B', titleColor: '#E7EAEE', bodyColor: '#9AA4B2' };
  },

  labels(samples) {
    return samples.map((s) => new Date(s.ts).toLocaleTimeString('pt-BR', { hour12: false }));
  },

  series(samples, fn) {
    return samples.map((s) => {
      const v = fn(s);
      return v === null || v === undefined ? null : v;
    });
  },

  registerSpecs() {
    const self = this;
    this.specs = {
      load: {
        canvas: 'chartLoad',
        fn: (samples) => ({
          labels: this.labels(samples),
          datasets: [
            { label: '1 min', data: this.series(samples, (s) => s.load?.[0]), color: self.COLORS[0] },
            { label: '5 min', data: this.series(samples, (s) => s.load?.[1]), color: self.COLORS[1] },
            { label: '15 min', data: this.series(samples, (s) => s.load?.[2]), color: self.COLORS[2] },
          ],
        }),
      },
      ram: {
        canvas: 'chartRam',
        fn: (samples) => ({
          labels: this.labels(samples),
          datasets: [{
            label: 'RAM %',
            data: this.series(samples, (s) => (s.ram && s.ram.total ? +((s.ram.used / s.ram.total) * 100).toFixed(1) : null)),
            color: self.COLORS[1],
            fill: true,
          }],
        }),
      },
      temp: {
        canvas: 'chartTemp',
        fn: (samples) => ({
          labels: this.labels(samples),
          datasets: [{
            label: 'CPU °C',
            data: this.series(samples, (s) => s.tempC ?? null),
            color: self.COLORS[0],
          }],
        }),
      },
      disk: {
        canvas: 'chartDisk',
        fn: (samples) => {
          const mounts = [...new Set(samples.flatMap((s) => (s.disks || []).map((d) => d.mount)))];
          return {
            labels: this.labels(samples),
            datasets: mounts.map((m, i) => ({
              label: m,
              data: this.series(samples, (s) => {
                const d = (s.disks || []).find((x) => x.mount === m);
                return d ? d.pct : null;
              }),
              color: self.COLORS[i % self.COLORS.length],
            })),
          };
        },
      },
      diskDetail: {
        canvas: 'chartDiskDetail',
        fn: (samples) => {
          const m = Dash.diskDetailMount;
          return {
            labels: this.labels(samples),
            datasets: m ? [{
              label: `${m} %`,
              data: this.series(samples, (s) => {
                const d = (s.disks || []).find((x) => x.mount === m);
                return d ? d.pct : null;
              }),
              color: self.COLORS[1],
              fill: true,
            }] : [],
          };
        },
      },
      net: {
        canvas: 'chartNet',
        fn: (samples) => ({
          labels: this.labels(samples),
          datasets: [
            { label: 'Download Mbps', data: this.series(samples, (s) => s.net?.rxMbps ?? null), color: self.COLORS[0], fill: true },
            { label: 'Upload Mbps', data: this.series(samples, (s) => s.net?.txMbps ?? null), color: self.COLORS[1] },
          ],
        }),
      },
      io: {
        canvas: 'chartIO',
        fn: (samples) => {
          const dev = Dash.ioDev;
          return {
            labels: this.labels(samples),
            datasets: [
              { label: `${dev} leitura MB/s`, data: this.series(samples, (s) => {
                const io = (s.io || []).find((x) => x.dev === dev);
                return io ? io.readMBps ?? null : null;
              }), color: self.COLORS[0] },
              { label: `${dev} escrita MB/s`, data: this.series(samples, (s) => {
                const io = (s.io || []).find((x) => x.dev === dev);
                return io ? io.writeMBps ?? null : null;
              }), color: self.COLORS[1] },
            ],
          };
        },
      },
    };
    for (const [id, spec] of Object.entries(this.specs)) this.create(id, spec);
  },

  create(id, spec) {
    const canvas = document.getElementById(spec.canvas);
    if (!canvas) return null;
    const tt = this.tooltipStyle();
    this.charts[id] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: this.textColor(), boxWidth: 12, boxHeight: 12, font: { family: "'Inter', system-ui, sans-serif", size: 11 } } },
          tooltip: {
            backgroundColor: tt.backgroundColor,
            borderColor: tt.borderColor,
            borderWidth: 1,
            titleColor: tt.titleColor,
            bodyColor: tt.bodyColor,
            padding: 12,
            cornerRadius: 6,
            titleFont: { family: "'Inter', system-ui, sans-serif", size: 12, weight: '600' },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
          },
          zoom: {
            pan: { enabled: true, mode: 'x', modifierKey: 'shift' },
            zoom: { wheel: { enabled: true, speed: 0.05 }, pinch: { enabled: true }, mode: 'x' },
          },
          annotation: { annotations: {} },
        },
        scales: {
          x: {
            ticks: { color: this.faintColor(), maxTicksLimit: 8, maxRotation: 0, font: { family: "'JetBrains Mono', monospace", size: 11 } },
            grid: { color: this.gridColor() },
          },
          y: {
            ticks: { color: this.faintColor(), font: { family: "'JetBrains Mono', monospace", size: 11 } },
            grid: { color: this.gridColor() },
            beginAtZero: true,
          },
        },
        onClick: (evt, els, chart) => this.handleClick(evt, els, chart),
      },
    });
    return this.charts[id];
  },

  toDataset(d) {
    return {
      label: d.label,
      data: d.data,
      borderColor: d.color,
      backgroundColor: d.color + '22',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.25,
      fill: d.fill || false,
    };
  },

  sync() {
    for (const [id, spec] of Object.entries(this.specs)) {
      const chart = this.charts[id];
      if (!chart) continue;
      const { labels, datasets } = spec.fn(Dash.samples);
      chart.data.labels = labels;
      chart.data.datasets = datasets.map((d) => this.toDataset(d));
      chart.update('none');
      /* Resumo textual acessível do canvas (DS §9) */
      try {
        const canvas = document.getElementById(spec.canvas);
        if (canvas && typeof canvas.setAttribute === 'function') {
          canvas.setAttribute('role', 'img');
          const names = datasets.map((d) => d.label).join(', ') || 'sem séries';
          canvas.setAttribute('aria-label', `${id}: ${datasets.length} série(s) [${names}] em ${labels.length} ponto(s)`);
        }
      } catch { /* noop */ }
    }
  },

  /* Reaplica cores do tema ativo sem recriar gráficos (toggle claro/escuro) */
  retheme() {
    try {
      const tt = this.tooltipStyle();
      for (const chart of Object.values(this.charts)) {
        if (!chart || !chart.options) continue;
        const o = chart.options;
        if (o.plugins?.legend?.labels) o.plugins.legend.labels.color = this.textColor();
        if (o.plugins?.tooltip) {
          o.plugins.tooltip.backgroundColor = tt.backgroundColor;
          o.plugins.tooltip.borderColor = tt.borderColor;
          o.plugins.tooltip.titleColor = tt.titleColor;
          o.plugins.tooltip.bodyColor = tt.bodyColor;
        }
        if (o.scales?.x) {
          if (o.scales.x.ticks) o.scales.x.ticks.color = this.faintColor();
          if (o.scales.x.grid) o.scales.x.grid.color = this.gridColor();
        }
        if (o.scales?.y) {
          if (o.scales.y.ticks) o.scales.y.ticks.color = this.faintColor();
          if (o.scales.y.grid) o.scales.y.grid.color = this.gridColor();
        }
      }
    } catch { /* noop */ }
    this.sync();
  },

  applyAnnotations() {
    const anns = {};
    (Dash.annotations || []).forEach((a, i) => {
      anns['a' + i] = {
        type: 'line',
        scaleID: 'x',
        value: a.ts,
        borderColor: '#a855f7',
        borderWidth: 1,
        borderDash: [5, 4],
        label: {
          display: true,
          content: a.label || a.text.slice(0, 28),
          position: 'start',
          color: '#fff',
          backgroundColor: 'rgba(168,85,247,0.85)',
          font: { size: 10 },
        },
      };
    });
    for (const chart of Object.values(this.charts)) {
      chart.options.plugins.annotation.annotations = anns;
      chart.update('none');
    }
  },

  resetZoom() {
    for (const chart of Object.values(this.charts)) {
      if (typeof chart.resetZoom === 'function') chart.resetZoom();
    }
  },

  resize() {
    for (const chart of Object.values(this.charts)) chart.resize();
  },

  handleClick(evt, els, chart) {
    if (!els || !els.length) return;
    const idx = els[0].index;
    const s = Dash.samples[idx];
    if (s && Dash.sections.modal) Dash.sections.modal.open(s);
  },
};