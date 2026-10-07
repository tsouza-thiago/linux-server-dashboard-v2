// Ponta a ponta no Chromium (critério de saída da F5): o painel real, com 2 h de dados,
// abre as 8 telas sem erro de JavaScript nem violação de CSP. Precisa do playwright-core
// (devDependency) e de um Chromium; sem eles o teste é pulado com aviso.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close } from '../../test-support/request.js';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch { /* sem playwright-core */ }

const VIEWS = [
  ['visao-geral', 'Visão geral', 5], ['recursos', 'Recursos', 6], ['armazenamento', 'Armazenamento', 4],
  ['rede', 'Rede', 1], ['processos', 'Processos & serviços', 0], ['eventos', 'Eventos', 0],
  ['relatorios', 'Relatórios', 0], ['ajuda', 'Ajuda', 0],
];

function sample(ts, i) {
  const wave = Math.sin(i / 10);
  return {
    schemaVersion: 2, ts: new Date(ts).toISOString(), host: 'servidor-exemplo',
    os: { kernel: '6.12', name: 'Debian GNU/Linux 13 (trixie)' }, cores: 1, uptimeSec: 3600 + i * 60,
    load: [0.3 + wave * 0.2, 0.3, 0.25], cpu: { pct: 20 + wave * 10, user: 15, system: 4, iowait: 3 + wave, steal: 0 },
    ram: { total: 840, used: 400 + wave * 50, free: 100, cache: 300, avail: 440 - wave * 50, swapTotal: 885, swapUsed: 24, dirty: 1, writeback: 0 },
    tempC: 40 + wave * 3, tempSensor: 'acpitz',
    disks: [{ mount: '/', source: '/dev/sda2', dev: 'sda', pct: 30, usedBytes: 3e10, sizeBytes: 1e11, availBytes: 7e10 - i * 1e6, inodesPct: 2 }],
    net: { iface: 'enp0s7', rxBytes: 1e6 + i, txBytes: 5e5 + i, rxErrors: 0, rxDrops: 0, txErrors: 0, txDrops: 0, rxMbps: 2 + wave, txMbps: 1 },
    io: [{ dev: 'sda', readMBps: 1 + wave, writeMBps: 0.5, utilPct: 10 + wave * 5, latencyMs: 6 }],
    psi: { cpu: { some10: 4 }, memory: { some10: 0.1 }, io: { some10: 5 } },
    smart: [{ dev: 'sda', status: 'PASSED' }], smartAt: new Date(ts).toISOString(), services: { smbd: 'active' },
    topProcs: [{ user: 'root', pid: 934, cpu: 1.7, mem: 11.5, rssKB: 99044, etimesSec: 64, cmd: '/usr/bin/dockerd -H fd://' }],
  };
}

async function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-e2e-'));
  const app = createApp({
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'), collect: async () => ({ ok: false, error: 'sem coleta no e2e' }),
    log: () => {}, ...extra,
  });
  const now = Date.now();
  for (let i = 0; i < 120; i++) app.store.append(sample(now - (120 - i) * 60e3, i));
  app.engine.onSample(app.store.getLatest());
  const { server, port } = await listen(app.app);
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    await close(server);
    return { skip: `Chromium indisponível: ${err.message.split('\n')[0]}` };
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  t.after(async () => {
    await browser.close();
    await app.shutdown();
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, page, problems, base: `http://localhost:${port}` };
}

test('e2e: as 8 telas abrem com dados, gráficos e sem erro de JS/CSP', { skip: !chromium && 'playwright-core não instalado (npm install)' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  for (const [id, title, charts] of VIEWS) {
    await s.page.goto(`${s.base}/#/${id}?p=6h`, { waitUntil: 'load' });
    await s.page.waitForFunction((txt) => document.getElementById('viewTitle')?.textContent === txt, title);
    if (charts) await s.page.waitForFunction((n) => document.querySelectorAll('.uplot').length >= n, charts, { timeout: 5000 });
    const count = await s.page.$$eval('.uplot', (els) => els.length);
    assert.ok(count >= charts, `${id}: ${count} gráficos (esperado ≥ ${charts})`);
  }
  assert.match(await s.page.locator('.view-ajuda').innerText(), /ALERT_DISK_PCT/);
  assert.deepEqual(s.problems, []);
});

test('e2e: visão geral mostra a manchete e os dados da última coleta', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.headline');
  assert.match(await s.page.locator('.headline').innerText(), /Servidor saudável/);
  assert.match(await s.page.locator('#hostLabel').innerText(), /servidor-exemplo/);
  assert.match(await s.page.locator('.cards').innerText(), /Disco mais cheio[\s\S]*30%/);
  assert.deepEqual(s.problems, []);
});

test('e2e: atalhos de teclado trocam de tela e de tema', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.headline');
  await s.page.keyboard.press('3');
  await s.page.waitForFunction(() => document.querySelector('.view-armazenamento'));
  assert.equal(await s.page.textContent('#viewTitle'), 'Armazenamento');
  assert.match(await s.page.evaluate(() => location.hash), /^#\/armazenamento/);
  const before = await s.page.evaluate(() => document.documentElement.dataset.theme);
  await s.page.keyboard.press('t');
  assert.notEqual(await s.page.evaluate(() => document.documentElement.dataset.theme), before);
  assert.equal(before, 'dark', 'escuro é o padrão (D1)');
});

test('e2e: anotação com HTML malicioso aparece como texto (anti-XSS)', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  s.app.annotationsStore.add({ text: '<img src=x onerror="window.__xss=1">troquei o disco', label: '<b>manutenção</b>' });
  await s.page.goto(`${s.base}/#/eventos`, { waitUntil: 'load' });
  await s.page.waitForSelector('.event-list');
  assert.match(await s.page.locator('.event-list').innerText(), /<img src=x onerror="window.__xss=1">troquei o disco/);
  assert.equal(await s.page.evaluate(() => window.__xss), undefined);
  assert.equal(await s.page.locator('.event-list img').count(), 0);
});

test('e2e: com DASH_TOKEN a tela pede login e só então mostra os dados', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const token = 'e'.repeat(43);
  const s = await setup(t, { dashToken: token });
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('#login:not([hidden])');
  await s.page.fill('#loginToken', 'errado');
  await s.page.click('#loginSubmit');
  await s.page.waitForFunction(() => document.getElementById('loginError').textContent === 'Token incorreto');
  await s.page.fill('#loginToken', token);
  await Promise.all([s.page.waitForNavigation(), s.page.click('#loginSubmit')]);
  await s.page.waitForSelector('.headline');
  assert.equal(await s.page.$eval('#login', (el) => el.hidden), true);
  assert.deepEqual(s.problems.filter((p) => !/401/.test(p)), [], 'só os 401 esperados antes do login');
});
