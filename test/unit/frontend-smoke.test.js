import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from '../../test-support/frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const JS_DIR = path.join(ROOT, 'public', 'js');
const FILES = ['analysis.js', 'router.js', 'sections.js', 'charts.js', 'main.js'];

test('todos os arquivos de frontend compilam sem erro de sintaxe', () => {
  for (const f of FILES) {
    const code = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    assert.doesNotThrow(() => new Function(code), `${f} deveria compilar`);
  }
});

test('main.js carrega em sandbox com stubs e completa o init', () => {
  const ctx = loadAll(FILES);
  const Dash = ctx.Dash;
  assert.ok(Dash, 'Dash deve existir após init');
  assert.ok(Dash.router, 'router registrado');
  assert.ok(Dash.charts, 'charts registrado');
  assert.ok(Dash.sections, 'sections registrado');
  assert.ok(Dash.sections.modal, 'modal registrado');
  assert.equal(typeof Dash.sections.renderActiveView, 'function', 'renderActiveView exposto por main.js');
  assert.ok(Object.keys(Dash.charts.specs).length > 0, 'specs de gráficos registrados');
  assert.ok(Dash.analysis && Dash.fmt, 'analysis e fmt disponíveis');
  assert.equal(typeof Dash.api.ackAlert, 'function', 'api de alertas exposta');
  assert.equal(typeof Dash.api.addAnnotation, 'function', 'api de anotações exposta');
});

test('sections.js não deixa redeclarar const E (regressão do bug anterior)', () => {
  const code = fs.readFileSync(path.join(JS_DIR, 'sections.js'), 'utf8');
  const decls = [...code.matchAll(/const\s+E\s*=/g)].length;
  assert.equal(decls, 1, 'exatamente uma declaração de const E');
});