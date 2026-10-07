import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from '../../test-support/frontend.js';

function makeSample(over = {}) {
  return {
    ts: '2026-08-15T09:12:00.000Z',
    host: 'meu-host',
    os: { kernel: '6.1.0', name: 'Debian GNU/Linux 12 (bookworm)' },
    cores: 2,
    uptimeSec: 90061,
    bootAt: '2026-08-14T08:00:00.000Z',
    load: [1.5, 1.0, 0.5],
    ram: { total: 8000, used: 4000, free: 1000, cache: 3000, avail: 4000, swapTotal: 2048, swapUsed: 0 },
    tempC: 35,
    net: { rxBytes: 1e9, txBytes: 5e8, rxMbps: 2.5, txMbps: 1.2 },
    disks: [{ mount: '/', size: '100G', used: '12G', avail: '83G', pct: 50, usedBytes: 1.2e10, sizeBytes: 1e11 }],
    io: [{ dev: 'sda', sectorsRead: 1, sectorsWrite: 1, readMBps: 1.1, writeMBps: 0.2 }],
    smart: [{ dev: 'sda', status: 'PASSED' }],
    services: { smbd: 'active', nmbd: 'inactive' },
    topProcs: [
      { user: 'root', pid: 1, cpu: 0.0, mem: 0.3, cmd: '/sbin/init' },
      { user: 'daemon', pid: 2, cpu: 5.0, mem: 2.1, cmd: '/usr/sbin/sshd' },
    ],
    ...over,
  };
}

function ctx() {
  const c = loadAll(['analysis.js', 'sections.js']);
  c.Dash.alerts = { active: [], all: [] };
  c.Dash.samples = [];
  c.Dash.latest = null;
  c.Dash.diskDetailMount = null;
  c.Dash.ioDev = 'sda';
  c.Dash.procsSort = { key: 'mem', dir: -1 };
  c.Dash.procsFilter = '';
  c.Dash.alertFilter = 'active';
  c.Dash.period = '24h';
  c.Dash.charts = { sync() {}, applyAnnotations() {}, resetZoom() {} };
  return c;
}

test('sections.health renderiza anel, nota e breakdown', () => {
  const { Dash, document } = ctx();
  const s = makeSample({ services: { smbd: 'active', nmbd: 'active' } });
  Dash.alerts.active = [];
  Dash.sections.health(s);
  assert.equal(document.getElementById('healthScore').textContent, '100');
  assert.match(document.getElementById('healthRing').style.background, /conic-gradient/);
  assert.equal(document.getElementById('healthNote').textContent, 'saudável');
  assert.match(document.getElementById('healthBreakdown').innerHTML, /nenhum problema/);

  Dash.latest = null;
  Dash.sections.health(null);
  assert.equal(document.getElementById('healthNote').textContent, 'crítico');
  assert.match(document.getElementById('healthBreakdown').innerHTML, /Sem dados/);
});

test('sections.alertBar renderiza com esc e anexa botões', () => {
  const { Dash, document } = ctx();
  Dash.sections.alertBar([{ level: 'warning', message: '<img src=x onerror=alert(1)>', id: 'abc' }]);
  const container = document.getElementById('alerts');
  assert.equal(container.children.length, 1);
  const div = container.children[0];
  assert.ok(div.classList.contains('alert-warning'));
  assert.ok(div.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(div.innerHTML.includes('data-ack="abc"'));
});

test('sections.overview preenche visão geral', () => {
  const { Dash, document } = ctx();
  Dash.sections.overview(makeSample());
  assert.equal(document.getElementById('hostLabel').textContent, 'meu-host');
  assert.equal(document.getElementById('uptimeValue').textContent, '1d 1h 1m');
  assert.match(document.getElementById('bootAt').textContent, /boot:/);
  assert.equal(document.getElementById('coresValue').textContent, '2 núcleos');
  assert.equal(document.getElementById('load1').textContent, '1.50');
  assert.equal(document.getElementById('ramUsed').textContent, '4000 MB');
  assert.equal(document.getElementById('ramTotal').textContent, '/ 8000 MB');
  assert.equal(document.getElementById('swapUsed').textContent, '0 MB');
  assert.equal(document.getElementById('tempValue').textContent, '35.0');
  assert.equal(document.getElementById('rxMbps').textContent, '2.50 Mbps');
  assert.equal(document.getElementById('txMbps').textContent, '1.20 Mbps');
});

test('sections.overview lida com amostra sem ram e sem temp', () => {
  const { Dash, document } = ctx();
  const s = makeSample({ ram: null, tempC: null });
  Dash.sections.overview(s);
  assert.equal(document.getElementById('tempValue').textContent, '—');
  assert.equal(document.getElementById('ramBar').style.width, undefined, 'sem ram, barra não é tocada');
});

test('sections.renderOverviewDisks cria linha com badge SMART', () => {
  const { Dash, document } = ctx();
  Dash.sections.renderOverviewDisks(makeSample({ disks: [{ mount: '/dev/sda1', size: '100G', used: '12G', avail: '83G', pct: 50, usedBytes: 1.2e10, sizeBytes: 1e11 }] }));
  const el = document.getElementById('overviewDisks');
  assert.equal(el.children.length, 1);
  assert.ok(el.children[0].innerHTML.includes('badge-ok'));
  assert.ok(el.children[0].innerHTML.includes('PASSED'));

  el.children[0].click();
  assert.equal(Dash.diskDetailMount, '/dev/sda1');
});

test('sections.renderServices cria badges por estado', () => {
  const { Dash, document } = ctx();
  Dash.sections.renderServices(makeSample());
  const el = document.getElementById('services');
  assert.equal(el.children.length, 2);
  assert.ok(el.children[0].classList.contains('badge-ok'));
  assert.ok(el.children[1].classList.contains('badge-bad'));
  assert.equal(el.children[1].textContent, 'nmbd: inactive');
});

test('sections.disks renderiza cards e seleciona o primeiro', () => {
  const { Dash, document } = ctx();
  const s = makeSample();
  Dash.latest = s;
  Dash.samples = Array.from({ length: 12 }, (_, i) => ({
    ts: String(i),
    disks: [{ mount: '/', usedBytes: (10 + i) * 1e9, sizeBytes: 1e11, pct: 50 }],
  }));
  Dash.sections.disks(s);
  const el = document.getElementById('diskCards');
  assert.equal(el.children.length, 1);
  const card = el.children[0];
  assert.ok(card.innerHTML.includes('/'));
  assert.ok(card.innerHTML.includes('50%'));
  assert.equal(Dash.diskDetailMount, '/');
  assert.equal(document.getElementById('diskDetailMount').textContent, '/');
});

test('sections.procs filtra e ordena', () => {
  const { Dash, document } = ctx();
  const tb = document.getElementById('procsTable');
  tb.appendChild(document.createElement('tbody'));
  Dash.latest = makeSample();
  Dash.procsFilter = '';
  Dash.procsSort = { key: 'mem', dir: -1 };
  Dash.sections.procs(Dash.latest);
  let tbody = tb.querySelector('tbody');
  assert.equal(tbody.children.length, 2);
  assert.ok(tbody.children[0].innerHTML.includes('2.1'));
  assert.ok(tbody.children[0].innerHTML.includes('/usr/sbin/sshd'));

  Dash.procsFilter = 'sshd';
  Dash.sections.procs(Dash.latest);
  tbody = tb.querySelector('tbody');
  assert.equal(tbody.children.length, 1);
  assert.ok(tbody.children[0].innerHTML.includes('sshd'));

  Dash.procsFilter = 'nao-existe';
  Dash.sections.procs(Dash.latest);
  assert.match(tbody.innerHTML, /nenhum processo/);
});

test('sections.procs ordena por pid ascendente', () => {
  const { Dash, document } = ctx();
  const tb = document.getElementById('procsTable');
  tb.appendChild(document.createElement('tbody'));
  Dash.latest = makeSample();
  Dash.procsSort = { key: 'pid', dir: 1 };
  Dash.sections.procs(Dash.latest);
  const tbody = tb.querySelector('tbody');
  assert.equal(tbody.children.length, 2);
  assert.ok(tbody.children[0].innerHTML.includes('>1<'));
  assert.ok(tbody.children[1].innerHTML.includes('>2<'));
});

test('sections.alertsView filtra active, all e nível', () => {
  const { Dash, document } = ctx();
  Dash.alerts = {
    active: [{ level: 'warning', message: 'Disco em 90%', status: 'new', ts: '2026-08-15T09:00:00.000Z', id: 'a' }],
    all: [
      { level: 'warning', message: 'Disco em 90%', status: 'new', ts: '2026-08-15T09:00:00.000Z', id: 'a' },
      { level: 'critical', message: '<script>x</script>', status: 'resolved', ts: '2026-08-15T08:00:00.000Z', id: 'b', resolvedAt: '2026-08-15T08:30:00.000Z' },
    ],
  };
  Dash.alertFilter = 'active';
  Dash.sections.alertsView();
  const el = document.getElementById('alertsList');
  assert.equal(el.children.length, 1);

  Dash.alertFilter = 'all';
  Dash.sections.alertsView();
  assert.equal(el.children.length, 2);
  assert.ok(el.children[1].innerHTML.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(el.children[1].classList.contains('resolved'));
  assert.ok(el.children[0].innerHTML.includes('data-action="ack"'));

  Dash.alertFilter = 'warning';
  Dash.sections.alertsView();
  assert.equal(el.children.length, 1);

  Dash.alertFilter = 'critical';
  Dash.sections.alertsView();
  assert.equal(el.children.length, 1);
  assert.ok(el.children[0].innerHTML.includes('critical'));
});

test('sections.analysis preenche painéis com análise', () => {
  const { Dash, document } = ctx();
  Dash.latest = makeSample();
  Dash.samples = Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 3600000).toISOString(),
    load: [1, 1, 1],
    ram: { total: 100, used: 40 + i },
    tempC: 40,
    net: { rxMbps: 1, txMbps: 0.5 },
    disks: [{ mount: '/', usedBytes: (40 + i) * 1e9, sizeBytes: 1e11, pct: 50 }],
  }));
  Dash.alerts.all = [{
    ts: '2026-08-01T00:00:00Z', message: 'Servidor inacessível: x', status: 'resolved',
    resolvedAt: '2026-08-01T00:10:00Z',
  }];

  const et = document.getElementById('etaTable');
  et.appendChild(document.createElement('tbody'));
  const dt = document.getElementById('dailyTable');
  dt.appendChild(document.createElement('tbody'));

  Dash.sections.analysis();

  assert.match(document.getElementById('ramPressure').innerHTML, /Média/);
  assert.match(document.getElementById('etaTable').querySelector('tbody').innerHTML, /GB\/dia/);
  assert.match(document.getElementById('dailyTable').querySelector('tbody').innerHTML, /2026-08-01/);
  assert.match(document.getElementById('outagesList').innerHTML, /duração/);
  const outagesEl = document.getElementById('outagesList');
  assert.ok(outagesEl.children.length >= 1, 'uptime prependado como elemento');
  assert.match(outagesEl.children[0].innerHTML, /Uptime/);
});

test('sections.history renderiza linhas e aviso de vazio', () => {
  const { Dash, document } = ctx();
  const tb = document.getElementById('historyTable');
  tb.appendChild(document.createElement('tbody'));
  Dash.samples = [makeSample()];
  Dash.sections.history();
  assert.match(document.getElementById('historyHint').textContent, /1 amostras exibidas/);
  assert.ok(tb.querySelector('tbody').innerHTML.includes('35°C'));
  assert.ok(tb.querySelector('tbody').innerHTML.includes('/ 50%'));

  Dash.samples = [];
  Dash.sections.history();
  assert.match(tb.querySelector('tbody').innerHTML, /sem amostras/);
});

test('sections.ioDevTabs cria abas e troca dispositivo ativo', () => {
  const { Dash, document } = ctx();
  Dash.latest = makeSample();
  Dash.ioDev = 'sda';
  Dash.sections.ioDevTabs();
  const el = document.getElementById('ioTabs');
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0].textContent, 'sda');
  assert.ok(el.children[0].classList.contains('active'));
});

test('sections.modal abre com escape e fecha', () => {
  const { Dash, document } = ctx();
  const evil = makeSample({
    host: '<script>alert(1)</script>',
    topProcs: [{ user: '<b>', pid: 1, cpu: 1, mem: 1, cmd: '<img onerror=x>' }],
  });
  Dash.sections.modal.open(evil);
  const body = document.getElementById('sampleModalBody');
  assert.ok(body.innerHTML.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(body.innerHTML.includes('&lt;img onerror=x&gt;'));
  assert.ok(!body.innerHTML.includes('<script>alert(1)</script>'));
  assert.equal(document.getElementById('modal').hidden, false);
  assert.equal(Dash.sections.modal.sample, evil);

  Dash.sections.modal.close();
  assert.equal(document.getElementById('modal').hidden, true);
  assert.equal(Dash.sections.modal.sample, null);
});