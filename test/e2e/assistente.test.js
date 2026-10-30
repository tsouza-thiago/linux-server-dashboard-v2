// Assistente de instalação no Chromium : os 6 passos, nos
// modos assistido e manual, nos 2 temas e no celular, sem erro de JavaScript nem violação
// de CSP. Servidor, ssh e systemd são falsos (test-support/instalacao-fake.js); o caminho
// real é testado contra contêineres Debian/Ubuntu (scripts/e2e-instalacao/rodar.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWizardApp } from '../../server/setup/web.js';
import { listen, close } from '../../test-support/request.js';
import { makeInstalacao, detectionWithSudo } from '../../test-support/instalacao-fake.js';
import { APERTADO, pressiona, semHover, sobe } from '../../test-support/hover.js';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch { /* sem playwright-core */ }
// No CI (E2E_OBRIGATORIO=1) o e2e não pode pular calado: sem navegador, a suíte falha.
const OBRIGATORIO = process.env.E2E_OBRIGATORIO === '1';
if (OBRIGATORIO && !chromium) throw new Error('E2E_OBRIGATORIO=1, mas o playwright-core não está instalado');

async function setup(t, { viewport, theme, server } = {}) {
  if (!chromium) return { skip: 'playwright-core não instalado' };
  const fake = makeInstalacao(server);
  const finished = [];
  const app = createWizardApp({ inst: fake.inst, code: 'ACD347', onFinish: (p) => finished.push(p) });
  const { server: http, port } = await listen(app);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  } catch (err) {
    await close(http);
    fake.cleanup();
    if (OBRIGATORIO) throw err;
    return { skip: `Chromium indisponível: ${err.message.split('\n')[0]}` };
  }
  const page = await browser.newPage({ viewport: viewport || { width: 1280, height: 900 } });
  if (theme) await page.addInitScript((th) => localStorage.setItem('dash_theme', th), theme);
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  t.after(async () => { await browser.close(); await close(http); fake.cleanup(); });
  return { ...fake, page, port, problems, finished, base: `http://127.0.0.1:${port}` };
}

async function throughStep4(s) {
  await s.page.goto(`${s.base}/configurar#codigo=ACD-347`);
  await s.page.waitForSelector('.wz-chk');
  await s.page.click('text=Começar');
  await s.page.fill('#host', '192.0.2.10');
  await s.page.fill('#user', 'maria');
  await s.page.click('[data-act="servidor"]');
  await s.page.waitForSelector('.wz-fp span');
  assert.equal(await s.page.isDisabled('[data-act="conectar"]'), true, 'sem confirmar a identidade, Conectar fica desligado');
  await s.page.check('#confio');
  await s.page.fill('#senha', 'certa');
  await s.page.click('[data-act="conectar"]');
  await s.page.waitForSelector('.wz-row');
}

test('assistente e2e: hover e clique — todo clicável dos passos responde, e o botão solto sobe e encolhe', async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  const CLICAVEIS = 'a, button, summary, .wz-radio, .wz-svc, .wz-from, .wz-switch, .wz-row';
  await s.page.goto(`${s.base}/configurar#codigo=ACD-347`);
  await s.page.waitForSelector('.wz-chk');
  await sobe(s.page, '.wz-next');
  assert.equal((await pressiona(s.page, '.wz-next')).transform, APERTADO, '.wz-next');
  assert.deepEqual(await semHover(s.page, CLICAVEIS), [], 'passo 1');
  await s.page.click('text=Começar');
  await s.page.waitForSelector('#host');
  assert.deepEqual(await semHover(s.page, CLICAVEIS), [], 'passo 2');
  await s.page.fill('#host', '192.0.2.10');
  await s.page.fill('#user', 'maria');
  await s.page.click('[data-act="servidor"]');
  await s.page.waitForSelector('.wz-fp span');
  await sobe(s.page, '.wz-eye');
  assert.equal((await pressiona(s.page, '.wz-eye')).transform, APERTADO, '.wz-eye');
  assert.deepEqual(await semHover(s.page, CLICAVEIS), [], 'passo 3');
  await s.page.check('#confio');
  await s.page.fill('#senha', 'certa');
  await s.page.click('[data-act="conectar"]');
  await s.page.waitForSelector('.wz-row');
  await sobe(s.page, '.wz-back');
  assert.equal((await pressiona(s.page, '.wz-back')).transform, APERTADO, '.wz-back');
  assert.deepEqual(await semHover(s.page, CLICAVEIS), [], 'passo 4');
  await s.page.click('[data-act="escolhas"]');
  await s.page.waitForSelector('.wz-act');
  assert.deepEqual(await semHover(s.page, CLICAVEIS), [], 'passo 5');
});

test('assistente e2e: modo assistido do passo 1 ao "Abrir o painel"', async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/configurar#codigo=ACD-347`);
  await s.page.waitForSelector('h1');
  assert.equal(new URL(s.page.url()).hash, '', 'o código sai da barra de endereço');
  assert.equal(await s.page.textContent('h1'), 'Vamos ligar o painel ao seu servidor');
  assert.equal(await s.page.textContent('#wzMeta'), 'passo 1 de 6 · cerca de 5 minutos');
  assert.equal(await s.page.locator('.wz-steps li').count(), 6);
  await s.page.click('text=Começar');
  await s.page.fill('#host', 'a b');
  await s.page.fill('#user', 'maria');
  await s.page.click('[data-act="servidor"]');
  await s.page.waitForSelector('#hostErr');
  assert.equal(await s.page.getAttribute('#host', 'aria-invalid'), 'true');
  await s.page.fill('#host', '192.0.2.10');
  await s.page.click('[data-act="servidor"]');
  await s.page.waitForSelector('.wz-fp span');
  assert.equal(await s.page.locator('.wz-fp span').first().textContent(), '8oOm');
  await s.page.check('#confio');
  await s.page.fill('#senha', 'errada');
  await s.page.click('[data-act="conectar"]');
  await s.page.waitForSelector('.wz-alert');
  assert.match(await s.page.textContent('.wz-alert'), /recusou a entrada/);
  await s.page.fill('#senha', 'certa');
  await s.page.click('[data-act="conectar"]');
  await s.page.waitForSelector('.wz-row');
  assert.match(await s.page.textContent('#wzMeta'), /conectado a 192\.0\.2\.10 como maria · sudo disponível/);
  assert.equal(await s.page.locator('.wz-row').count(), 4);
  assert.equal(await s.page.isChecked('[data-mount="/boot/efi"]'), false, '/boot/efi não vem marcado');
  await s.page.uncheck('[data-svc="docker"]');
  await s.page.waitForTimeout(400);
  assert.equal(await s.page.locator('.wz-sum > div').nth(3).locator('span').last().textContent(), '3');
  await s.page.click('[data-act="escolhas"]');
  await s.page.waitForSelector('.wz-act');
  assert.equal(await s.page.locator('.wz-act').count(), 6);
  assert.match(await s.page.textContent('.wz-pre'), /command="…coleta v2 · [0-9a-f]{6}…"/);
  await s.page.click('[data-act="preparar"]');
  await s.page.waitForSelector('.wz-done');
  assert.equal(await s.page.locator('.wz-act.is-done').count(), 6);
  await s.page.click('[data-go="6"]');
  await s.page.waitForSelector('.wz-hero');
  assert.match(await s.page.textContent('.wz-read'), /71%/);
  assert.deepEqual(await semHover(s.page, 'a, button, summary, .wz-switch'), [], 'passo 6');
  await s.page.click('[data-act="token"]');
  await s.page.waitForSelector('.wz-token code');
  await s.page.uncheck('[data-pref="shortcut"]');
  await s.page.click('[data-act="abrir"]');
  await s.page.waitForFunction(() => document.querySelector('[data-act="abrir"]')?.disabled);
  await s.page.waitForTimeout(300);
  assert.deepEqual(s.finished, [{ iniciarComComputador: true, atalho: false }]);
  // 400 e 422 acima são os erros provocados de propósito (endereço e senha errados).
  assert.deepEqual(s.problems.filter((p) => !/status of 4(00|22)/.test(p)), []);
});

test('assistente e2e modo chave (#61): apelido, ssh-add quando falta e a senha do sudo à parte', async (t) => {
  const s = await setup(t, { server: { detection: detectionWithSudo('pede-senha') } });
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/configurar#codigo=ACD-347`);
  await s.page.click('text=Começar');
  await s.page.click('[data-acesso="chave"]');
  assert.equal(await s.page.getAttribute('[data-acesso="chave"]', 'aria-pressed'), 'true');
  assert.equal(await s.page.locator('#host').count(), 0, 'no modo chave, o endereço vem do apelido');
  assert.equal(await s.page.isDisabled('[data-act="servidor"]'), true, 'Continuar só depois de ler o apelido');
  await s.page.fill('#apelido', 'com-salto');
  await s.page.click('[data-act="apelido"]');
  await s.page.waitForSelector('#apelidoErr');
  assert.match(await s.page.textContent('#apelidoErr'), /ProxyJump/);
  await s.page.fill('#apelido', 'meu-servidor');
  await s.page.click('[data-act="apelido"]');
  await s.page.waitForSelector('text=Confira o que o apelido meu-servidor diz');
  assert.match(await s.page.textContent('.wz-sum'), /192\.0\.2\.10.*2222.*maria.*\/home\/maria\/\.ssh\/chave_admin/s);
  await s.page.click('[data-act="servidor"]');
  await s.page.waitForSelector('.wz-fp span');
  assert.equal(await s.page.locator('#senha').count(), 0, 'sem campo de senha no modo chave');
  await s.page.check('#confio');
  s.srv.agentHasKey = false;
  await s.page.click('.wz-foot [data-act="conectar"]');
  await s.page.waitForSelector('#agenteCmd');
  assert.equal(await s.page.textContent('#agenteCmd'), 'ssh-add -t 15m ~/.ssh/chave_admin');
  s.srv.agentHasKey = true;
  await s.page.click('button:has-text("Tentar de novo")');
  await s.page.waitForSelector('.wz-row');
  assert.match(await s.page.textContent('#wzMeta'), /como maria · o sudo pede senha/);
  await s.page.click('[data-act="escolhas"]');
  await s.page.waitForSelector('#sudoSenha');
  assert.match(await s.page.textContent('.wz-review'), /não a passphrase da chave/);
  await s.page.fill('#sudoSenha', 'certa');
  await s.page.click('[data-act="preparar"]');
  await s.page.waitForSelector('.wz-done');
  const admin = s.srv.calls.filter((c) => c.kind === 'admin');
  assert.ok(admin.every((c) => c.password === '' && c.identityFile === '/home/maria/.ssh/chave_admin'));
  // 400 e 422 acima são os erros provocados de propósito (apelido com salto e agente sem a chave).
  assert.deepEqual(s.problems.filter((p) => !/status of 4(00|22)/.test(p)), []);
});

test('assistente e2e: modo manual exige os 4 blocos conferidos', async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await throughStep4(s);
  await s.page.click('[data-act="escolhas"]');
  await s.page.waitForSelector('.wz-act');
  await s.page.click('[data-mode="manual"]');
  await s.page.waitForSelector('.wz-block');
  assert.equal(await s.page.locator('.wz-block').count(), 4);
  assert.equal(await s.page.isDisabled('.wz-foot .wz-next'), true);
  await s.page.click('[data-test="usuario"]');
  await s.page.waitForSelector('.wz-block.is-err');
  assert.match(await s.page.textContent('.wz-block-err'), /ainda não existe/);
  s.srv.dashmon = true;
  for (const id of ['usuario', 'chave', 'sudoers', 'pronto']) {
    await s.page.click(`[data-test="${id}"]`);
    await s.page.waitForSelector(`[data-test="${id}"]:not([disabled])`);
  }
  await s.page.waitForSelector('.wz-block.is-ok >> nth=3');
  assert.match(await s.page.textContent('.wz-foot-note'), /4 de 4 blocos conferidos/);
  await s.page.click('.wz-foot .wz-next');
  await s.page.waitForSelector('.wz-hero');
  assert.deepEqual(s.problems, []);
});

test('assistente e2e: tema claro e celular (390 px) sem rolagem lateral', async (t) => {
  const s = await setup(t, { viewport: { width: 390, height: 844 }, theme: 'light' });
  if (s.skip) return t.skip(s.skip);
  await throughStep4(s);
  assert.equal(await s.page.getAttribute('html', 'data-theme'), 'light');
  const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `rolagem lateral de ${overflow}px`);
  await s.page.click('[data-act="escolhas"]');
  await s.page.waitForSelector('.wz-act');
  const overflow5 = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow5 <= 0, `passo 5: rolagem lateral de ${overflow5}px`);
  assert.deepEqual(s.problems, []);
});

test('assistente e2e: modo chave no celular (390 px) e tema claro, sem rolagem lateral (#61)', async (t) => {
  const s = await setup(t, { viewport: { width: 390, height: 844 }, theme: 'light', server: { detection: detectionWithSudo('pede-senha') } });
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/configurar#codigo=ACD-347`);
  await s.page.click('text=Começar');
  await s.page.click('[data-acesso="chave"]');
  await s.page.fill('#apelido', 'meu-servidor');
  await s.page.click('[data-act="apelido"]');
  await s.page.waitForSelector('.wz-sum');
  const over2 = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over2 <= 0, `passo 2: rolagem lateral de ${over2}px`);
  await s.page.click('[data-act="servidor"]');
  await s.page.waitForSelector('.wz-fp span');
  await s.page.check('#confio');
  s.srv.agentHasKey = false;
  await s.page.click('.wz-foot [data-act="conectar"]');
  await s.page.waitForSelector('#agenteCmd');
  const over3 = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over3 <= 0, `passo 3: rolagem lateral de ${over3}px`);
  assert.deepEqual(s.problems.filter((p) => !/status of 422/.test(p)), []);
});

test('assistente e2e: sem o código, pede o código do terminal', async (t) => {
  const s = await setup(t);
  if (s.skip) return t.skip(s.skip);
  await s.page.goto(`${s.base}/configurar`);
  await s.page.waitForSelector('#codigo');
  await s.page.fill('#codigo', 'XXX-XXX');
  await s.page.press('#codigo', 'Enter');
  await s.page.waitForSelector('#codigoErr');
  await s.page.fill('#codigo', 'acd347');
  await s.page.press('#codigo', 'Enter');
  await s.page.waitForSelector('.wz-chk');
  assert.deepEqual(s.problems.filter((p) => !/401/.test(p)), []);
});
