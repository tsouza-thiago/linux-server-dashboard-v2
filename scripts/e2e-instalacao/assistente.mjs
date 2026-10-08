// Passa pelos 6 passos do assistente no Chromium contra uma instalação de verdade
// (rodar.sh): node assistente.mjs <url-com-#codigo> <porta-ssh> <pasta-capturas>
import { chromium } from 'playwright-core';

const [, , url, sshPort, outDir] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));
page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) problems.push(m.text()); });
const shot = async (name) => { if (outDir) await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true }); console.log(`✓ ${name}`); };
await page.goto(url);
await page.waitForSelector('.wz-chk');
await shot('1-boas-vindas');
await page.click('text=Começar');
await page.fill('#host', '127.0.0.1');
await page.fill('#user', 'maria');
await page.click('summary');
await page.fill('#port', sshPort);
await page.click('[data-act="servidor"]');
await page.waitForSelector('.wz-fp span');
await shot('3-conectar');
await page.check('#confio');
await page.fill('#senha', 'senha-de-teste');
await page.click('[data-act="conectar"]');
await page.waitForSelector('.wz-row');
await shot('4-monitorar');
await page.click('[data-act="escolhas"]');
await page.waitForSelector('.wz-act');
await page.click('[data-act="preparar"]');
await page.waitForSelector('.wz-done', { timeout: 90000 });
await shot('5-concluido');
await page.click('[data-go="6"]');
await page.waitForSelector('.wz-hero');
await shot('6-pronto');
await page.click('[data-act="abrir"]');
await page.waitForURL((u) => !u.pathname.startsWith('/configurar'), { timeout: 60000 });
await page.waitForSelector('#strip', { timeout: 30000 });
await page.waitForFunction(() => /online/i.test(document.querySelector('#strip')?.textContent || ''), null, { timeout: 90000 });
await shot('7-painel');
console.log('URL final:', page.url());
await browser.close();
if (problems.length) { console.error('problemas:', problems); process.exit(1); }
