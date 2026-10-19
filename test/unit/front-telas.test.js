// Cálculos e utilitários das telas (sem DOM, rodam no Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timeline, levelOf, viewOfKey, offlineMsIn, outagesIn, uptimeIn, dayStatuses, trafficOf, dailyTraffic,
  peakOf, meanOf, trendOf, topPeaks, diskEta, diskForecast, healthLevel,
} from '../../public/js/core/analysis.js';
import { applyDataStyles, html, mount } from '../../public/js/core/html.js';
import { alpha, autoRange, evenTicks } from '../../public/js/charts/timeseries.js';

const MIN = 60e3;
const H = 3600e3;
const b = (t, m, n = 1) => ({ t, n, m });

test('alertas: nível visual e tela de destino pela chave estável', () => {
  assert.equal(levelOf({ level: 'critical' }), 'crit');
  assert.equal(levelOf({ level: 'warning' }), 'warn');
  assert.equal(viewOfKey('disk:/:usage'), 'armazenamento');
  assert.equal(viewOfKey('smart:sda'), 'armazenamento');
  assert.equal(viewOfKey('ram:usage'), 'recursos');
  assert.equal(viewOfKey('temp:cpu'), 'recursos');
  assert.equal(viewOfKey('service:smbd'), 'processos');
  assert.equal(viewOfKey('servidor-inacessivel'), 'eventos');
  assert.equal(viewOfKey(), 'eventos');
  assert.deepEqual(['ok', 'warn', 'bad', undefined].map(healthLevel), ['ok', 'warn', 'crit', 'neutral']);
});

test('timeline: alerta "servidor inacessível" e a queda viram um item só, com a situação do alerta', () => {
  const items = timeline({
    alerts: [
      { id: 'off', key: 'servidor-inacessivel', level: 'critical', status: 'new', message: 'Servidor inacessível', ts: '2026-10-07T10:00:30Z' },
      { id: 'ram', key: 'ram:usage', level: 'warning', status: 'resolved', message: 'RAM', ts: '2026-10-07T09:00:00Z' },
    ],
    outages: [{ from: '2026-10-07T10:00:00Z', to: '2026-10-07T10:04:00Z', durationSec: 240, ongoing: false, reason: 'timeout' }],
  });
  assert.deepEqual(items.map((i) => i.kind), ['queda', 'alerta']);
  assert.equal(items[0].id, 'off');
  assert.equal(items[0].status, 'new', 'reconhecer a queda reconhece o alerta');
  assert.equal(items[1].key, 'ram:usage');
});

test('quedas no período: só as que tocam o intervalo, com o tempo recortado a ele', () => {
  const from = Date.parse('2026-10-01T00:00:00Z');
  const to = Date.parse('2026-10-08T00:00:00Z');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const outages = [
    // 10 h fora, das quais só as 2 últimas caem dentro do período.
    { from: '2026-09-30T14:00:00Z', to: '2026-10-01T02:00:00Z', durationSec: 12 * 3600 },
    // Inteira antes do período: não conta.
    { from: '2026-09-20T00:00:00Z', to: '2026-09-20T05:00:00Z', durationSec: 5 * 3600 },
    // Em andamento: conta até agora (30 min).
    { from: '2026-10-07T11:30:00Z', to: null, durationSec: 1800, ongoing: true },
  ];
  assert.deepEqual(outagesIn(outages, from, to, now), { count: 2, offlineSec: 2 * 3600 + 1800 });
  assert.deepEqual(outagesIn(undefined, from, to, now), { count: 0, offlineSec: 0 });
});

test('disponibilidade: tempo fora, % no intervalo e quadradinhos por dia local', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const now = Date.parse('2026-10-07T15:00:00-03:00');
    const outages = [{ from: '2026-10-06T22:40:00-03:00', to: '2026-10-06T22:44:00-03:00' }, { from: '2026-10-07T14:50:00-03:00', to: null }];
    assert.equal(offlineMsIn(outages, now - 24 * H, now, now), 14 * MIN, 'queda aberta conta até agora');
    const up = uptimeIn(outages, now - 24 * H, now, { nowMs: now });
    assert.ok(Math.abs(up - (100 - (14 / (24 * 60)) * 100)) < 1e-9);
    assert.equal(uptimeIn(outages, now, now - 1, { nowMs: now }), null, 'intervalo vazio');
    assert.equal(uptimeIn([], now - H, now, { sinceMs: now + 1, nowMs: now }), null, 'antes do monitoramento');
    const days = dayStatuses({
      days: 4, nowMs: now, sinceMs: Date.parse('2026-10-05T12:00:00-03:00'), outages: outages.slice(0, 1),
      alerts: [{ level: 'warning', ts: '2026-10-05T13:00:00-03:00' }, { level: 'critical', ts: 'lixo' }],
    });
    assert.deepEqual(days.map((d) => d.day), ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    assert.deepEqual(days.map((d) => d.status), ['none', 'warn', 'crit', 'ok']);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test('rede: bytes por balde pela média × coletas × intervalo; total por dia local', () => {
  const bucket = b(Date.parse('2026-10-07T12:00:00Z'), { rxMbps: [0, 10, 8], txMbps: [0, 2, 1] }, 60);
  assert.deepEqual(trafficOf(bucket, 60e3), { rx: 8e6 / 8 * 3600, tx: 1e6 / 8 * 3600 });
  assert.deepEqual(trafficOf(b(0, {}), 60e3), { rx: 0, tx: 0 }, 'sem dado = sem tráfego, não erro');
  const days = dailyTraffic([bucket, { ...bucket, t: bucket.t + H }, b('lixo', {})]);
  assert.equal(days.length, 1);
  assert.equal(days[0].rx, 2 * 8e6 / 8 * 3600);
});

test('séries: pico com horário, média ponderada, tendência e maiores picos sem repetir a rajada', () => {
  const list = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => b(i * MIN, { cpu: [i, i === 6 ? 90 : i * 2, i], rx: [0, i === 2 ? 50 : 1, 1] }, i === 0 ? 3 : 1));
  assert.deepEqual(peakOf(list, 'cpu'), { value: 90, t: 6 * MIN });
  assert.equal(peakOf(list, 'nada'), null);
  assert.equal(meanOf(list, 'cpu'), (0 * 3 + 45) / 12);
  assert.equal(meanOf([], 'cpu'), null);
  assert.ok(trendOf(list, 'cpu') > 0);
  assert.equal(trendOf(list.slice(0, 5), 'cpu'), null, 'poucos pontos: sem tendência');
  const peaks = topPeaks(list, ['cpu', 'rx'], { n: 3, stepMs: MIN });
  assert.deepEqual(peaks.map((p) => [p.key, p.value]), [['cpu', 90], ['rx', 50], ['cpu', 18]]);
  assert.equal(peaks[1].durationMs, MIN);
});

test('disco: previsão até o alerta e até encher; ritmo de décadas conta como estável', () => {
  const DAY = 86400e3;
  const GB = 1024 ** 3;
  const mk = (perDay, size = 1000 * GB, used0 = 600 * GB) => Array.from({ length: 49 }, (_, i) => {
    const used = used0 + (perDay * i) / 24;
    return b(i * H, { 'disk:/d:avail': [0, 0, size - used], 'disk:/d:pct': [0, 0, (used / size) * 100] }, 60);
  });
  const fc = diskForecast(mk(10 * GB), '/d', { alertPct: 90, nowMs: 0 });
  assert.equal(fc.status, 'enchendo');
  assert.ok(Math.abs(fc.days - 38) < 0.1, `${fc.days} dias até encher`);
  assert.ok(fc.daysToAlert < fc.days && fc.daysToAlert > 0);
  assert.equal(fc.fullAt, fc.days * DAY);
  assert.equal(diskEta(mk(0.05 * GB), '/d').status, 'estavel', '~8 mil dias para encher = estável');
  assert.equal(diskForecast(mk(10 * GB, 1000 * GB, 950 * GB), '/d', { alertPct: 90 }).daysToAlert, 0, 'já acima do alerta');
  assert.equal(diskForecast([], '/d').status, 'cedo');
});

test('html: medidas e cores dos dados entram pelo CSSOM (a CSP proíbe style="…")', () => {
  const styles = [];
  const el = (d) => { const node = { dataset: d, style: {} }; styles.push(node); return node; };
  const nodes = [el({ w: '140' }), el({ h: '-5', l: '33' }), el({ bg: 's3', op: '0.4' }), el({ bg: 'url(x)' })];
  applyDataStyles({ querySelectorAll: () => nodes });
  assert.deepEqual(nodes.map((n) => n.style), [
    { width: '100%' }, { height: '0%', left: '33%' }, { background: 'var(--s3)', opacity: '0.4' }, {},
  ]);
  applyDataStyles(null);
  const target = { innerHTML: '', querySelectorAll: () => [] };
  mount(target, html`<div data-w="${'50"><script>'}"></div>`);
  assert.equal(target.innerHTML, '<div data-w="50&quot;&gt;&lt;script&gt;"></div>');
});

test('gráficos: cor com alfa, faixa automática do eixo e régua de tempo', () => {
  assert.equal(alpha('#0E9CB0', 0.35), 'rgba(14,156,176,0.35)');
  assert.equal(alpha('rgba(1,2,3,1)', 0.5), 'rgba(1,2,3,1)');
  assert.deepEqual(autoRange(null, 5), [0, 1]);
  assert.deepEqual(autoRange(0, 10), [0, 11.5], 'perto do zero: começa no zero');
  const [lo, hi] = autoRange(40, 50, [60]);
  assert.ok(lo > 0 && lo < 40 && hi > 60, 'temperatura: faixa justa que inclui o limite de 60');
  const tz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const t0 = Date.parse('2026-10-07T00:00:00Z') / 1000;
    assert.deepEqual(evenTicks(t0, t0 + 6 * 3600, 3, t0 + 6 * 3600), ['00:00', '03:00', 'agora']);
    assert.deepEqual(evenTicks(t0, t0 + 6 * 3600, 3, 0), ['00:00', '03:00', '06:00']);
    assert.deepEqual(evenTicks(5, 5), []);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

// ---------------------------------------------------------------- telas montadas no Node

// Monta uma tela sem navegador: cada seletor vira um nó falso que guarda o HTML e só
// `#rl-custom` (o formulário de datas fechado) não existe. O uPlot falso guarda as opções
// do gráfico para conferir o eixo.
function fakeScreen() {
  const nodes = new Map();
  const el = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: (sel) => {
      if (sel === '#rl-custom') return null;
      if (!nodes.has(sel)) nodes.set(sel, { innerHTML: '', clientWidth: 600, querySelectorAll: () => [] });
      return nodes.get(sel);
    },
  };
  // Texto visível do nó: tira as tags até não sobrar nenhuma. Uma passada só deixaria
  // restos como "<<b>script>" virarem tag de novo (alerta do CodeQL, js/incomplete-
  // multi-character-sanitization); aqui não há HTML de fora, mas o auxiliar fica correto.
  const text = (sel) => {
    let s = nodes.get(sel)?.innerHTML || '';
    for (let prev = null; prev !== s;) { prev = s; s = s.replace(/<[^>]*>/g, ''); }
    return s.replace(/\s+/g, ' ');
  };
  const page = () => el.innerHTML.replace(/\s+/g, ' ');
  return { el, text, page };
}

// Tráfego baixo e real de um servidor ocioso: médias de 0,004 e 0,002 Mbps em 10 coletas
// de 1 min = 300.000 + 150.000 bytes (≈ 439 KB no dia), bem abaixo de 0,1 GB.
const quietBucket = () => b(Date.now(), { rxMbps: [0, 0.01, 0.004], txMbps: [0, 0.01, 0.002] }, 10);

test('rede (2.0.2): vazão e volume pequenos legíveis, não "0,0" nem "0,0 GB"', async () => {
  const rede = await import('../../public/js/views/rede.js');
  const { el, text } = fakeScreen();
  const ctx = {
    el, charts: new Map(), local: { week: [quietBucket()] },
    state: { period: '24h', buckets: [], meta: { pollIntervalMs: 60e3 }, sample: { uptimeSec: 100, net: { iface: 'eth0', rxMbps: 0.01, txMbps: 0, rxErrors: 0, txErrors: 0, rxDrops: 0, txDrops: 0 } } },
  };
  rede.update(ctx);
  const cards = text('#rd-cards');
  assert.match(cards, /Download agora 0,01 Mbps/, '0,01 Mbps agora não vira "0,0"');
  assert.match(cards, /Trafegado hoje 439 KB ↓ 293 KB · ↑ 146 KB/);
  assert.doesNotMatch(cards, /GB/);
  const week = text('#rd-week');
  assert.match(week, /maior dia: hoje · 439 KB \(↓ 293 KB · ↑ 146 KB\)/);
  assert.doesNotMatch(week, /GB/);
});

test('rede (2.0.2): eixo do tráfego com as casas que o passo entre as marcas pede', async () => {
  const rede = await import('../../public/js/views/rede.js');
  const { el } = fakeScreen();
  let opts = null;
  globalThis.uPlot = class { constructor(o) { opts = o; } setData() {} setScale() {} };
  try {
    rede.update({ el, charts: new Map(), local: {}, state: { period: '24h', buckets: [], meta: {} } });
  } finally {
    delete globalThis.uPlot;
  }
  assert.ok(opts, 'o gráfico de tráfego foi criado');
  const axis = (vals) => opts.axes[1].values(null, vals);
  assert.deepEqual(axis([0, 0.002, 0.004, 0.006]), ['0', '0,002', '0,004', '0,006'], 'pico de 0,01 Mbps');
  assert.deepEqual(axis([0, 0.25, 0.5, 0.75]), ['0', '0,25', '0,50', '0,75']);
  assert.deepEqual(axis([0, 0.5, 1, 1.5]), ['0', '0,5', '1,0', '1,5']);
  assert.deepEqual(axis([0, 20, 40]), ['0', '20', '40']);
  assert.deepEqual(axis([0.1 + 0.2, 0.6]), ['0,3', '0,6'], 'erro de ponto flutuante não vira casas a mais');
});

test('relatórios (2.0.2): cartão e tabela da Rede com unidade automática', async () => {
  const relatorios = await import('../../public/js/views/relatorios.js');
  const { el, text } = fakeScreen();
  relatorios.update({
    el, charts: new Map(), local: { custom: false, buckets: [quietBucket()] },
    state: { meta: { pollIntervalMs: 60e3 } }, api: { exportUrl: () => '/api/export' },
  });
  const cards = text('#rl-cards');
  assert.match(cards, /Rede\s*439 KB\s*↓ 293 KB · ↑ 146 KB/);
  assert.doesNotMatch(cards, /GB/);
  const table = text('#rl-table');
  assert.match(table, /293 KB \/ 146 KB/);
  assert.doesNotMatch(table, /GB/);
});

test('rede (2.0.3): o painel "Volume por dia" não fixa a unidade em GB', async () => {
  const rede = await import('../../public/js/views/rede.js');
  const { el, page, text } = fakeScreen();
  rede.render({
    el, charts: new Map(), local: {}, api: { buckets: () => Promise.resolve({ buckets: [quietBucket()] }) },
    state: { period: '24h', buckets: [], meta: { pollIntervalMs: 60e3 } },
  });
  await new Promise((ok) => setImmediate(ok));
  // Cada barra e a nota trazem a própria unidade (2.0.2); o "GB" fixo no título contradizia "439 KB".
  assert.match(page(), /Volume por dia · 7 dias/);
  assert.doesNotMatch(page(), />GB</);
  assert.match(text('#rd-week'), /439 KB/);
});

test('rede (2.0.4): volume pelos bytes por coleta; baldes antigos usam as taxas', () => {
  // Servidor ocioso em baldes de 20 min: a média da taxa arredondada chega como 0, mas os
  // bytes por coleta (37,5 KB em média, 20 coletas) somam 750 KB.
  const quiet = b(Date.parse('2026-10-07T12:00:00Z'), { rxMbps: [0, 0.01, 0], txMbps: [0, 0, 0], rxDeltaBytes: [20_000, 60_000, 37_500], txDeltaBytes: [100, 300, 200] }, 20);
  assert.deepEqual(trafficOf(quiet, 60e3), { rx: 750_000, tx: 4_000 });
  const old = b(Date.parse('2026-10-06T12:00:00Z'), { rxMbps: [0, 10, 8], txMbps: [0, 2, 1] }, 60);
  assert.deepEqual(trafficOf(old, 60e3), { rx: 8e6 / 8 * 3600, tx: 1e6 / 8 * 3600 }, 'antes da 2.0.4: estimativa pelas taxas');
  // 4º item: 1 das 20 coletas veio sem o volume (ex.: a 1ª depois de um reboot).
  const partial = b(quiet.t, { rxDeltaBytes: [20_000, 60_000, 37_500, 19] }, 20);
  assert.equal(trafficOf(partial, 60e3).rx, 712_500, 'média × 19, não × 20');
  assert.equal(meanOf([partial, b(0, { rxDeltaBytes: [0, 0, 0] }, 1)], 'rxDeltaBytes'), 712_500 / 20);
  const days = dailyTraffic([quiet, { ...quiet, t: quiet.t + 20 * MIN }]);
  assert.equal(days.length, 1);
  assert.equal(days[0].rx, 1_500_000, 'dia de tráfego baixo não vira 0');
});
