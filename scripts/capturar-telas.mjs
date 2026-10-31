#!/usr/bin/env node
// Refaz as imagens do README e do TUTORIAL (F11, #106) em docs/img/: as 8 telas nos 2 temas,
// o login, os 6 passos do assistente, a animação curta e os SVG. Tudo sai do painel de teste
// (scripts/painel-teste.mjs), com dados inventados numa pasta temporária: nada de SSH, nada
// de data/, nada do .env.
//
//   CHROMIUM=/usr/bin/google-chrome npm run capturar-telas
//   npm run capturar-telas -- --sem-animacao      # só os prints e os SVG
//
// Os prints saem em WebP pelo próprio Chromium, sem dependência nova. A animação precisa do
// ffmpeg no computador (só de quem roda este script). Um print acima do orçamento ou um dado
// desta máquina no texto da tela faz o script falhar.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { semear, criarPainel, criarAssistente, coletorFalso, FIXTURE } from './painel-teste.mjs';
import { desenharGraficos, PASTA_IMG } from './desenhar-graficos.mjs';

const MIN = 60000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const LIMITE_PRINT = 200 * 1024; // orçamento da F11; o teste docs.test.js confere o mesmo
const TELA = { width: 1360, height: 980 };
const QUALIDADE = 82;
const TELAS = ['visao-geral', 'recursos', 'armazenamento', 'rede', 'processos', 'eventos', 'relatorios', 'ajuda'];
const TEMAS = { escuro: 'dark', claro: 'light' };
// Fuso e idioma fixos: o print não depende do computador de quem roda o script.
const CONTEXTO = { viewport: TELA, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' };

/* ---------------------------------- dados de vitrine ---------------------------------- */

const onda = (min, periodo, fase = 0) => Math.sin((2 * Math.PI * min) / periodo + fase);
// Pseudoaleatório fixo por minuto: 2 execuções geram a mesma curva.
const ruido = (min, semente = 0) => { const x = Math.sin(min * 12.9898 + semente) * 43758.5453; return x - Math.floor(x); };
// Integral de base × (1 + amp × seno): contadores crescem sem depender da coleta anterior, então
// os agregados a cada 5 min e as amostras a cada minuto ficam na mesma curva.
const acumulado = (min, base, amp, periodo) => base * min - (base * amp * periodo * Math.cos((2 * Math.PI * min) / periodo)) / (2 * Math.PI);
const DISCOS = { '/dev/sda2': [0.41, 0.0004], '/dev/sdb1': [0.72, 0.0035], '/dev/sdc1': [0.38, 0.0006], '/dev/sdc2': [0.33, 0] };
const IO = { sda: 1, sdb: 0.5, sdc: 0.25 };
const PROCESSOS = { processo1: 'sshd', processo2: 'smbd', processo3: 'nmbd', processo4: 'rsync', processo5: 'cron', processo6: 'systemd-journald' };

/**
 * Saída de um servidor saudável com dia e noite: CPU, memória, rede e disco oscilam, um disco
 * enche devagar (para a previsão ter o que mostrar), há um pico de temperatura e uma queda.
 */
function saidaVitrine({ agora, pico, queda }) {
  const inicio = agora - 34 * DIA;
  return (now) => {
    if (now >= queda.de && now < queda.ate) return null;
    const min = Math.floor(now / MIN);
    const dias = (now - agora) / DIA;
    const us = Math.round(acumulado(min, 420, 0.6, 1440) + ruido(min) * 170);
    const sy = Math.round(acumulado(min, 160, 0.4, 1440) + ruido(min, 1) * 60);
    const io = Math.round(acumulado(min, 70, 0.7, 720) + ruido(min, 2) * 30);
    const temp = 41 + 4 * onda(min, 1440) + ruido(min, 3) * 1.5 + (now >= pico && now < pico + HORA ? 20 : 0);
    const avail = 430000 + 90000 * onda(min, 1440, 2) + ruido(min, 4) * 20000;
    const rx = Math.round(acumulado(min, 4.0e7, 0.7, 1440) + acumulado(min, 1.5e7, 0.5, 7200) + ruido(min, 5) * 1.2e7);
    const tx = Math.round(acumulado(min, 1.2e7, 0.6, 1440) + ruido(min, 6) * 4e6);
    return FIXTURE
      .replace(/(===UPTIME===\n)[\d.]+/, (_, a) => `${a}${Math.round((now - inicio) / 1000)}`)
      .replace(/(===LOAD===\n)[\d.]+/, (_, a) => `${a}${(0.3 + 0.2 * onda(min, 1440) + ruido(min, 7) * 0.15).toFixed(2)}`)
      .replace(/^cpu\s+\d+ \d+ \d+ \d+ \d+/m, `cpu  ${us} 0 ${sy} ${6000 * min - us - sy - io} ${io}`)
      .replace(/(MemAvailable:\s+)\d+/, (_, a) => `${a}${Math.round(avail)}`)
      .replace(/(SwapFree:\s+)\d+/, (_, a) => `${a}867000`)
      .replace(/^(\/dev\/\w+)(\s+\S+\s+)(\d+) \s*\d+\s+\d+\s+\d+%/gm, (_, dev, meio, total) => {
        const [base, porDia] = DISCOS[dev];
        const usado = Math.round(Number(total) * (base + porDia * dias));
        return `${dev}${meio}${total} ${usado} ${Number(total) - usado} ${Math.ceil((usado / total) * 100)}%`;
      })
      .replace(/^enp0s7:.*$/m, (l) => { const c = l.split(/\s+/); c[1] = rx; c[9] = tx; return c.join(' '); })
      .replace(/^(\s+\d+\s+\d+ )(sd[abc]) (.*)$/gm, (_, ini, dev, resto) => {
        const k = IO[dev];
        const c = resto.split(' ').map(Number);
        const lidos = Math.round(acumulado(min, 30000 * k, 0.7, 1440));
        const gravados = Math.round(acumulado(min, 14000 * k, 0.5, 720));
        c[0] += Math.round(lidos / 64); c[2] += lidos; c[3] += Math.round(lidos / 12);
        c[4] += Math.round(gravados / 32); c[6] += gravados; c[7] += Math.round(gravados / 5);
        c[9] += Math.round(acumulado(min, 3500 * k, 0.6, 1440));
        return `${ini}${dev} ${c.join(' ')}`;
      })
      .replace(/^(cpu some avg10=)[\d.]+/m, (_, a) => `${a}${(3 + 2 * onda(min, 1440) + ruido(min, 8)).toFixed(2)}`)
      .replace(/^(io some avg10=)[\d.]+/m, (_, a) => `${a}${(2 + 1.5 * onda(min, 720) + ruido(min, 9)).toFixed(2)}`)
      .replace(/^(acpitz )\d+/m, (_, a) => `${a}${Math.round(temp * 1000)}`)
      .replace(/\/usr\/bin\/(processo\d)/g, (_, p) => `/usr/sbin/${PROCESSOS[p]}`);
  };
}

/** Pico de temperatura, queda, alertas e anotações: a história que a tela de Eventos conta. */
async function montarVitrine(dir) {
  const agora = Date.now();
  const pico = agora - 30 * HORA;
  const queda = { de: agora - 50 * HORA, ate: agora - 50 * HORA + 18 * MIN };
  const falso = coletorFalso(saidaVitrine({ agora, pico, queda }));
  // Sem SSH, o tempo da coleta seria 0: aqui ele fica perto do medido no servidor (AGENTS.md).
  const coletar = async (t) => {
    const r = await falso(t);
    if (r.ok) r.sample.collector.durationMs = 1250 + Math.round(ruido(t / MIN, 10) * 80);
    return r;
  };
  await semear(dir, 'normal', { agora, coletor: coletar });
  const painel = criarPainel(dir, 'normal', coletar, { sshAccess: 'restrito' });
  const { alertsStore: alertas, annotationsStore: anotacoes, outages } = painel;
  outages.start(queda.de, 'servidor desligado para manutenção');
  outages.end(queda.ate);
  const relogio = alertas.now;
  alertas.now = () => pico + 2 * MIN;
  const { id } = alertas.add({ level: 'warning', message: 'Temperatura CPU 65.3°C', key: 'temp:cpu', value: 65.3 });
  alertas.now = () => pico + HORA + 3 * MIN;
  alertas.setStatus(id, 'resolved');
  alertas.now = relogio;
  anotacoes.add({ ts: new Date(queda.de).toISOString(), text: 'Manutenção: troca do nobreak', label: 'manutenção' });
  anotacoes.add({ ts: new Date(pico + 50 * MIN).toISOString(), text: 'Limpei o cooler', label: 'hardware' });
  await painel.runPoll();
  return painel;
}

/* --------------------------------------- captura --------------------------------------- */

const ouvir = (app) => new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const fechar = (s) => new Promise((ok) => { s.close(ok); s.closeAllConnections?.(); });
const relatorio = [];
const problemas = [];

// O que não pode aparecer num print. A conferência à mão continua valendo: esta só lê o texto.
const PROIBIDO = [os.hostname(), os.homedir(), os.userInfo().username, os.tmpdir()].filter((x) => x && x !== '/tmp');

/** Grava o print da janela em WebP, depois de conferir o texto da tela. */
async function print(page, nome) {
  await page.evaluate(() => document.fonts.ready);
  const texto = await page.evaluate(() => document.body.innerText);
  for (const p of PROIBIDO) if (texto.includes(p)) problemas.push(`${nome}: o texto da tela contém um dado desta máquina`);
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: QUALIDADE });
  await cdp.detach();
  const buf = Buffer.from(data, 'base64');
  if (buf.length > LIMITE_PRINT) problemas.push(`${nome}: ${Math.round(buf.length / 1024)} KB, acima do orçamento`);
  fs.writeFileSync(path.join(PASTA_IMG, `${nome}.webp`), buf);
  relatorio.push(`${nome}.webp ${Math.round(buf.length / 1024)} KB`);
}

async function novaPagina(browser, tema, extra = {}) {
  // Movimento reduzido: o print não pega nenhuma transição no meio.
  const ctx = await browser.newContext({ ...CONTEXTO, reducedMotion: 'reduce', ...extra });
  await ctx.addInitScript((t) => localStorage.setItem('dash_theme', t), TEMAS[tema]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problemas.push(`erro de JS: ${e.message}`));
  return page;
}

async function capturarTelas(browser, url) {
  for (const tema of Object.keys(TEMAS)) {
    const page = await novaPagina(browser, tema);
    for (const tela of TELAS) {
      await page.goto(`${url}/#/${tela}?p=72h`);
      await page.waitForSelector('main, #app');
      await page.waitForTimeout(1500); // o SSE, os baldes e o uPlot terminam de desenhar
      await print(page, `${tela}-${tema}`);
    }
    await page.context().close();
  }
}

async function capturarLogin(browser) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-telas-login-'));
  // Token de mentira: serve só para o painel pedir login.
  const painel = criarPainel(dir, 'vazio', async () => ({ ok: false, error: 'sem coleta' }), { dashToken: 'token-de-vitrine' });
  const srv = await ouvir(painel.app);
  const page = await novaPagina(browser, 'escuro');
  await page.goto(base(srv));
  await page.waitForTimeout(800);
  await print(page, 'login');
  await page.context().close();
  await fechar(srv);
  await painel.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Os 6 passos, com o servidor falso de scripts/painel-teste.mjs (IP de documentação). */
async function capturarAssistente(browser) {
  const { app, cleanup } = criarAssistente();
  const srv = await ouvir(app);
  const page = await novaPagina(browser, 'escuro');
  await page.goto(`${base(srv)}/configurar#codigo=ACD-347`);
  await page.waitForSelector('.wz-chk');
  await print(page, 'assistente-1-boas-vindas');
  await page.click('text=Começar');
  await page.fill('#host', '192.0.2.10');
  await page.fill('#user', 'maria');
  await print(page, 'assistente-2-servidor');
  await page.click('[data-act="servidor"]');
  await page.waitForSelector('.wz-fp span');
  await page.check('#confio');
  await print(page, 'assistente-3-conectar');
  await page.fill('#senha', 'certa');
  await page.click('[data-act="conectar"]');
  await page.waitForSelector('.wz-row');
  await print(page, 'assistente-4-monitorar');
  await page.click('[data-act="escolhas"]');
  await page.waitForSelector('.wz-act');
  await print(page, 'assistente-5-preparar');
  await page.click('[data-act="preparar"]');
  await page.waitForSelector('.wz-done');
  await page.click('[data-go="6"]');
  await page.waitForSelector('.wz-hero');
  await print(page, 'assistente-6-pronto');
  await page.context().close();
  await fechar(srv);
  cleanup();
}

/** Animação curta: o mouse passa pelo menu, troca de tela e percorre um gráfico. */
async function gravarAnimacao(browser, url) {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('Sem ffmpeg: a animação fica como está.'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-telas-animacao-'));
  const ctx = await browser.newContext({ ...CONTEXTO, viewport: { width: 1280, height: 780 } });
  await ctx.addInitScript(() => localStorage.setItem('dash_theme', 'dark'));
  const page = await ctx.newPage();
  await page.goto(`${url}/#/visao-geral?p=72h`);
  await page.waitForTimeout(1500);
  // O print não mostra o cursor do sistema: um círculo acompanha o mouse. Vai pelo CSSOM (CSP).
  await page.evaluate(() => {
    const c = document.createElement('div');
    Object.assign(c.style, { position: 'fixed', width: '18px', height: '18px', margin: '-9px', borderRadius: '50%', background: 'rgba(62,224,208,.75)', border: '2px solid #fff', pointerEvents: 'none', zIndex: 99999 });
    document.documentElement.append(c);
    addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
  });
  const cdp = await ctx.newCDPSession(page);
  const quadros = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const arq = path.join(dir, `q${String(quadros.length).padStart(4, '0')}.jpg`);
    fs.writeFileSync(arq, Buffer.from(data, 'base64'));
    quadros.push({ arq, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await page.mouse.move(600, 300);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  for (const tela of ['recursos', 'armazenamento', 'rede']) {
    const caixa = await page.locator(`a[href="#/${tela}"], [href*="#/${tela}"]`).first().boundingBox();
    await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2, { steps: 14 });
    await page.waitForTimeout(350);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(1300);
  }
  const grafico = await page.locator('.uplot').first().boundingBox();
  await page.mouse.move(grafico.x + 80, grafico.y + grafico.height / 2, { steps: 8 });
  await page.mouse.move(grafico.x + grafico.width - 80, grafico.y + grafico.height / 2, { steps: 30 });
  await page.waitForTimeout(600);
  await cdp.send('Page.stopScreencast');
  await ctx.close();
  // Cada quadro fica na tela até o próximo: o screencast só manda quadro quando algo muda.
  const lista = quadros.map((q, i) => `file '${q.arq}'\nduration ${(quadros[i + 1]?.t ?? q.t + 1) - q.t}`).join('\n');
  fs.writeFileSync(path.join(dir, 'lista.txt'), `${lista}\nfile '${quadros.at(-1).arq}'\n`);
  const saida = path.join(PASTA_IMG, 'animacao.webp');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'lista.txt'),
    '-vf', 'fps=10,scale=880:-2', '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', '60', '-compression_level', '6', '-loop', '0', saida]);
  if (r.status !== 0) problemas.push(`ffmpeg: ${r.stderr}`);
  else relatorio.push(`animacao.webp ${Math.round(fs.statSync(saida).size / 1024)} KB`);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  desenharGraficos();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-telas-'));
  const painel = await montarVitrine(dir);
  const srv = await ouvir(painel.app);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  try {
    await capturarTelas(browser, base(srv));
    await capturarLogin(browser);
    await capturarAssistente(browser);
    if (!process.argv.includes('--sem-animacao')) await gravarAnimacao(browser, base(srv));
  } finally {
    await browser.close();
    await fechar(srv);
    await painel.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(relatorio.join('\n'));
  if (problemas.length) throw new Error(`\n${[...new Set(problemas)].join('\n')}`);
}

main().catch((err) => { console.error(`ERRO: ${err.message}`); process.exit(1); });
