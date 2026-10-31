// Ponta a ponta no Chromium: o painel real, com 2 h de dados,
// abre as 8 telas sem erro de JavaScript nem violação de CSP. Precisa do playwright-core
// (devDependency) e de um Chromium; sem eles o teste é pulado com aviso.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close } from '../../test-support/request.js';
import { APERTADO, pressiona, semHover, sobe } from '../../test-support/hover.js';
import { atualizacaoFalsa, procurarFalso } from '../../scripts/painel-teste.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch { /* sem playwright-core */ }
// No CI (E2E_OBRIGATORIO=1) o e2e não pode pular calado: sem navegador, a suíte falha.
const OBRIGATORIO = process.env.E2E_OBRIGATORIO === '1';
if (OBRIGATORIO && !chromium) throw new Error('E2E_OBRIGATORIO=1, mas o playwright-core não está instalado');

// Gráficos mínimos por tela: Visão geral = 3 mini-gráficos + 5 faixas de telemetria;
// Recursos = CPU, RAM, temperatura + 3 faixas de PSI; Armazenamento = previsão + 1 faixa por disco.
const VIEWS = [
  ['visao-geral', 'Visão geral', 8], ['recursos', 'Recursos', 6], ['armazenamento', 'Armazenamento', 2],
  ['rede', 'Rede', 1], ['processos', 'Processos & serviços', 0], ['eventos', 'Eventos', 0],
  ['relatorios', 'Relatórios', 0], ['ajuda', 'Ajuda', 0],
];

// Todo contêiner, gráfico e campo das telas, por tipo (ADR 0024).
const CONTEINERES = '.card, .panel, .hero, .mini, .input, .strip-row, .ring, .mem-cell .meter';

function sample(ts, i) {
  const wave = Math.sin(i / 10);
  return {
    schemaVersion: 2, ts: new Date(ts).toISOString(), host: 'servidor-exemplo',
    os: { kernel: '6.12', name: 'Debian GNU/Linux 13 (trixie)' }, cores: 1, uptimeSec: 3600 + i * 60,
    load: [0.3 + wave * 0.2, 0.3, 0.25], cpu: { pct: 20 + wave * 10, user: 15, system: 4, iowait: 3 + wave, steal: 0 },
    ram: { total: 840, used: 400 + wave * 50, free: 100, cache: 300, avail: 440 - wave * 50, swapTotal: 885, swapUsed: 24, dirty: 1, writeback: 0 },
    tempC: 40 + wave * 3, tempSensor: 'acpitz',
    disks: [{ mount: '/', source: '/dev/sda2', dev: 'sda', pct: 30, usedBytes: 3e10, sizeBytes: 1e11, availBytes: 7e10 - i * 1e6, inodesPct: 2 }],
    net: { iface: 'enp0s7', rxBytes: 1e6 + i, txBytes: 5e5 + i, rxErrors: 0, rxDrops: 0, txErrors: 0, txDrops: 0, rxMbps: 2 + wave, txMbps: 1, rxDeltaBytes: 15e6 + i * 997, txDeltaBytes: 7.5e6 + i * 499 },
    io: [{ dev: 'sda', readMBps: 1 + wave, writeMBps: 0.5, utilPct: 10 + wave * 5, latencyMs: 6 }],
    psi: { cpu: { some10: 4 }, memory: { some10: 0.1 }, io: { some10: 5 } },
    smart: [{ dev: 'sda', status: 'PASSED' }], smartAt: new Date(ts).toISOString(), services: { smbd: 'active' },
    topProcs: [{ user: 'root', pid: 934, cpu: 1.7, mem: 11.5, rssKB: 99044, etimesSec: 64, cmd: '/usr/sbin/sshd -D' }],
  };
}

async function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-e2e-'));
  const app = createApp({
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'), collect: async () => ({ ok: false, error: 'sem coleta no e2e' }),
    log: () => {}, ...extra, viewport: undefined,
  });
  const now = Date.now();
  for (let i = 0; i < 120; i++) app.store.append(sample(now - (120 - i) * 60e3, i));
  app.engine.onSample(app.store.getLatest());
  const { server, port } = await listen(app.app);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  } catch (err) {
    await close(server);
    if (OBRIGATORIO) throw err;
    return { skip: `Chromium indisponível: ${err.message.split('\n')[0]}` };
  }
  const page = await browser.newPage({ viewport: extra.viewport || { width: 1280, height: 900 } });
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
    // Conta só os gráficos da tela nova (trocar o hash mantém a tela anterior até a nova montar).
    await s.page.waitForSelector(`.view-${id}`);
    if (charts) await s.page.waitForFunction(([v, n]) => document.querySelectorAll(`.view-${v} .uplot`).length >= n, [id, charts], { timeout: 5000 });
    const count = await s.page.$$eval(`.view-${id} .uplot`, (els) => els.length);
    assert.ok(count >= charts, `${id}: ${count} gráficos (esperado ≥ ${charts})`);
  }
  assert.match(await s.page.locator('.view-ajuda').innerText(), /Configuração ativa[\s\S]*DISK_MOUNTS/);
  assert.deepEqual(s.problems, []);
});

test('e2e: visão geral mostra a manchete e os dados da última coleta', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.hero');
  assert.match(await s.page.locator('.hero').innerText(), /Servidor saudável/);
  assert.match(await s.page.locator('#strip').innerText(), /ONLINE[\s\S]*servidor-exemplo/);
  assert.match(await s.page.locator('#vg-card-disk').innerText(), /Disco mais cheio[\s\S]*30\s*%/);
  assert.deepEqual(s.problems, []);
});

// Orçamento de desempenho (AGENTS): a página inicial transfere até 450 KB (HTML, CSS, JS, fontes,
// uPlot e os dados das primeiras chamadas da API; o SSE fica de fora, ele não termina).
test('e2e: versão nova — aviso, novidades com texto escapado, menu e fechar o aviso', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const ctx = await setup(t, { procurarVersao: procurarFalso });
  if (ctx.skip) return t.skip(ctx.skip);
  const { app, page, base, problems } = ctx;
  await page.goto(base);
  await page.waitForSelector('#manutBtn svg');
  assert.ok(await page.isHidden('#avisoVersao'), 'sem versão nova, sem aviso');
  // A procura termina com a tela aberta: o aviso chega pelo SSE, sem recarregar.
  await page.waitForFunction(() => document.getElementById('strip').textContent.length > 0);
  await app.atualizacao.verificar();
  await page.waitForSelector('#avisoVersao:not([hidden])');
  assert.match(await page.textContent('#avisoVersao'), /v9\.9\.9/);
  await page.click('#avisoVersao [data-manut="novidades"]');
  await page.waitForSelector('#novidadesDialog[open]');
  const novidades = await page.textContent('#novidadesDialog .novidades');
  assert.match(novidades, /<b>HTML<\/b> no texto/, 'o HTML do CHANGELOG aparece como texto');
  assert.equal(await page.locator('#novidadesDialog .novidades b').count(), 0);
  // Sem login: o botão fica desligado e o comando do terminal aparece.
  assert.match(await page.textContent('#novidadesDialog'), /\.\/dashboard atualizar/);
  assert.ok(await page.isDisabled('#novidadesDialog .dialogo-acoes .btn-primary'));
  await page.click('#novidadesDialog button[type="submit"]');
  await page.click('#avisoVersao [data-manut="dispensar"]');
  assert.ok(await page.isHidden('#avisoVersao'));
  await page.reload();
  await page.waitForSelector('#manutBtn.tem-novidade');
  assert.ok(await page.isHidden('#avisoVersao'), 'a versão dispensada não volta ao recarregar');
  await page.click('#manutBtn');
  await page.waitForSelector('#manutMenu:not([hidden])');
  assert.match(await page.textContent('#manutMenu'), /v9\.9\.9/, 'o menu continua mostrando a versão');
  await page.keyboard.press('Escape');
  assert.ok(await page.isHidden('#manutMenu'));
  assert.deepEqual(problems, []);
});

// O botão Atualizar (ADR 0031): o painel "cai" no meio (a leitura falha) e a tela continua sozinha.
test('e2e: atualizar — botão, log ao vivo, painel fora do ar e recarga', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-e2e-troca-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let voltar;
  const pausa = new Promise((r) => { voltar = r; });
  const troca = atualizacaoFalsa(dir, { passoMs: 200, reiniciar: () => pausa });
  const ctx = await setup(t, { procurarVersao: procurarFalso, ...troca, dashToken: 'e2e-teste' });
  if (ctx.skip) return t.skip(ctx.skip);
  const { app, page, base, problems } = ctx;
  await page.request.post(`${base}/api/login`, { data: { token: 'e2e-teste' } });
  await app.atualizacao.verificar();
  await page.goto(base);
  await page.waitForSelector('#avisoVersao:not([hidden])');
  await page.click('#avisoVersao [data-manut="novidades"]');
  await page.waitForSelector('#novidadesDialog[open]');
  assert.doesNotMatch(await page.textContent('#novidadesDialog'), /\.\/dashboard atualizar/, 'com login, o botão no lugar do comando');
  await page.evaluate(() => { window.semRecarregar = true; });
  await page.click('[data-manut="atualizar"]');
  await page.waitForSelector('#registroLog');
  await page.waitForFunction(() => document.getElementById('registroLog').textContent.includes('cópia de segurança'));
  // A fase "ligando" para aqui: o painel cai, a leitura falha e a tela avisa.
  await page.route('**/api/atualizacao/registro*', (r) => r.abort());
  await page.waitForFunction(() => document.getElementById('registroFase').textContent.includes('Reiniciando o painel'));
  await page.keyboard.press('Escape');
  assert.ok(await page.isVisible('#novidadesDialog[open]'), 'o Esc não fecha no meio da troca');
  voltar();
  await page.unroute('**/api/atualizacao/registro*');
  // A página recarrega sozinha: a marca some, e a interface da "versão nova" está de pé.
  await page.waitForFunction(() => document.getElementById('registroFase')?.textContent.includes('Atualizado para v9.9.9'));
  assert.match(await page.textContent('#registroLog'), /cópia de segurança[\s\S]*atualizado de v/, 'o log continua de onde parou');
  await page.waitForFunction(() => !window.semRecarregar, null, { timeout: 8000 });
  await page.waitForSelector('#manutBtn svg');
  const filtrados = problems.filter((p) => !/Failed to load resource|ERR_FAILED/.test(p));
  assert.deepEqual(filtrados, []);
});

test('e2e: atualizar — voltou atrás mostra o resultado e não recarrega', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-e2e-volta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = await setup(t, { procurarVersao: procurarFalso, ...atualizacaoFalsa(dir, { passoMs: 100, resultado: 'voltou' }), dashToken: 'e2e-teste' });
  if (ctx.skip) return t.skip(ctx.skip);
  const { app, page, base, problems } = ctx;
  await page.request.post(`${base}/api/login`, { data: { token: 'e2e-teste' } });
  await app.atualizacao.verificar();
  await page.goto(base);
  await page.click('#manutBtn');
  await page.click('#manutMenu [data-manut="novidades"]');
  await page.click('[data-manut="atualizar"]');
  await page.waitForSelector('#novidadesDialog[data-resultado="voltou"]');
  assert.match(await page.textContent('#registroFase'), /não funcionou aqui/);
  await page.click('[data-manut="fechar"]');
  assert.ok(await page.isHidden('#novidadesDialog'));
  assert.deepEqual(problems, []);
});

test('e2e: a página inicial transfere até 450 KB (orçamento de desempenho)', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  const sizes = [];
  s.page.on('requestfinished', (req) => sizes.push(req.sizes().then((z) => ({ url: req.url(), bytes: z.responseBodySize + z.responseHeadersSize }))));
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.hero');
  await s.page.waitForFunction(() => document.querySelectorAll('.view-visao-geral .uplot').length >= 8);
  await s.page.waitForTimeout(500); // pedidos que a tela faz depois de desenhar
  const all = await Promise.all(sizes);
  const total = all.reduce((a, r) => a + r.bytes, 0);
  const top = all.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((r) => `${r.url.replace(s.base, '')} ${Math.round(r.bytes / 1024)} KB`);
  t.diagnostic(`página inicial: ${Math.round(total / 1024)} KB em ${all.length} pedidos · maiores: ${top.join(' · ')}`);
  assert.ok(all.length > 5, 'pedidos medidos');
  assert.ok(total <= 450 * 1024, `página inicial com ${Math.round(total / 1024)} KB (limite 450 KB)`);
  assert.deepEqual(s.problems, []);
});

test('e2e: atalhos de teclado trocam de tela e de tema', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.hero');
  await s.page.keyboard.press('3');
  await s.page.waitForFunction(() => document.querySelector('.view-armazenamento'));
  assert.equal(await s.page.textContent('#viewTitle'), 'Armazenamento');
  assert.match(await s.page.evaluate(() => location.hash), /^#\/armazenamento/);
  const before = await s.page.evaluate(() => document.documentElement.dataset.theme);
  await s.page.keyboard.press('t');
  assert.notEqual(await s.page.evaluate(() => document.documentElement.dataset.theme), before);
  assert.equal(before, 'dark', 'escuro é o padrão (ADR 0009)');
});

// ADR 0022: botão principal sobe com o mouse em cima; com "reduzir movimento", só a cor muda.
test('e2e: hover — botão solto sobe, grupo não sobe e o movimento reduzido anula o deslocamento', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/#/eventos?p=6h`, { waitUntil: 'load' });
  await s.page.locator('[data-act="note"]').waitFor();
  for (const seletor of ['[data-act="note"]', '#pollBtn', '#themeToggle', '[data-act="notify"]']) {
    assert.notEqual(await sobe(s.page, seletor), 'none', `sombra junto com o deslocamento: ${seletor}`);
  }
  await s.page.locator('.segmented button:not([aria-pressed="true"])').first().hover();
  await s.page.waitForTimeout(250);
  assert.equal(await s.page.locator('.segmented button:not([aria-pressed="true"])').first().evaluate((b) => getComputedStyle(b).transform), 'none', 'botão em grupo não sobe');
  const barra = s.page.locator('.nav-item:not([aria-current])').first();
  await barra.hover();
  await s.page.waitForFunction(() => {
    const item = document.querySelector('.nav-item:not([aria-current])');
    return getComputedStyle(item, '::before').transform === 'matrix(1, 0, 0, 1, 0, 0)';
  });
  await s.page.goto(`${s.base}/#/relatorios`, { waitUntil: 'load' });
  await s.page.locator('.export-btn').first().waitFor();
  await sobe(s.page, '.export-btn');
  await s.page.emulateMedia({ reducedMotion: 'reduce' });
  await s.page.locator('.export-btn').first().hover();
  await s.page.waitForFunction(() => document.querySelector('.export-btn').matches(':hover'));
  assert.equal(await s.page.locator('.export-btn').first().evaluate((b) => getComputedStyle(b).transform), 'none', 'sem deslocamento com movimento reduzido');
  assert.deepEqual(s.problems, []);
});

test('e2e: hover — o gráfico sobe menos que o botão, a faixa não sobe e o mouse continua chegando ao gráfico', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/#/recursos`, { waitUntil: 'load' });
  await s.page.waitForFunction(() => document.querySelectorAll('.view-recursos .uplot').length >= 6);
  const painel = '.view-recursos .panel:not(.flush):has(.chart)';
  assert.notEqual(await sobe(s.page, painel, -1), 'none', 'sombra junto com o deslocamento');
  const alvo = await s.page.evaluate((sel) => {
    const r = document.querySelector(`${sel} .u-over`).getBoundingClientRect();
    const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return e.className;
  }, painel);
  assert.equal(alvo, 'u-over', 'a faixa do hover não cobre o gráfico');
  await s.page.locator('.strip-row').first().hover();
  await s.page.waitForTimeout(250);
  assert.equal(await s.page.locator('.strip-row').first().evaluate((r) => getComputedStyle(r).transform), 'none');
  await s.page.goto(`${s.base}/#/relatorios`, { waitUntil: 'load' });
  await s.page.locator('.view-relatorios .card').first().waitFor();
  await sobe(s.page, '.view-relatorios .card', -1);
  await sobe(s.page, '.view-relatorios .panel:not(.flush)', -1);
  await s.page.locator('.view-relatorios .panel.flush').hover();
  await s.page.waitForTimeout(250);
  assert.equal(await s.page.locator('.view-relatorios .panel.flush').evaluate((p) => getComputedStyle(p).transform), 'none', 'painel de tabela não sobe');
  assert.deepEqual(s.problems, []);
});

test('e2e: hover — nenhum clicável, contêiner ou gráfico das 8 telas, nos 2 temas, fica sem mudança de estilo', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  s.app.annotationsStore.add({ text: 'troquei o disco', label: 'manutenção' });
  for (const tema of ['dark', 'light']) {
    await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
    await s.page.evaluate((th) => localStorage.setItem('dash_theme', th), tema);
    await s.page.reload({ waitUntil: 'load' });
    assert.equal(await s.page.getAttribute('html', 'data-theme'), tema);
    for (const [id, , charts] of VIEWS) {
      await s.page.goto(`${s.base}/#/${id}`, { waitUntil: 'load' });
      await s.page.waitForSelector(`.view-${id}`);
      if (charts) await s.page.waitForFunction(([v, n]) => document.querySelectorAll(`.view-${v} .uplot`).length >= n, [id, charts]);
      assert.deepEqual(await semHover(s.page, `a, button, summary, ${CONTEINERES}`), [], `${id}, tema ${tema}`);
    }
  }
});

// ADR 0025: o botão solto encolhe ao ser apertado; grupo, lista e menu só mudam o fundo.
test('e2e: clique — botão solto encolhe, grupo, lista e desligado não se movem e o movimento reduzido anula o deslocamento', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  s.app.annotationsStore.add({ text: 'troquei o disco' });
  await s.page.goto(`${s.base}/#/eventos?p=6h`, { waitUntil: 'load' });
  await s.page.locator('.event-list .btn').first().waitFor();
  for (const seletor of ['[data-act="note"]', '#pollBtn', '#themeToggle', '[data-act="notify"]']) {
    const e = await pressiona(s.page, seletor);
    assert.equal(e.transform, APERTADO, seletor);
    assert.match(e.boxShadow, /inset/, `anel no lugar da sombra: ${seletor}`);
  }
  for (const seletor of ['.segmented button:not([aria-pressed="true"])', '.event-list .btn', '.nav-item:not([aria-current])']) {
    const e = await pressiona(s.page, seletor);
    assert.equal(e.transform, 'none', `não se move: ${seletor}`);
    assert.equal(e.mudou, true, `o fundo responde: ${seletor}`);
  }
  await s.page.locator('#pollBtn').evaluate((b) => { b.disabled = true; });
  assert.deepEqual(await pressiona(s.page, '#pollBtn'), { transform: 'none', boxShadow: 'none', mudou: false }, 'desligado não responde');
  await s.page.locator('#pollBtn').evaluate((b) => { b.disabled = false; });
  await s.page.emulateMedia({ reducedMotion: 'reduce' });
  const e = await pressiona(s.page, '#pollBtn');
  assert.equal(e.transform, 'none', 'sem deslocamento com movimento reduzido');
  assert.match(e.boxShadow, /inset/, 'o anel continua mostrando o clique');
  assert.deepEqual(s.problems, []);
});

test('e2e: clique — soltar o mouse no canto do botão, depois de ele encolher, ainda conta como clique', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/#/eventos`, { waitUntil: 'load' });
  // O botão da barra lateral não é remontado pela tela. O clique para aqui, sem coletar.
  const botao = s.page.locator('#pollBtn');
  await botao.evaluate((b) => b.addEventListener('click', (e) => { e.stopImmediatePropagation(); window.__cliques = 1; }, { capture: true }));
  await botao.hover();
  await s.page.waitForTimeout(200);
  const caixa = await botao.boundingBox();
  await s.page.mouse.move(caixa.x + 1, caixa.y + 1);
  await s.page.mouse.down();
  await s.page.waitForTimeout(200);
  await s.page.mouse.up();
  assert.equal(await s.page.evaluate(() => window.__cliques), 1);
});

test('e2e: clique — o botão fica aguardando sem mudar de largura, e o duplo clique faz só 1 pedido', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  const pedidos = { poll: 0, nota: 0 };
  let libera;
  const espera = new Promise((r) => { libera = r; });
  await s.page.route('**/api/poll', async (rota) => { pedidos.poll++; await espera; await rota.continue(); });
  await s.page.route('**/api/annotations', async (rota) => {
    if (rota.request().method() === 'POST') { pedidos.nota++; await espera; }
    await rota.continue();
  });
  await s.page.goto(`${s.base}/#/eventos`, { waitUntil: 'load' });
  const coletar = s.page.locator('#pollBtn');
  const salvar = s.page.locator('#ev-form button');
  await salvar.waitFor();
  await coletar.dblclick();
  await s.page.waitForSelector('#pollBtn[aria-busy="true"]:disabled');
  const largura = (await salvar.boundingBox()).width;
  await s.page.fill('#ev-text', 'troquei o disco');
  await salvar.dblclick();
  await s.page.waitForSelector('#ev-form button[aria-busy="true"]:disabled');
  assert.equal((await salvar.boundingBox()).width, largura, 'a linha não pula');
  assert.deepEqual(pedidos, { poll: 1, nota: 1 });
  await s.page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await salvar.evaluate((b) => { const e = getComputedStyle(b, '::before'); return [e.animationName, e.width]; }), ['none', '8px'], 'sem rotação, um ponto fixo');
  libera();
  await s.page.waitForSelector('#pollBtn:not([aria-busy]):enabled');
  await s.page.waitForSelector('#ev-form button:not([aria-busy]):enabled');
  assert.deepEqual(pedidos, { poll: 1, nota: 1 });
});

// ADR 0026: a tela entra por CSS só quando muda de verdade. O que redesenha a mesma tela não anima.
const entrada = () => (seletor) => {
  const css = getComputedStyle(document.querySelector(seletor));
  return { nome: css.animationName, duracao: parseFloat(css.animationDuration) };
};
const semEntrada = (page) => page.evaluate(() => {
  const el = document.querySelector('.view');
  el.classList.remove('view-entra');
  el.dataset.velha = '1';
});
const trocouElemento = (page) => page.waitForFunction(() => !document.querySelector('.view')?.dataset.velha);
const temEntrada = (page) => page.evaluate(() => document.querySelector('.view').classList.contains('view-entra'));

test('e2e: troca de tela — entra com a tela nova; amostra do SSE, período e tema não animam', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t, { collect: async () => ({ ok: true, sample: { ...sample(Date.now(), 120), host: 'servidor-novo' } }) });
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.hero');
  while (!s.app.sse.size) await new Promise((r) => setTimeout(r, 20));

  await s.page.keyboard.press('8');
  await s.page.waitForSelector('.view-ajuda');
  assert.ok(await temEntrada(s.page), 'o atalho trocou a tela');
  assert.deepEqual(await s.page.evaluate(entrada(), '.view'), { nome: 'entra', duracao: 0.18 });

  await semEntrada(s.page);
  await s.app.runPoll();
  await s.page.waitForFunction(() => document.body.textContent.includes('servidor-novo'));
  assert.equal(await temEntrada(s.page), false, 'amostra nova não anima');
  assert.equal(await s.page.evaluate(() => document.querySelector('.view').dataset.velha), '1', 'a amostra não monta a tela de novo');

  await s.page.evaluate(() => { location.hash = '#/recursos'; });
  await s.page.waitForSelector('.view-recursos .uplot');
  assert.ok(await temEntrada(s.page), 'o link trocou a tela');

  await semEntrada(s.page);
  await s.page.evaluate(() => { location.hash = '#/recursos?p=7d'; });
  await trocouElemento(s.page);
  assert.equal(await temEntrada(s.page), false, 'trocar o período não anima');

  await semEntrada(s.page);
  await s.page.keyboard.press('t');
  await trocouElemento(s.page);
  assert.equal(await temEntrada(s.page), false, 'trocar o tema não anima');
  assert.deepEqual(s.problems, []);
});

test('e2e: troca de tela — o conteúdo que substitui o esqueleto entra, na tela geral e na Visão geral', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  for (const [hash, conteudo] of [['#/processos', '#pr-rows'], ['#/visao-geral', '#vg-hero .hero']]) {
    let solta;
    const espera = new Promise((r) => { solta = r; });
    await s.page.route('**/api/status', async (rota) => { await espera; await rota.continue(); });
    await s.page.goto(`${s.base}/${hash}`, { waitUntil: 'load' });
    await s.page.reload({ waitUntil: 'load' });
    await s.page.waitForSelector('.view .skel');
    await semEntrada(s.page);
    solta();
    await s.page.waitForSelector(conteudo);
    assert.ok(await temEntrada(s.page), `${hash}: o esqueleto deu lugar ao conteúdo`);
    await s.page.unroute('**/api/status');
  }
});

test('e2e: troca de tela — atalhos em sequência não acumulam, e o gráfico mantém a largura', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.hero');
  for (const tecla of '234567812345') await s.page.keyboard.press(tecla);
  await s.page.waitForSelector('.view-processos');
  assert.equal(await s.page.textContent('#viewTitle'), 'Processos & serviços');
  const telas = await s.page.evaluate(() => ({
    views: document.querySelectorAll('.view').length,
    animacoes: document.querySelector('.view').getAnimations().length,
  }));
  assert.equal(telas.views, 1);
  assert.ok(telas.animacoes <= 1, `${telas.animacoes} animações na tela`);

  // Teclas no mesmo instante: todo hashchange lê a última tela; montar de novo cortaria a entrada.
  await s.page.evaluate(() => { for (const key of '678') document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
  await s.page.waitForSelector('.view-ajuda');
  await s.page.waitForTimeout(100);
  assert.ok(await temEntrada(s.page), 'as teclas seguintes não cortam a entrada');

  // A navegação que esperava os baldes ficou para trás: ela não pode montar a tela de novo.
  let solta;
  const espera = new Promise((r) => { solta = r; });
  const baldes = (url) => url.pathname === '/api/history';
  const pedido = s.page.waitForRequest((r) => r.url().includes('/api/history'));
  await s.page.route(baldes, async (rota) => { await espera; await rota.continue(); });
  await s.page.keyboard.press('3');
  await pedido;
  await s.page.keyboard.press('5');
  await s.page.waitForSelector('.view-processos');
  await semEntrada(s.page);
  const resposta = s.page.waitForResponse((r) => r.url().includes('/api/history'));
  solta();
  await resposta;
  await s.page.waitForTimeout(100);
  assert.equal(await s.page.evaluate(() => document.querySelector('.view').dataset.velha), '1', 'a tecla antiga não monta a tela de novo');
  await s.page.unroute(baldes);

  await s.page.keyboard.press('2');
  await s.page.waitForSelector('.view-recursos .uplot');
  const largura = () => s.page.evaluate(() => document.querySelector('.view .uplot').getBoundingClientRect().width);
  const durante = await largura();
  await s.page.evaluate(() => Promise.all(document.querySelector('.view').getAnimations().map((a) => a.finished)));
  assert.equal(await largura(), durante, 'o deslocamento não muda a largura medida pelo uPlot');
  const transform = await s.page.evaluate(() => getComputedStyle(document.querySelector('.view')).transform);
  assert.equal(transform, 'none', 'ao terminar, a tela não guarda transform');
  assert.deepEqual(s.problems, []);
});

test('e2e: troca de tela — login e diálogo entram igual; o movimento reduzido anula a entrada', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t, { dashToken: 'e'.repeat(43) });
  if (s.skip) return t.skip(s.skip);
  const dialogo = () => s.page.evaluate(() => {
    const d = document.createElement('dialog');
    document.body.append(d);
    d.showModal();
    const css = getComputedStyle(d);
    const r = { nome: css.animationName, duracao: parseFloat(css.animationDuration) };
    d.remove();
    return r;
  });
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('#login:not([hidden])');
  assert.deepEqual(await s.page.evaluate(entrada(), '.login-card'), { nome: 'entra', duracao: 0.18 });
  assert.deepEqual(await dialogo(), { nome: 'entra', duracao: 0.18 });

  await s.page.emulateMedia({ reducedMotion: 'reduce' });
  for (const atual of [await s.page.evaluate(entrada(), '.login-card'), await dialogo()]) {
    assert.equal(atual.nome, 'none');
    assert.ok(atual.duracao < 0.01, `duração ${atual.duracao}`);
  }
  await s.page.fill('#loginToken', 'e'.repeat(43));
  await Promise.all([s.page.waitForNavigation(), s.page.click('#loginSubmit')]);
  await s.page.waitForSelector('.hero');
  await s.page.keyboard.press('2');
  await s.page.waitForSelector('.view-recursos');
  assert.ok(await temEntrada(s.page), 'a classe continua, para o CSS decidir');
  const tela = await s.page.evaluate(entrada(), '.view');
  assert.equal(tela.nome, 'none');
  assert.ok(tela.duracao < 0.01, `duração ${tela.duracao}`);
});

// Posição e altura dos blocos principais da tela, para comparar o esqueleto com o conteúdo.
// Largura para medir o pulo: nela as notas dos cartões cabem em 1 linha. A 1280 px, elas ficam no
// limite da quebra, e quebrar ou não depende do valor do pico, que muda com os baldes da hora.
const LARGA = { width: 1600, height: 900 };
// Relativa à tela: a entrada desloca a tela inteira, e isso não é pulo.
const blocos = (page) => page.evaluate(() => {
  const base = document.querySelector('.view').getBoundingClientRect();
  return [...document.querySelectorAll('.view > *:not(.visually-hidden)')]
    .filter((el) => el.getBoundingClientRect().height > 0)
    .map((el) => { const r = el.getBoundingClientRect(); return { nome: el.className || el.tagName, top: Math.round(r.top - base.top) }; });
});
// Segura um pedido da API até `solta()`. Função sobre o caminho: o glob não pega URL com query.
async function segura(page, caminho) {
  let solta;
  const portao = new Promise((r) => { solta = r; });
  const filtro = (url) => url.pathname === caminho;
  await page.route(filtro, async (rota) => { await portao; await rota.continue(); });
  return { solta, tira: () => page.unroute(filtro) };
}

test('e2e: esqueleto — nas 8 telas fica no formato final: o conteúdo entra sem pulo', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t, { viewport: LARGA });
  if (s.skip) return t.skip(s.skip);
  for (const [id] of VIEWS) {
    const status = await segura(s.page, '/api/status');
    await s.page.goto(`${s.base}/#/${id}`, { waitUntil: 'load' });
    await s.page.reload({ waitUntil: 'load' });
    await s.page.waitForSelector('.view .skel');
    assert.equal(await s.page.getAttribute('#view', 'aria-busy'), '', `${id}: a região avisa que carrega`);
    assert.match(await s.page.textContent('.view .visually-hidden'), /carregando/, `${id}: texto para leitor de tela`);
    const antes = await blocos(s.page);
    status.solta();
    await s.page.waitForFunction(() => !document.querySelector('#view[aria-busy], .view .skel'));
    await status.tira();
    const depois = await blocos(s.page);
    assert.equal(depois.length, antes.length, `${id}: mesmos blocos`);
    depois.forEach((b, i) => assert.ok(Math.abs(b.top - antes[i].top) <= 2, `${id}: ${b.nome} pulou de ${antes[i].top} para ${b.top}`));
  }
  assert.deepEqual(s.problems, []);
});

test('e2e: previsão de lotação (#116) — durante a carga dos 30 dias, a tela não diz "~1 dia"', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  // Segura só os 30 dias da previsão: o período da tela e o resto da carga seguem normais.
  const trintaDias = (url) => url.pathname === '/api/history' && Date.now() - Date.parse(url.searchParams.get('from')) > 20 * 86400e3;
  const telas = [
    ['armazenamento', '#ar-mounts .mount-card', /previsão…/],
    ['visao-geral', '.card-meter-foot', /previsão…/],
  ];
  for (const [id, pronto, neutro] of telas) {
    let solta;
    const portao = new Promise((r) => { solta = r; });
    await s.page.route(trintaDias, async (rota) => { await portao; await rota.continue(); });
    await s.page.goto(`${s.base}/#/${id}`, { waitUntil: 'load' });
    await s.page.reload({ waitUntil: 'load' });
    await s.page.waitForSelector(pronto);
    const texto = await s.page.locator('.view').innerText();
    assert.doesNotMatch(texto, /~1 dia/, `${id}: carga em andamento não afirma nada`);
    assert.match(texto, neutro, `${id}: estado neutro no lugar do selo`);
    const antes = await blocos(s.page);
    solta();
    // O e2e tem só 2 h de amostras: depois da carga, falta histórico de verdade.
    await s.page.waitForFunction(() => document.querySelector('.view').innerText.includes('~1 dia'));
    await s.page.unroute(trintaDias);
    const depois = await blocos(s.page);
    assert.equal(depois.length, antes.length, `${id}: mesmos blocos`);
    depois.forEach((b, i) => assert.ok(Math.abs(b.top - antes[i].top) <= 2, `${id}: ${b.nome} pulou de ${antes[i].top} para ${b.top}`));
  }
  assert.deepEqual(s.problems, []);
});

// Grava na página cada vez que surge ou some um esqueleto visível ou o "atualizando".
const gravaEsperas = (page) => page.addInitScript(() => {
  window.esperas = [];
  let antes = false;
  const olha = () => {
    const agora = [...document.querySelectorAll('.view .skel, .view.atualizando')].some((el) => getComputedStyle(el).visibility === 'visible');
    if (agora !== antes) window.esperas.push({ visivel: agora, ms: performance.now() });
    antes = agora;
    requestAnimationFrame(olha);
  };
  requestAnimationFrame(olha);
});

test('e2e: esqueleto — resposta rápida não mostra esqueleto nem "atualizando"', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await gravaEsperas(s.page);
  await s.page.goto(`${s.base}/#/processos`, { waitUntil: 'networkidle' });
  await s.page.waitForFunction(() => !document.querySelector('#view[aria-busy]') && document.querySelector('#pr-rows'));
  await s.page.evaluate(() => { window.esperas.length = 0; });
  for (const [hash, pronto] of [['#/recursos', '.view-recursos .uplot'], ['#/rede', '.week-bars'], ['#/armazenamento', '[data-chart="ar-fc"] .uplot'], ['#/relatorios', '#rl-table tbody td'], ['#/recursos?p=7d', '.view-recursos .uplot']]) {
    await s.page.evaluate((h) => { location.hash = h; }, hash);
    await s.page.waitForSelector(pronto);
    await s.page.waitForFunction(() => !document.querySelector('#view[aria-busy]'));
    await s.page.waitForTimeout(200);
    assert.deepEqual(await s.page.evaluate(() => window.esperas), [], `${hash}: nada apareceu`);
  }
  assert.deepEqual(s.problems, []);
});

test('e2e: esqueleto — uma vez visível, fica pelo menos o tempo mínimo', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await gravaEsperas(s.page);
  await s.page.goto(`${s.base}/#/processos`, { waitUntil: 'networkidle' });
  await s.page.waitForFunction(() => !document.querySelector('#view[aria-busy]') && document.querySelector('#pr-rows'));
  await s.page.evaluate(() => { window.esperas.length = 0; });
  await s.page.route((url) => url.pathname === '/api/history', async (rota) => {
    await new Promise((r) => { setTimeout(r, 220); });
    await rota.continue();
  });
  await s.page.evaluate(() => { location.hash = '#/recursos'; });
  await s.page.waitForSelector('.view-recursos .uplot');
  const [aparece, some] = await s.page.evaluate(() => window.esperas);
  assert.equal(aparece.visivel, true);
  assert.equal(some.visivel, false);
  assert.ok(some.ms - aparece.ms >= 270, `ficou ${Math.round(some.ms - aparece.ms)} ms`);
  assert.deepEqual(s.problems, []);
});

test('e2e: esqueleto — na troca de período o gráfico fica com os dados velhos, esmaecido e com a faixa', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/#/recursos`, { waitUntil: 'load' });
  await s.page.waitForSelector('.view-recursos .uplot');
  await s.page.waitForFunction(() => !document.querySelector('#view[aria-busy]'));
  const canvas = await s.page.evaluateHandle(() => document.querySelector('[data-chart="rc-cpu"] canvas'));
  const baldes = await segura(s.page, '/api/history');
  await s.page.click('[data-period="7d"]');
  // Os baldes estão presos: o botão responde antes deles (o hashchange só chega no tique seguinte).
  await s.page.waitForSelector('[data-period="7d"][aria-pressed="true"]', { timeout: 2000 });
  await s.page.waitForSelector('.view.atualizando');
  const estado = () => s.page.evaluate(() => {
    const painel = document.querySelector('.panel > [data-chart="rc-cpu"]');
    const faixa = getComputedStyle(painel, '::before');
    const faixas = getComputedStyle(document.querySelector('.view .strips'), '::before');
    return {
      opacidade: Number(getComputedStyle(painel.querySelector('.uplot')).opacity), faixa: faixa.animationName, altura: faixa.height,
      faixas: faixas.animationName, esqueleto: document.querySelector('.view .skel') !== null, ocupada: document.getElementById('view').hasAttribute('aria-busy'),
      aviso: document.querySelector('.view > .visually-hidden')?.textContent,
    };
  });
  await s.page.waitForTimeout(200);
  assert.deepEqual(await estado(), { opacidade: 0.5, faixa: 'atualizando', altura: '2px', faixas: 'atualizando', esqueleto: false, ocupada: true, aviso: 'carregando' });
  assert.equal(await canvas.evaluate((c) => c.isConnected), true, 'o mesmo gráfico continua na tela');
  baldes.solta();
  await s.page.waitForFunction(() => !document.querySelector('.view.atualizando, #view[aria-busy]'));
  await baldes.tira();
  assert.equal(await temEntrada(s.page), false, 'trocar de período não é trocar de tela');
  assert.ok(await s.page.locator('[data-chart="rc-cpu"] .uplot').count());
  assert.deepEqual(s.problems, []);
});

test('e2e: esqueleto — região que carrega depois guarda o espaço, e sair no meio não quebra', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t, { viewport: LARGA });
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/#/processos`, { waitUntil: 'networkidle' });
  await s.page.waitForSelector('#pr-rows');
  // A 1ª resposta (baldes do período) passa; a dos 7 dias fica presa.
  let solta;
  const portao = new Promise((r) => { solta = r; });
  const semana = (url) => url.pathname === '/api/history' && url.searchParams.get('limit') === '168';
  await s.page.route(semana, async (rota) => { await portao; await rota.continue(); });
  await s.page.evaluate(() => { location.hash = '#/rede'; });
  await s.page.waitForSelector('#rd-week .esqueleto', { state: 'attached' });
  await s.page.waitForSelector('#rd-week .esqueleto:not(.oculto) .skel');
  assert.equal(await s.page.getAttribute('#rd-week .esqueleto', 'aria-busy'), 'true');
  assert.match(await s.page.textContent('#rd-week'), /carregando/);
  const antes = await blocos(s.page);
  solta();
  await s.page.waitForSelector('#rd-week .week-bars');
  await s.page.unroute(semana);
  assert.deepEqual((await blocos(s.page)).map((b) => b.top), antes.map((b) => b.top));
  // Sair com o pedido no ar: a resposta tardia não mexe na tela nova nem dá erro.
  let soltaSaida;
  const portaoSaida = new Promise((r) => { soltaSaida = r; });
  const filtro = (url) => url.pathname === '/api/history' && url.searchParams.get('limit') === '720';
  await s.page.route(filtro, async (rota) => { await portaoSaida; await rota.continue(); });
  await s.page.evaluate(() => { location.hash = '#/armazenamento'; });
  await s.page.waitForSelector('#ar-fc-skel .esqueleto:not(.oculto)');
  await s.page.evaluate(() => { location.hash = '#/ajuda'; });
  await s.page.waitForSelector('.view-ajuda');
  soltaSaida();
  await s.page.waitForTimeout(150);
  assert.equal(await s.page.locator('.view-ajuda').count(), 1);
  assert.deepEqual(s.problems, []);
});

test('e2e: esqueleto — Relatórios mantém o resumo até o atraso e mostra blocos no período novo', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/#/relatorios`, { waitUntil: 'load' });
  await s.page.waitForSelector('#rl-table tbody td:not(:has(.skel))');
  const baldes = await segura(s.page, '/api/history');
  await s.page.click('[data-days="30"]');
  assert.equal(await s.page.locator('#rl-cards .skel').count(), 0, 'antes do atraso, o resumo velho continua');
  assert.equal(await s.page.getAttribute('[data-days="30"]', 'aria-pressed'), 'true');
  await s.page.waitForSelector('#rl-cards .esqueleto:not(.oculto) .skel');
  assert.equal(await s.page.locator('#rl-table tbody tr').count(), 31, '1 linha por dia do período');
  baldes.solta();
  await s.page.waitForFunction(() => !document.querySelector('.view .skel'));
  await baldes.tira();
  assert.equal(await s.page.locator('#rl-table tbody tr').count(), 31);
  assert.deepEqual(s.problems, []);
});

test('e2e: esqueleto — com movimento reduzido nada pulsa nem corre', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.emulateMedia({ reducedMotion: 'reduce' });
  const status = await segura(s.page, '/api/status');
  await s.page.goto(`${s.base}/#/recursos`, { waitUntil: 'load' });
  await s.page.waitForSelector('.view .skel');
  // Sem animação ativa, cada bloco fica com a aparência final: parado e inteiro.
  await s.page.waitForTimeout(50);
  const rodando = () => s.page.evaluate(() => document.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length);
  assert.equal(await rodando(), 0);
  status.solta();
  await s.page.waitForSelector('.view-recursos .uplot');
  await status.tira();
  await s.page.waitForFunction(() => !document.querySelector('#view[aria-busy]'));
  const baldes = await segura(s.page, '/api/history');
  await s.page.click('[data-period="7d"]');
  await s.page.waitForSelector('.view.atualizando');
  await s.page.waitForTimeout(50);
  assert.equal(await rodando(), 0);
  const largura = await s.page.evaluate(() => getComputedStyle(document.querySelector('.panel > [data-chart="rc-cpu"]'), '::before').transform);
  assert.equal(largura, 'none', 'a faixa fica inteira');
  baldes.solta();
  await s.page.waitForFunction(() => !document.querySelector('.view.atualizando'));
  await baldes.tira();
  assert.deepEqual(s.problems, []);
});

test('e2e: esqueleto — sem a configuração, a Ajuda diz que falhou em vez de pulsar para sempre', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.route((url) => url.pathname === '/api/config', (rota) => rota.abort());
  await s.page.goto(`${s.base}/#/ajuda`, { waitUntil: 'load' });
  await s.page.waitForFunction(() => /Configuração indisponível/.test(document.getElementById('aj-config')?.textContent));
  assert.equal(await s.page.locator('.view .skel').count(), 0);
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
  await sobe(s.page, '#loginSubmit');
  await s.page.fill('#loginToken', 'errado');
  await s.page.click('#loginSubmit');
  await s.page.waitForFunction(() => /Token incorreto/.test(document.getElementById('loginError').textContent));
  assert.equal(await s.page.getAttribute('#loginToken', 'aria-invalid'), 'true');
  await s.page.fill('#loginToken', token);
  await Promise.all([s.page.waitForNavigation(), s.page.click('#loginSubmit')]);
  await s.page.waitForSelector('.hero');
  assert.equal(await s.page.$eval('#login', (el) => el.hidden), true);
  assert.deepEqual(s.problems.filter((p) => !/401/.test(p)), [], 'só os 401 esperados antes do login');
});

test('e2e: celular (390 px) — menu abre, navega e fecha; sem rolagem horizontal', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t, { viewport: { width: 390, height: 844 } });
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.hero');
  assert.equal(await s.page.isVisible('#side .nav-item'), false, 'menu começa fechado');
  await s.page.click('#navToggle');
  await s.page.waitForFunction(() => document.body.classList.contains('nav-open'));
  assert.equal(await s.page.getAttribute('#navToggle', 'aria-expanded'), 'true');
  await s.page.click('#side a[href^="#/recursos"]');
  await s.page.waitForFunction(() => document.querySelector('.view-recursos'));
  assert.equal(await s.page.evaluate(() => document.body.classList.contains('nav-open')), false, 'menu fecha ao navegar');
  assert.equal(await s.page.textContent('#mobileTitle'), 'Recursos');
  const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `sem rolagem horizontal (${overflow} px)`);
  await s.page.emulateMedia({ reducedMotion: 'reduce' });
  const dur = await s.page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('side')).transitionDuration));
  assert.ok(dur < 0.01, `"reduzir movimento" desliga as transições (${dur}s)`);
  assert.deepEqual(s.problems, []);
});

test('e2e: tema claro — telas abrem, gráficos recriados com as cores do tema e sem erros', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.addInitScript(() => localStorage.setItem('dash_theme', 'light'));
  await s.page.goto(`${s.base}/#/recursos`, { waitUntil: 'load' });
  await s.page.waitForFunction(() => document.querySelectorAll('.uplot').length >= 6);
  assert.equal(await s.page.evaluate(() => document.documentElement.dataset.theme), 'light');
  const bg = await s.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(243, 245, 248)', 'fundo do tema claro');
  await s.page.keyboard.press('t');
  await s.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.querySelectorAll('.uplot').length >= 6);
  assert.deepEqual(s.problems, []);
});

test('e2e: servidor inacessível — faixa crítica, manchete e últimos valores em cinza', { skip: !chromium && 'sem playwright-core' }, async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.app.runPoll();
  await s.app.runPoll(); // 2 falhas seguidas = inacessível (ALERT_OFFLINE_AFTER)
  await s.page.goto(`${s.base}/`, { waitUntil: 'load' });
  await s.page.waitForSelector('.hero-crit');
  assert.match(await s.page.locator('#strip').innerText(), /OFFLINE/);
  assert.match(await s.page.locator('.hero').innerText(), /Servidor inacessível[\s\S]*última coleta boa/);
  assert.equal(await s.page.evaluate(() => document.body.classList.contains('is-offline')), true);
  assert.deepEqual(s.problems, []);
});
