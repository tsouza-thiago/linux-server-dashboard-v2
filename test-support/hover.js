// Confere no navegador se os clicáveis respondem ao mouse (ADR 0024). Usa o "reduzir movimento":
// a transição fica instantânea, e o efeito tem de aparecer mesmo sem o deslocamento.

const ESTILO = (el) => {
  const s = getComputedStyle(el);
  return JSON.stringify([s.backgroundColor, s.borderTopColor, s.borderBottomColor, s.color, s.textDecorationLine,
    s.textDecorationColor, getComputedStyle(el, '::before').transform]);
};

/** Devolve os elementos visíveis e ligados de `seletor` que não mudam de estilo no hover. */
export async function semHover(page, seletor = 'a, button, summary') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const alvos = page.locator(seletor).filter({ visible: true });
  const faltam = [];
  for (let i = 0, n = await alvos.count(); i < n; i++) {
    const el = alvos.nth(i);
    // .skip-link só aparece com o foco do teclado; desligado não responde (ADR 0024).
    if (await el.evaluate((e) => e.matches('.skip-link, :disabled'))) continue;
    await page.mouse.move(0, 0);
    const antes = await el.evaluate(ESTILO);
    await el.hover();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    if (await el.evaluate(ESTILO) === antes) faltam.push(await el.evaluate((e) => e.cloneNode(false).outerHTML));
  }
  await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  return faltam;
}

/** Espera o elemento subir o --lift no hover e devolve a sombra dele. */
export async function sobe(page, seletor) {
  await page.mouse.move(0, 0);
  await page.locator(seletor).first().hover();
  await page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)).transform === 'matrix(1, 0, 0, 1, 0, -2)', seletor);
  return page.locator(seletor).first().evaluate((b) => getComputedStyle(b).boxShadow);
}
