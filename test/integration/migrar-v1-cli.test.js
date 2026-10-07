import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'server', 'storage', 'migrate-v1.js');

// HISTORY_FILE precisa ficar dentro de data/ (config.js força isso), então o teste usa uma
// subpasta temporária de data/ e a remove no fim.
function setup(t) {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(ROOT, 'data', 'teste-migracao-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const v1File = path.join(dir, 'history.json');
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HISTORY_FILE: path.relative(ROOT, v1File) },
  });
  return { dir, v1File, run };
}

const samples = Array.from({ length: 12 }, (_, i) => ({
  ts: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), host: 'srv', load: [0.1, 0.1, 0.1], tempC: 40,
}));

test('npm run migrar-v1 -- --verificar mostra o resumo e não grava nada', (t) => {
  const { dir, v1File, run } = setup(t);
  fs.writeFileSync(v1File, JSON.stringify(samples));
  const r = run('--verificar');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /amostras válidas: 12/);
  assert.match(r.stdout, /Nada foi gravado/);
  assert.deepEqual(fs.readdirSync(dir), ['history.json']);
});

test('npm run migrar-v1 migra, faz backup e na 2ª vez não acha mais nada', (t) => {
  const { dir, v1File, run } = setup(t);
  fs.writeFileSync(v1File, JSON.stringify(samples));
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Migrado: 1 arquivo\(s\) diário\(s\) brutos e 2 agregado\(s\)/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['history', 'history.v1-migrado.json', 'rollup']);
  const again = run();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nada a migrar/);
});

test('npm run migrar-v1 com arquivo corrompido sai com erro e não mexe nele', (t) => {
  const { v1File, run } = setup(t);
  fs.writeFileSync(v1File, '[{"ts":');
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /não pôde ser lido/);
  assert.equal(fs.readFileSync(v1File, 'utf8'), '[{"ts":');
});
