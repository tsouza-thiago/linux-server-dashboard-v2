// Cálculos e utilitários das telas (sem DOM, rodam no Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timeline, levelOf, viewOfKey, offlineMsIn, outagesIn, uptimeIn, dayStatuses, trafficOf, dailyTraffic, monitoredMsIn, reportDays,
  peakOf, meanOf, trendOf, topPeaks, diskEta, diskForecast, healthLevel, outageOf, cpuState, reportRequests, reportStepMin,
} from '../../public/js/core/analysis.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History } from '../../server/storage/index.js';
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

// #24 / ADR 0018: com `monitored`, a conta usa só o tempo medido e o dia sem medida é cinza.
test('disponibilidade: só o tempo medido; dia sem nenhuma coleta é "sem dados"', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const now = Date.parse('2026-10-07T15:00:00-03:00');
    // Medido: 1 h no dia 05 (com 15 min de queda) e as 3 últimas horas de hoje. Dia 06: nada.
    const monitored = [
      { from: '2026-10-05T10:00:00-03:00', to: '2026-10-05T11:00:00-03:00' },
      { from: '2026-10-07T12:00:00-03:00', to: '2026-10-07T15:00:00-03:00' },
    ];
    const outages = [{ from: '2026-10-05T10:10:00-03:00', to: '2026-10-05T10:25:00-03:00' }];
    assert.equal(monitoredMsIn(monitored, now - 3 * 24 * H, now), 4 * H);
    assert.equal(uptimeIn(outages, now - 3 * 24 * H, now, { nowMs: now, monitored }), 100 - (15 / 240) * 100, '15 min em 4 h medidas');
    const dia05 = Date.parse('2026-10-05T00:00:00-03:00');
    assert.equal(uptimeIn(outages, dia05, dia05 + 24 * H, { nowMs: now, monitored }), 75, '15 min em 1 h medida no dia');
    const dia06 = Date.parse('2026-10-06T00:00:00-03:00');
    assert.equal(uptimeIn([], dia06, dia06 + 24 * H, { nowMs: now, monitored }), null, 'dia sem medida não vira 100%');
    const days = dayStatuses({ days: 4, nowMs: now, sinceMs: Date.parse(monitored[0].from), outages, alerts: [], monitored });
    assert.deepEqual(days.map((d) => [d.day, d.status]), [
      ['2026-10-04', 'none'], ['2026-10-05', 'crit'], ['2026-10-06', 'none'], ['2026-10-07', 'ok'],
    ], 'o dia 06, sem coleta, fica cinza (antes ficava verde)');
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

// #68: em 90 dias o pedido único de baldes vinha com passo de 65 min, alinhado à época e não à
// hora; o balde das 23:45 levava as amostras de 00:00–00:50 para o dia anterior.
test('#68: relatórios contam cada amostra no dia local dela, também em 90 dias', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-68-'));
  try {
    // Uma meia-noite local de ~85 dias atrás; agregados de 5 min só de 23:00 às 00:55.
    const midnight = new Date(Date.now() - 85 * 86400e3).setHours(0, 0, 0, 0);
    const rollups = [];
    for (let t = midnight - H; t < midnight + H; t += 5 * MIN) {
      rollups.push({ t, n: 5, m: { cpu: t < midnight ? [10, 10, 10] : [50, 50, 50], rxDeltaBytes: [100, 100, 100] } });
    }
    fs.mkdirSync(path.join(dataDir, 'rollup'));
    for (const r of rollups) {
      fs.appendFileSync(path.join(dataDir, 'rollup', `${new Date(r.t).toISOString().slice(0, 10)}.ndjson`), `${JSON.stringify(r)}\n`);
    }
    const h = new History({ dataDir, log: () => {} });
    for (const days of [7, 30, 90]) {
      const to = Date.now();
      const from = to - days * 86400e3;
      const parts = reportRequests(from, to);
      assert.ok(parts.every((p) => p.limit <= 2000), `${days} d: no máximo 2000 baldes por pedido`);
      const buckets = parts.flatMap((p) => h.buckets({ fromMs: Date.parse(p.from), toMs: Date.parse(p.to), maxPoints: p.limit }).buckets);
      if (days < 85) { assert.deepEqual(buckets, [], `${days} d: o período não alcança a noite`); continue; }
      assert.equal(buckets.reduce((n, x) => n + x.n, 0), 24 * 5, 'cada amostra contada 1 vez');
      const before = new Date(midnight - H).toLocaleDateString('sv');
      const after = new Date(midnight).toLocaleDateString('sv');
      const rows = new Map(reportDays(buckets, ['cpu'], from, to).map((d) => [d.day, d]));
      assert.equal(rows.get(before).n, 60, 'só as 23:00–23:59 no dia anterior');
      assert.equal(rows.get(before).m.cpu.max, 10, 'nenhum valor da madrugada no dia anterior');
      assert.equal(rows.get(after).n, 60);
      assert.equal(rows.get(after).m.cpu.avg, 50);
      const traffic = new Map(dailyTraffic(buckets).map((d) => [d.day, d.rx]));
      assert.equal(traffic.get(before), 6000);
      assert.equal(traffic.get(after), 6000);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

// #74: os baldes de 1 h da #68 só alinham a meia-noite em fuso de hora inteira. Em UTC+5:30 o
// balde das 23:30 levava as amostras de 00:00–00:29 para o dia anterior (45 min em UTC+5:45).
const FUSOS_74 = ['America/Sao_Paulo', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/St_Johns', 'Australia/Lord_Howe'];

test('#74: passo e pedidos dos relatórios pelo fuso local, até 2000 baldes por pedido', () => {
  const tz = process.env.TZ;
  try {
    const at = (s) => Date.parse(s);
    const casos = [
      ['America/Sao_Paulo', 60, 2], ['Asia/Kolkata', 30, 3], ['Asia/Kathmandu', 15, 5],
      ['America/St_Johns', 30, 3], ['UTC', 60, 2],
    ];
    for (const [fuso, passo, partes] of casos) {
      process.env.TZ = fuso;
      const from = at('2026-07-01T00:00:00Z');
      const to = from + 90 * 86400e3;
      assert.equal(reportStepMin(from, to), passo, `${fuso}: passo`);
      const ps = reportRequests(from, to);
      assert.equal(ps.length, partes, `${fuso}: pedidos em 90 dias`);
      assert.ok(ps.every((p) => p.limit <= 2000), `${fuso}: no máximo 2000 baldes por pedido`);
      // As partes se encostam sem sobreposição e cobrem o período inteiro.
      assert.ok(Date.parse(ps[0].from) <= from && Date.parse(ps.at(-1).to) + 1 >= to, `${fuso}: cobre o período`);
      for (let i = 1; i < ps.length; i++) assert.equal(Date.parse(ps[i].from), Date.parse(ps[i - 1].to) + 1);
    }
    // Lord Howe: +10:30 no inverno, +11 no verão. A troca dentro do período pede 30 min.
    process.env.TZ = 'Australia/Lord_Howe';
    assert.equal(reportStepMin(at('2026-12-01T00:00:00Z'), at('2027-01-31T00:00:00Z')), 60, 'só +11');
    assert.equal(reportStepMin(at('2026-06-01T00:00:00Z'), at('2026-07-31T00:00:00Z')), 30, 'só +10:30');
    assert.equal(reportStepMin(at('2026-09-01T00:00:00Z'), at('2026-11-30T00:00:00Z')), 30, 'com a troca de outubro');
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test('#74: relatórios contam cada amostra no dia local dela, também em fuso de meia hora', () => {
  const tz = process.env.TZ;
  try {
    for (const fuso of FUSOS_74) {
      process.env.TZ = fuso;
      // Meias-noites locais de ~85 e de ~5 dias atrás: em Lord Howe, ao menos uma das duas
      // costuma cair em +10:30. Agregados de 5 min só de 1 h antes a 1 h depois de cada uma.
      const nights = [85, 5].map((d) => new Date(Date.now() - d * 86400e3).setHours(0, 0, 0, 0));
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-74-'));
      try {
        fs.mkdirSync(path.join(dataDir, 'rollup'));
        for (const midnight of nights) {
          for (let t = midnight - H; t < midnight + H; t += 5 * MIN) {
            const r = { t, n: 5, m: { cpu: t < midnight ? [10, 10, 10] : [50, 50, 50], rxDeltaBytes: [100, 100, 100] } };
            fs.appendFileSync(path.join(dataDir, 'rollup', `${new Date(t).toISOString().slice(0, 10)}.ndjson`), `${JSON.stringify(r)}\n`);
          }
        }
        const h = new History({ dataDir, log: () => {} });
        for (const days of [7, 30, 90]) {
          const to = Date.now();
          const from = to - days * 86400e3;
          const buckets = reportRequests(from, to)
            .flatMap((p) => h.buckets({ fromMs: Date.parse(p.from), toMs: Date.parse(p.to), maxPoints: p.limit }).buckets);
          const rows = new Map(reportDays(buckets, ['cpu'], from, to).map((d) => [d.day, d]));
          const traffic = new Map(dailyTraffic(buckets).map((d) => [d.day, d.rx]));
          const inside = nights.filter((m) => m - H >= from);
          assert.equal(buckets.reduce((n, x) => n + x.n, 0), inside.length * 24 * 5, `${fuso} ${days} d: cada amostra contada 1 vez`);
          for (const midnight of inside) {
            const before = new Date(midnight - H).toLocaleDateString('sv');
            const after = new Date(midnight).toLocaleDateString('sv');
            const msg = `${fuso} ${days} d, meia-noite de ${after}`;
            assert.equal(rows.get(before).n, 60, `${msg}: só a última hora no dia anterior`);
            assert.equal(rows.get(before).m.cpu.max, 10, `${msg}: nenhum valor da madrugada no dia anterior`);
            assert.equal(rows.get(after).n, 60, msg);
            assert.equal(rows.get(after).m.cpu.avg, 50, msg);
            assert.equal(traffic.get(before), 6000, `${msg}: rede do dia anterior`);
            assert.equal(traffic.get(after), 6000, `${msg}: rede do dia`);
          }
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

// #43: a tabela por dia dos Relatórios lista todos os dias do período, como a faixa de Eventos.
test('relatórios: um dia por linha, com o dia em queda e o dia sem coleta (n = 0)', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const at = (s) => Date.parse(s);
    // Baldes só nos dias 16 e 19; 17 e 18 sem amostra (um deles inteiro em queda).
    const buckets = [
      { t: at('2026-10-16T10:00:00-03:00'), n: 60, m: { cpu: [1, 9, 4] } },
      { t: at('2026-10-19T10:00:00-03:00'), n: 30, m: { cpu: [2, 6, 3] } },
    ];
    const days = reportDays(buckets, ['cpu'], at('2026-10-16T08:00:00-03:00'), at('2026-10-19T15:00:00-03:00'));
    assert.deepEqual(days.map((d) => [d.day, d.n]), [['2026-10-19', 30], ['2026-10-18', 0], ['2026-10-17', 0], ['2026-10-16', 60]]);
    assert.deepEqual(days[1].m, {}, 'dia sem amostra não inventa métrica');
    assert.equal(days[0].m.cpu.max, 6);
    assert.deepEqual(reportDays(undefined, [], at('2026-10-19T08:00:00-03:00'), at('2026-10-19T09:00:00-03:00')).map((d) => d.day), ['2026-10-19']);
    // Troca do horário de verão no meio do período (Nova York, 08/03/2026): o dia de 23 h
    // não faz o passo pular nem repetir dia.
    process.env.TZ = 'America/New_York';
    const dst = reportDays([], [], at('2026-03-06T12:00:00-05:00'), at('2026-03-10T12:00:00-04:00')).map((d) => d.day);
    assert.deepEqual(dst, ['2026-03-10', '2026-03-09', '2026-03-08', '2026-03-07', '2026-03-06']);
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

// Monta uma tela sem navegador: cada seletor vira um nó falso que guarda o HTML. O uPlot
// falso guarda as opções do gráfico para conferir o eixo.
function fakeScreen() {
  const nodes = new Map();
  // Nó falso: guarda o HTML; os filhos (data-slot dos cartões) são nós descartáveis.
  const node = () => ({ innerHTML: '', clientWidth: 600, querySelectorAll: () => [], querySelector: () => node() });
  const el = {
    innerHTML: '',
    querySelectorAll: () => [],
    addEventListener: () => {},
    querySelector: (sel) => {
      // Sem o formulário de datas fechado nem as faixas de telemetria (pedem o DOM de verdade).
      if (sel === '#rl-custom' || sel.startsWith('[data-strips')) return null;
      if (!nodes.has(sel)) nodes.set(sel, node());
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

test('visão geral (2.0.5): a manchete mede a queda pela queda, não pelo alerta', async () => {
  const visaoGeral = await import('../../public/js/views/visao-geral.js');
  const { el, text } = fakeScreen();
  // A queda real de 16/10: começou na 1ª falha e durou 252 s; o alerta só abriu na 2ª falha
  // (ALERT_OFFLINE_AFTER=2), 1 min depois, e durou 193 s. Eventos e Relatórios dizem 4 min.
  const from = Date.now() - (4 * H + MIN);
  const outage = { from: new Date(from).toISOString(), to: new Date(from + 252e3).toISOString(), durationSec: 252, ongoing: false, reason: 'SSH falhou (exit 255)' };
  const alert = {
    id: 'a1', key: 'servidor-inacessivel', level: 'critical', status: 'resolved', message: 'Servidor inacessível',
    ts: new Date(from + MIN).toISOString(), resolvedAt: new Date(from + 253e3).toISOString(),
  };
  visaoGeral.update({
    el, charts: new Map(), local: {}, api: { buckets: () => new Promise(() => {}) },
    state: {
      period: '24h', buckets: [], annotations: [], health: { score: 100, level: 'ok', parts: [] },
      meta: { online: true, pollIntervalMs: 60e3 }, alerts: { active: [], all: [alert] },
      outages: { outages: [outage], uptime: { uptimePct: 99.9 } },
    },
  });
  const hero = text('#vg-hero');
  assert.match(hero, /Servidor inacessível há 4 h 1 min e voltou ao normal sozinho em 4 min/);
  // Alerta sem queda correspondente (ex.: quedas fora do período pedido): fica como antes.
  assert.equal(outageOf(alert, []), null);
  assert.equal(outageOf({ ...alert, key: 'ram:usage' }, [outage]), null, 'só o alerta de servidor inacessível vira queda');
  assert.equal(outageOf(alert, [outage]), outage);
});

test('withBusy (#85): liga aguardando e desliga no fim, também quando a ação falha, e devolve o foco', async () => {
  const { withBusy } = await import('../../public/js/views/common.js');
  const attrs = new Map();
  const focos = [];
  const btn = {
    disabled: false, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), focus: (o) => focos.push(o),
  };
  let termina;
  const ok = withBusy(btn, new Promise((r) => { termina = r; }));
  assert.equal(btn.disabled, true);
  assert.equal(attrs.get('aria-busy'), 'true');
  termina(7);
  assert.equal(await ok, 7, 'devolve o resultado da ação');
  assert.equal(btn.disabled, false);
  assert.equal(attrs.has('aria-busy'), false);
  assert.deepEqual(focos, [], 'sem foco antes, não rouba o foco');
  btn.ownerDocument = { activeElement: btn };
  await assert.rejects(withBusy(btn, Promise.reject(new Error('falhou'))), /falhou/);
  assert.equal(btn.disabled, false);
  assert.equal(attrs.has('aria-busy'), false);
  assert.equal(focos.length, 1, 'quem usa o teclado continua no botão');
});

test('cartões (#48): sem dado, só o traço "—", sem a unidade colada', async () => {
  const { big, n0 } = await import('../../public/js/views/common.js');
  for (const unit of ['%', '°C', ' Mbps', ' ↓']) {
    assert.doesNotMatch(String(big(n0(null), unit)), /class="unit"/, `"—${unit}" não aparece`);
  }
  assert.match(String(big(n0(42), '%')), /42<span class="unit">%<\/span>/, 'com dado, a unidade continua');
});

test('visão geral (#47): o selo do processador não contradiz o uso de CPU ao lado', () => {
  // O caso do relato: CPU a 100% com load 1,39 num núcleo dizia "tranquilo".
  assert.equal(cpuState({ cpu: { pct: 100 }, load: [1.39], cores: 1 }), 'ocupado');
  assert.equal(cpuState({ cpu: { pct: 90 }, load: [0.2], cores: 1 }), 'ocupado', 'o limite de 90% conta');
  assert.equal(cpuState({ cpu: { pct: 89.9 }, load: [0.2], cores: 1 }), 'tranquilo');
  // Carga acima de 1,5 × núcleos ganha da CPU (mesma regra da saúde).
  assert.equal(cpuState({ cpu: { pct: 100 }, load: [3.1], cores: 2 }), 'sobrecarregado');
  assert.equal(cpuState({ cpu: { pct: 10 }, load: [1.6], cores: 1 }), 'sobrecarregado');
  // Sem CPU % (1ª coleta) não há selo; sem load, só a CPU decide (I5).
  assert.equal(cpuState({ cpu: null, load: [5], cores: 1 }), null);
  assert.equal(cpuState(null), null);
  assert.equal(cpuState({ cpu: { pct: 95 }, load: [] }), 'ocupado');
  assert.equal(cpuState({ cpu: { pct: null }, load: [0.1], cores: 1 }), 'tranquilo');
});

test('recursos (#53): eixo da temperatura com as casas que o passo entre as marcas pede', async () => {
  const recursos = await import('../../public/js/views/recursos.js');
  const { el } = fakeScreen();
  // O uPlot falso guarda as opções de cada gráfico pelo nó em que foi montado.
  const charts = new Map();
  globalThis.uPlot = class { constructor(o, _d, target) { charts.set(target, o); } setData() {} setScale() {} };
  try {
    recursos.update({ el, charts: new Map(), local: {}, state: { period: '24h', buckets: [], meta: {} } });
  } finally {
    delete globalThis.uPlot;
  }
  const opts = charts.get(el.querySelector('[data-chart="rc-temp"]'));
  assert.ok(opts, 'o gráfico de temperatura foi criado');
  const axis = (vals) => opts.axes[1].values(null, vals);
  // Temperatura constante em 29 °C: marcas de meio grau não podem repetir "29°".
  assert.deepEqual(axis([28.5, 29, 29.5, 30]), ['28,5°', '29,0°', '29,5°', '30,0°']);
  assert.deepEqual(axis([29, 29.2, 29.4]), ['29,0°', '29,2°', '29,4°']);
  assert.deepEqual(axis([30, 40, 50]), ['30°', '40°', '50°'], 'passo inteiro continua sem casas');
});

test('relatórios (#54): sem dado de rede, o cartão Rede diz "sem dados", não "0 B"', async () => {
  const relatorios = await import('../../public/js/views/relatorios.js');
  // Sem nenhuma amostra (1º uso) e com amostras sem a seção de rede (NET_IF vazio).
  for (const buckets of [[], [b(Date.now(), { cpu: [1, 5, 3] }, 10)]]) {
    const { el, text } = fakeScreen();
    relatorios.update({
      el, charts: new Map(), local: { custom: false, buckets },
      state: { meta: { pollIntervalMs: 60e3 } }, api: { exportUrl: () => '/api/export' },
    });
    const cards = text('#rl-cards');
    assert.match(cards, /Rede\s*—\s*sem dados/, `${buckets.length} balde(s)`);
    assert.doesNotMatch(cards, /0 B/);
  }
  // Tráfego zero de verdade, medido, continua "0 B".
  const { el, text } = fakeScreen();
  relatorios.update({
    el, charts: new Map(), local: { custom: false, buckets: [b(Date.now(), { rxDeltaBytes: [0, 0, 0], txDeltaBytes: [0, 0, 0] }, 10)] },
    state: { meta: { pollIntervalMs: 60e3 } }, api: { exportUrl: () => '/api/export' },
  });
  assert.match(text('#rl-cards'), /Rede\s*0 B\s*↓ 0 B · ↑ 0 B/);
});

test.todo('previsão de lotação (#116): enquanto o histórico carrega, a tela não diz "~1 dia"');
