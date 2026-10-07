// Testes de propriedade sem bibliotecas: gerador pseudoaleatório com semente fixa
// (falhas são reproduzíveis) e milhares de entradas por propriedade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput } from '../../server/collector/parser.js';
import { buildScript, normalizeTargets } from '../../server/collector/builder.js';
import { computeRates } from '../../server/collector/rates.js';
import { sanitizeToken } from '../../server/config.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTIONS = ['VER', 'HOST', 'OS', 'CPU', 'UPTIME', 'LOAD', 'STAT', 'MEM', 'DF', 'NET', 'IO', 'PSI', 'TEMP', 'SMART', 'SERVICES', 'PS', 'FIM'];
const ALPHABET = ' \t:;,.-_=/%"\'`$()|&<>*0123456789abcdefABCDEFxyzé\u0000\r';

function randomText(r, maxLen) {
  let out = '';
  const n = Math.floor(r() * maxLen);
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return out;
}

function randomOutput(r) {
  const lines = [];
  const count = Math.floor(r() * 60);
  for (let i = 0; i < count; i++) {
    if (r() < 0.2) lines.push(`===${SECTIONS[Math.floor(r() * SECTIONS.length)]}===`);
    else if (r() < 0.5) lines.push(Array.from({ length: Math.floor(r() * 20) }, () => String(Math.floor(r() * 1e12) - (r() < 0.1 ? 5e11 : 0))).join(' '));
    else lines.push(randomText(r, 80));
  }
  return lines.join(r() < 0.5 ? '\n' : '\r\n');
}

// Percorre a amostra e devolve caminhos de números inválidos (NaN, Infinity).
function badNumbers(value, at = 'amostra') {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [at];
  if (Array.isArray(value)) return value.flatMap((v, i) => badNumbers(v, `${at}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => badNumbers(v, `${at}.${k}`));
  return [];
}

test('fuzz: o parser nunca lança e nunca produz NaN/Infinity (3000 saídas aleatórias)', () => {
  const r = rng(20261007);
  let prev = null;
  for (let i = 0; i < 3000; i++) {
    const ts = new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString();
    const s = parseOutput(randomOutput(r), ts, { targets: { netIf: r() < 0.5 ? 'eth0' : '', devs: r() < 0.5 ? ['sda'] : [] } });
    computeRates(s, prev);
    assert.deepEqual(badNumbers(s), [], `entrada #${i}`);
    assert.ok(Array.isArray(s.disks) && Array.isArray(s.io) && Array.isArray(s.topProcs));
    prev = s;
  }
});

test('fuzz: sanitizeToken só devolve tokens da whitelist, nunca iniciando com "-"', () => {
  const r = rng(42);
  for (let i = 0; i < 5000; i++) {
    for (const token of sanitizeToken(randomText(r, 60))) {
      assert.match(token, /^[A-Za-z0-9_./:-]+$/);
      assert.ok(!token.startsWith('-'));
    }
  }
});

test('fuzz: nenhum alvo aleatório injeta caracteres de shell no comando', () => {
  const r = rng(7);
  const shellChars = /[;&|`$()<>'"\\\s*]/;
  for (let i = 0; i < 2000; i++) {
    const raw = {
      netIf: randomText(r, 20),
      mounts: [randomText(r, 30), randomText(r, 30)],
      devs: [randomText(r, 10)],
      services: [randomText(r, 15)],
    };
    const t = normalizeTargets(raw);
    for (const token of [t.netIf, ...t.mounts, ...t.devs, ...t.services].filter(Boolean)) {
      assert.doesNotMatch(token, shellChars, `token perigoso: ${JSON.stringify(token)}`);
    }
    const { script } = buildScript(raw, r() < 0.5 ? 'smart' : 'basico');
    assert.equal(script, buildScript(t, script.includes(':-smart}') ? 'smart' : 'basico').script, 'o comando só depende dos alvos saneados');
  }
});
