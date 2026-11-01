// Núcleo do frontend no Node: template html com escape, formatos PT-BR, análise e estado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, escape, mount } from '../../public/js/core/html.js';
import * as fmt from '../../public/js/core/format.js';
import { parseHash, buildHash, veioDoAtualizar, VIEWS, PERIODS, viewByKey } from '../../public/js/core/router.js';
import { createStore } from '../../public/js/core/store.js';
import { formatoDe, lembrarFormato } from '../../public/js/core/formato.js';
import { series, xs, keysWith, diskEta, dailySummary, headline, fullestDisk, timeline, isOffline, mergeAlerts, ALERTS_LIMIT } from '../../public/js/core/analysis.js';

test('html: toda interpolação é escapada; raw() é a única porta para HTML', () => {
  const evil = '<img src=x onerror=alert(1)>"\'`&';
  const out = html`<p title="${evil}">${evil}</p>`;
  // O resultado já é HTML seguro: dentro de outro template não é escapado de novo.
  assert.equal(String(html`<div>${out}</div>`), `<div>${String(out)}</div>`);
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
  assert.equal(fmt.pct(99.987, 2), '99,99%', 'disponibilidade com 2 casas');
  assert.equal(fmt.pct(Number.NaN, 2), '—', 'NaN não vira "—%"');
  assert.equal(fmt.cmdName('/usr/bin/dockerd -H fd://'), 'dockerd');
  assert.equal(fmt.cmdName(''), '');
  assert.equal(fmt.bytes(155475050496), '145 GB');
  assert.equal(fmt.bytes(1967845998592), '1,8 TB');
  assert.equal(fmt.bytes(512), '512 B');
  assert.equal(fmt.mb(840), '840 MB');
  assert.equal(fmt.mbps(0.02), '0,02 Mbps');
  assert.deepEqual(fmt.bytesParts(300000), { value: '293', unit: 'KB' });
  assert.deepEqual(fmt.bytesParts(null), { value: '—', unit: '' }, 'dado ausente não vira "0 B"');
  assert.equal(fmt.mbpsNum(0.01), '0,01');
  assert.equal(fmt.mbpsNum(12.34), '12,3');
  assert.equal(fmt.mbpsNum(null), '—');
  assert.equal(fmt.axisDigits([0, 0.002, 0.004]), 3);
  assert.equal(fmt.axisDigits([0, 0.25, 0.5]), 2);
  assert.equal(fmt.axisDigits([0, 20, 40]), 0);
  assert.equal(fmt.axisDigits([5]), 0, 'uma marca só: sem passo, sem casas');
  assert.equal(fmt.axisDigits([0, 1e-7]), 4, 'no máximo 4 casas');
  assert.equal(fmt.celsius(32), '32,0 °C');
  assert.equal(fmt.ms(6.13), '6,1 ms');
  for (const f of [fmt.num, fmt.pct, fmt.bytes, fmt.mb, fmt.mbps, fmt.celsius, fmt.ms, fmt.duration, fmt.days]) {
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
  assert.equal(veioDoAtualizar('#/visao-geral?atualizar=1'), true);
  assert.equal(veioDoAtualizar('#/visao-geral?p=7d'), false);
  assert.equal(veioDoAtualizar(''), false);
  assert.equal(buildHash({ view: 'rede', period: '90d' }), '#/rede?p=90d');
  assert.equal(PERIODS['90d'], 90 * 86400e3);
  assert.equal(viewByKey('6').id, 'eventos');
  assert.equal(viewByKey('9'), null);
});

test('store: set com objeto ou função avisa os inscritos', () => {
  const s = createStore({ a: 1 });
  const seen = [];
  const off = s.subscribe((state, patch) => seen.push([state.a, patch]));
  s.set({ a: 2 });
  s.set((st) => ({ a: st.a + 1 }));
  off();
  s.set({ a: 9 });
  assert.deepEqual(seen, [[2, { a: 2 }], [3, { a: 3 }]]);
  assert.equal(s.get().a, 9);
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

test('alertas ao vivo: o SSE (50 mais recentes) atualiza a lista sem encolher os 200 carregados', () => {
  assert.equal(ALERTS_LIMIT, 200);
  // Lista carregada da API: 200 alertas, do mais novo (a199) ao mais antigo (a0).
  const prev = Array.from({ length: 200 }, (_, i) => ({ id: `a${199 - i}`, status: 'resolved' }));
  // Evento SSE: um alerta novo e os 49 seguintes, com a199 agora reconhecido.
  const recent = [{ id: 'a200', status: 'new' }, { id: 'a199', status: 'ack' },
    ...Array.from({ length: 48 }, (_, i) => ({ id: `a${198 - i}`, status: 'resolved' }))];
  const out = mergeAlerts(recent, prev);
  assert.equal(out.length, 200, 'não encolhe para 50');
  assert.deepEqual(out.slice(0, 2), [{ id: 'a200', status: 'new' }, { id: 'a199', status: 'ack' }], 'o SSE vence');
  assert.equal(out.at(-1).id, 'a1', 'o mais antigo sai para caber o novo');
  assert.equal(new Set(out.map((a) => a.id)).size, 200, 'sem repetidos');
  assert.deepEqual(mergeAlerts(undefined, prev), prev);
  assert.deepEqual(mergeAlerts([{ id: 'x' }], undefined), [{ id: 'x' }]);
});

// #121 / ADR 0033: as contagens do esqueleto. Só o navegador as tem antes da 1ª amostra.
function comArmazenamento(t, inicial = null) {
  const guardado = new Map(inicial === null ? [] : [['dash_formato', inicial]]);
  const escritas = [];
  const armazenamento = { getItem: (k) => guardado.get(k) ?? null, setItem: (k, v) => { escritas.push(k); guardado.set(k, v); } };
  Object.defineProperty(globalThis, 'localStorage', { value: armazenamento, configurable: true });
  t.after(() => delete globalThis.localStorage);
  return { guardado, escritas };
}
const quatroPastasEm3Discos = {
  disks: [{}, {}, {}, {}], io: [{}, {}, {}], smart: [{}, {}, {}], services: { smbd: 'active', ssh: 'active' },
};

test('formato: pastas e discos são contagens separadas, e a amostra vence o que foi lembrado', (t) => {
  comArmazenamento(t, JSON.stringify({ pastas: 9, discos: 9, smart: 9, servicos: 9 }));
  assert.deepEqual(formatoDe(quatroPastasEm3Discos), { pastas: 4, discos: 3, smart: 3, servicos: 2 });
});

test('formato: lembra só as contagens, e grava 1 vez enquanto elas não mudam', (t) => {
  const { guardado, escritas } = comArmazenamento(t);
  assert.deepEqual(formatoDe(null), { pastas: 1, discos: 1, smart: 1, servicos: 1 }, 'sem nada guardado, supõe o menor servidor');
  lembrarFormato({ ...quatroPastasEm3Discos, host: 'servidor-exemplo' });
  lembrarFormato(quatroPastasEm3Discos);
  lembrarFormato(null);
  assert.deepEqual(escritas, ['dash_formato']);
  assert.deepEqual(formatoDe(null), { pastas: 4, discos: 3, smart: 3, servicos: 2 });
  assert.deepEqual(Object.keys(JSON.parse(guardado.get('dash_formato'))), ['pastas', 'discos', 'smart', 'servicos'], 'só números, nenhum nome');
  assert.doesNotMatch(guardado.get('dash_formato'), /servidor-exemplo/);
});

test('formato: valor inválido no armazenamento volta ao padrão, sem criar blocos sem fim', (t) => {
  const padrao = { pastas: 1, discos: 1, smart: 1, servicos: 1 };
  for (const texto of ['{', 'null', '[]', '{"pastas":4}', '{"pastas":1e9,"discos":1,"smart":1,"servicos":1}', '{"pastas":-1,"discos":1,"smart":1,"servicos":1}', '{"pastas":"4","discos":1,"smart":1,"servicos":1}']) {
    comArmazenamento(t, texto);
    assert.deepEqual(formatoDe(null), padrao, texto);
  }
});

test('formato: armazenamento bloqueado não derruba a tela', (t) => {
  const bloqueado = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } };
  Object.defineProperty(globalThis, 'localStorage', { value: bloqueado, configurable: true });
  t.after(() => delete globalThis.localStorage);
  assert.deepEqual(formatoDe(null), { pastas: 1, discos: 1, smart: 1, servicos: 1 });
  assert.doesNotThrow(() => lembrarFormato(quatroPastasEm3Discos));
});
