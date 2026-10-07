// Design system V2 (D1): os tokens de public/css/tokens.css garantem contraste AA nos dois
// temas — todo texto ≥ 4,5:1 sobre as superfícies onde aparece, selos de status sobre o seu
// próprio fundo e as cores das séries ≥ 3:1 (elemento gráfico) sobre o cartão.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'css', 'tokens.css'), 'utf8');

/** Tokens de um bloco (`:root[data-theme="light"] { … }`), já com o escuro como base. */
function tokens(theme) {
  const blocks = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => ({ sel, body }));
  const read = (body) => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  const dark = read(blocks.find((b) => b.sel.includes('[data-theme="dark"]')).body);
  if (theme === 'dark') return dark;
  return { ...dark, ...read(blocks.find((b) => b.sel.includes('[data-theme="light"]')).body) };
}

function rgba(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const m = /^rgba?\(([^)]+)\)$/.exec(color);
  if (m) { const [r, g, b, a = 1] = m[1].split(',').map(Number); return [r, g, b, a]; }
  throw new Error(`cor não reconhecida: ${color}`);
}
const over = (top, base) => { const [r, g, b, a] = rgba(top); const [R, G, B] = base; return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)]; };
const lum = ([r, g, b]) => {
  const c = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
export function contrast(fg, bg) {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

for (const theme of ['dark', 'light']) {
  const t = tokens(theme);
  const solid = (name) => over(t[name], [255, 255, 255]);
  // Superfícies onde há texto (as "soft" são translúcidas: compostas sobre o cartão).
  const surfaces = ['bg', 'side', 'surface', 'surface-2'].map((s) => [s, solid(s)]);

  test(`tokens ${theme}: texto principal, secundário, legenda e destaque ≥ 4,5:1 nas superfícies`, () => {
    for (const fg of ['text', 'text-2', 'text-3', 'accent-text']) {
      for (const [name, bg] of surfaces) {
        const r = contrast(over(t[fg], bg), bg);
        assert.ok(r >= 4.5, `--${fg} sobre --${name}: ${r.toFixed(2)}:1`);
      }
    }
  });

  test(`tokens ${theme}: selos de status (tinta sobre o fundo suave) e texto sobre o destaque ≥ 4,5:1`, () => {
    const card = solid('surface');
    for (const lvl of ['ok', 'warn', 'serious', 'crit']) {
      for (const [name, base] of surfaces) {
        const bg = over(t[`${lvl}-soft`], base);
        const r = contrast(over(t[`${lvl}-ink`], bg), bg);
        assert.ok(r >= 4.5, `--${lvl}-ink sobre --${lvl}-soft em --${name}: ${r.toFixed(2)}:1`);
      }
    }
    const accentBg = over(t['accent-soft'], card);
    assert.ok(contrast(over(t['accent-text'], accentBg), accentBg) >= 4.5, 'botão suave de destaque');
    assert.ok(contrast(solid('on-accent'), solid('accent-strong')) >= 4.5, 'texto do botão principal');
    const offline = solid('crit-bg');
    assert.ok(contrast(over(t['crit-ink'], offline), offline) >= 4.5, 'faixa offline');
  });

  test(`tokens ${theme}: séries e cores de status ≥ 3:1 sobre o cartão (elemento gráfico)`, () => {
    const card = solid('surface');
    for (const s of ['s1', 's2', 's3', 's4', 'accent', 'ok', 'warn', 'crit']) {
      const r = contrast(solid(s), card);
      assert.ok(r >= 3, `--${s} sobre --surface: ${r.toFixed(2)}:1`);
    }
  });
}

test('tokens: as séries seguem a ordem fixa aprovada (CPU, RAM, disco, temperatura)', () => {
  assert.deepEqual(['s1', 's2', 's3', 's4'].map((k) => tokens('dark')[k]), ['#0E9CB0', '#8064F0', '#D84B8A', '#3F86E8']);
  assert.deepEqual(['s1', 's2', 's3', 's4'].map((k) => tokens('light')[k]), ['#0B8FA3', '#6D4FE0', '#D23F7E', '#2F6FD6']);
  assert.equal(tokens('dark').bg, '#07090E', 'escuro é o padrão (D1)');
  assert.equal(tokens('light').glow, '0', 'sem brilho no tema claro');
});
