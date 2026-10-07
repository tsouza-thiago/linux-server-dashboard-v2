import test from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, escape, mount, isSafe } from '../../public/js/core/html.js';
import * as fmt from '../../public/js/core/format.js';
import { parseHash, buildHash, VIEWS, PERIODS, viewByKey } from '../../public/js/core/router.js';
import { createStore, appendSample } from '../../public/js/core/store.js';
import { series, xs, keysWith, diskEta, dailySummary, headline, fullestDisk, timeline, isOffline } from '../../public/js/core/analysis.js';

test('html: toda interpolação é escapada; raw() é a única porta para HTML', () => {
  const evil = '<img src=x onerror=alert(1)>"\'`&';
  const out = html`<p title="${evil}">${evil}</p>`;
  assert.ok(isSafe(out));
  assert.equal(String(out), '<p title="&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&#96;&amp;">&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&#96;&amp;</p>');
  assert.equal(String(html`<b>${raw('<i>ok</i>')}</b>`), '<b><i>ok</i></b>');
  assert.equal(String(html`<ul>${['a', '<b>'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  assert.equal(String(html`${null}${undefined}${false}${0}`), '0', 'nulos somem; zero aparece');
  assert.equal(escape(null), '');
  const el = { innerHTML: '' };
  mount(el, '<script>');
  assert.equal(el.innerHTML, '&lt;script&gt;', 'texto solto também é escapado');
  mount(el, html`<em>${'x'}</em>`);
  assert.equal(el.innerHTML, '<em>x</em>');
  mount(null, html`x`);
});

test('format: PT-BR e dado ausente vira "—" (I5)', () => {
  assert.equal(fmt.num(1234.5, 1), '1.234,5');
  assert.equal(fmt.pct(12.345, 1), '12,3%');
  assert.equal(fmt.bytes(155475050496), '145 GB');
  assert.equal(fmt.bytes(1967845998592), '1,8 TB');
  assert.equal(fmt.bytes(512), '512 B');
  assert.equal(fmt.mb(840), '840 MB');
  assert.equal(fmt.mbps(0.02), '0,02 Mb/s');
  assert.equal(fmt.mbs(12.34), '12,3 MB/s');
  assert.equal(fmt.celsius(32), '32,0 °C');
  assert.equal(fmt.ms(6.13), '6,1 ms');
  for (const f of [fmt.num, fmt.pct, fmt.bytes, fmt.mb, fmt.mbps, fmt.mbs, fmt.celsius, fmt.ms, fmt.duration, fmt.days]) {
    assert.equal(f(null), '—', f.name);
    assert.equal(f(undefined), '—', f.name);
    assert.equal(f(Number.NaN), '—', f.name);
  }
  assert.equal(fmt.duration(40), '40 s');
  assert.equal(fmt.duration(8 * 60), '8 min');
  assert.equal(fmt.duration(5 * 3600 + 12 * 60), '5 h 12 min');
  assert.equal(fmt.duration(2 * 86400 + 3 * 3600), '2 d 3 h');
  assert.equal(fmt.duration(-1), '—');
  assert.equal(fmt.days(12.4), '~12 dia(s)');
  assert.equal(fmt.days(95), '~3 meses');
  assert.equal(fmt.days(540), '~1,5 ano(s)');
  assert.equal(fmt.time('lixo'), '—');
  assert.equal(fmt.dateTime(null), '—');
  assert.equal(fmt.ago(Date.now() - 10e3), 'agora');
  assert.equal(fmt.ago(Date.now() - 3 * 60e3), 'há 3 min');
  assert.equal(fmt.localDay('lixo'), null);
});

test('B5 — resumo diário agrupa pelo dia do fuso local, não UTC', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    // 02:00 UTC do dia 8 ainda é dia 7 em São Paulo (UTC−3).
    const b = (iso, v) => ({ t: Date.parse(iso), n: 60, m: { tempC: [v, v, v] } });
    const rows = dailySummary([b('2026-10-07T20:00:00Z', 40), b('2026-10-08T02:00:00Z', 50), b('2026-10-08T12:00:00Z', 30)], ['tempC']);
    assert.deepEqual(rows.map((r) => r.day), ['2026-10-08', '2026-10-07']);
    assert.deepEqual(rows[1].m.tempC, { min: 40, max: 50, avg: 45 });
    assert.equal(rows[1].n, 120);
    assert.equal(fmt.localDay('2026-10-08T02:00:00Z'), '2026-10-07');
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test('router: tela e período na URL, com padrões para valores desconhecidos', () => {
  assert.equal(VIEWS.length, 8);
  assert.deepEqual(VIEWS.map((v) => v.key), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(parseHash('#/armazenamento?p=7d'), { view: 'armazenamento', period: '7d' });
  assert.deepEqual(parseHash(''), { view: 'visao-geral', period: '24h' });
  assert.deepEqual(parseHash('#/nao-existe?p=2y'), { view: 'visao-geral', period: '24h' });
  assert.deepEqual(parseHash('#/rede?p=constructor'), { view: 'rede', period: '24h' }, 'só chaves próprias');
  assert.equal(buildHash({ view: 'rede', period: '24h' }), '#/rede');
  assert.equal(buildHash({ view: 'rede', period: '90d' }), '#/rede?p=90d');
  assert.equal(PERIODS['90d'], 90 * 86400e3);
  assert.equal(viewByKey('6').id, 'eventos');
  assert.equal(viewByKey('9'), null);
});

test('store: set com objeto ou função avisa os inscritos; appendSample ordena e não repete', () => {
  const s = createStore({ a: 1 });
  const seen = [];
  const off = s.subscribe((state, patch) => seen.push([state.a, patch]));
  s.set({ a: 2 });
  s.set((st) => ({ a: st.a + 1 }));
  off();
  s.set({ a: 9 });
  assert.deepEqual(seen, [[2, { a: 2 }], [3, { a: 3 }]]);
  assert.equal(s.get().a, 9);
  const t = (m) => new Date(Date.UTC(2026, 9, 7, 12, m)).toISOString();
  let list = [{ ts: t(0) }, { ts: t(1) }];
  list = appendSample(list, { ts: t(1) });
  assert.equal(list.length, 2, 'repetida (backfill) ignorada');
  list = appendSample(list, { ts: t(70) }, { periodMs: 60 * 60e3 });
  assert.deepEqual(list.map((x) => x.ts), [t(70)], 'fora do período sai');
  assert.equal(appendSample(list, null), list);
  assert.equal(appendSample([], { ts: t(0) }, { max: 0 }).length, 0);
});

test('analysis: séries com buracos, eixo em segundos e chaves por prefixo', () => {
  const b = [
    { t: 1000, n: 1, m: { cpu: [1, 3, 2], 'disk:/:pct': [5, 5, 5] } },
    { t: 61000, n: 1, m: { 'disk:/mnt/x:pct': [7, 7, 7] } },
  ];
  assert.deepEqual(series(b, 'cpu'), [2, null], 'balde sem a métrica é buraco, não zero');
  assert.deepEqual(series(b, 'cpu', 'max'), [3, null]);
  assert.deepEqual(xs(b), [1, 61]);
  assert.deepEqual(keysWith(b, 'disk:', ':pct'), ['disk:/:pct', 'disk:/mnt/x:pct']);
});

test('analysis: previsão de disco cheio só com ~1 dia de dados; estável ou enchendo', () => {
  const H = 3600e3;
  const mk = (hours, availAt) => Array.from({ length: hours + 1 }, (_, i) => ({ t: i * H, n: 60, m: { 'disk:/:avail': [0, 0, availAt(i)] } }));
  assert.equal(diskEta(mk(10, () => 1e12), '/').status, 'cedo');
  assert.equal(diskEta(mk(48, () => 1e12), '/').status, 'estavel');
  const GB = 1024 ** 3;
  const filling = diskEta(mk(48, (i) => 100 * GB - (i * 10 * GB) / 24), '/'); // 10 GB/dia
  assert.equal(filling.status, 'enchendo');
  assert.ok(Math.abs(filling.perDayBytes - 10 * GB) < GB / 100);
  assert.ok(Math.abs(filling.days - 8) < 0.01, `${filling.days} dias`);
  assert.equal(diskEta([], '/').status, 'cedo');
});

test('analysis: manchete, disco mais cheio e linha do tempo', () => {
  assert.deepEqual(headline({ score: 100, level: 'ok', parts: [] }), { level: 'ok', title: 'Servidor saudável', score: 100, reasons: [] });
  assert.equal(headline({ score: 70, level: 'warn', parts: [{ label: 'RAM 92%' }] }).title, 'Atenção');
  assert.deepEqual(headline({ level: 'bad', parts: [{ label: 'SMART /dev/sda' }] }).reasons, ['SMART /dev/sda']);
  assert.equal(headline(null).title, 'Aguardando a primeira coleta');
  assert.equal(headline({ level: 'ok' }, { online: false }).title, 'Servidor inacessível');
  assert.equal(fullestDisk({ disks: [{ mount: '/', pct: 2 }, { mount: '/x', pct: 28 }, { mount: '/y', pct: null }] }).mount, '/x');
  assert.equal(fullestDisk({}), null);
  const items = timeline({
    alerts: [{ id: 'a', ts: '2026-10-07T10:00:00Z', level: 'warning', status: 'new', message: 'RAM' }],
    annotations: [{ id: 'n', ts: '2026-10-07T12:00:00Z', text: 'troquei o disco', label: 'manutenção' }],
    outages: [{ from: '2026-10-07T11:00:00Z', to: null, durationSec: 60, ongoing: true, reason: 'timeout' }, { from: 'lixo' }],
  });
  assert.deepEqual(items.map((i) => i.kind), ['anotacao', 'queda', 'alerta']);
  assert.equal(items[1].ongoing, true);
});

test('gráficos: rótulos do eixo de tempo em PT-BR e 24 h; anotações pelo instante (B10)', async () => {
  const { timeTicks, markersInRange } = await import('../../public/js/charts/timeseries.js');
  const tz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const t = Date.parse('2026-10-07T18:30:00Z') / 1000; // 15:30 em São Paulo
    assert.deepEqual(timeTicks([t, null], 3600), ['15:30', '']);
    assert.deepEqual(timeTicks([t], 7 * 86400), ['07/10']);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
  const marks = markersInRange([{ ts: 'lixo' }, { ts: '2026-10-07T12:00:00Z', label: 'x' }, { ts: '2026-10-07T12:00:00Z', text: 'y' }], 0, 2e9);
  assert.deepEqual(marks.map((m) => m.label), ['x', 'y']);
  assert.deepEqual(markersInRange(null, 0, 1), []);
});

test('isOffline: só com falha de verdade (não logo após reiniciar o painel)', () => {
  assert.equal(isOffline({ online: false, failures: 0, offlineSince: null }), false, 'antes da 1ª coleta');
  assert.equal(isOffline({ online: false, failures: 2, offlineSince: null }), true);
  assert.equal(isOffline({ online: false, failures: 0, offlineSince: '2026-10-07T12:00:00Z' }), true, 'queda aberta antes de reiniciar');
  assert.equal(isOffline({ online: true, failures: 0 }), false);
  assert.equal(isOffline(null), false);
});
