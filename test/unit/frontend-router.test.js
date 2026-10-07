import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from '../../test-support/frontend.js';

const { Dash, location, document } = loadFrontend('router.js');
Dash.charts = { resize() {} };
Dash.sections = { renderActiveView() {} };
const R = Dash.router;

test('router.current resolve views por hash', () => {
  const cases = [
    ['', 'overview'],
    ['#/', 'overview'],
    ['#/discos', 'discos'],
    ['#/rede', 'rede'],
    ['#/processos', 'processos'],
    ['#/alertas', 'alertas'],
    ['#/analise', 'analise'],
    ['#/historico', 'historico'],
    ['#/ajuda', 'ajuda'],
    ['#/desconhecido', 'overview'],
    ['#/discos?foo=1', 'discos'],
  ];
  for (const [hash, expected] of cases) {
    location.hash = hash;
    assert.equal(R.current(), expected, `hash "${hash}"`);
  }
});

test('router.navigate ativa a view correta e seta título', () => {
  const viewOverview = document.getElementById('view-overview');
  viewOverview.className = 'view active';
  const viewDiscos = document.getElementById('view-discos');
  viewDiscos.className = 'view';
  const title = document.getElementById('viewTitle');

  const navDiscos = document.createElement('a');
  navDiscos.className = 'nav-item';
  navDiscos.dataset.view = 'discos';
  document.byId.navDiscos = navDiscos;

  location.hash = '#/discos';
  R.navigate();

  assert.ok(!viewOverview.classList.contains('active'));
  assert.ok(viewDiscos.classList.contains('active'));
  assert.equal(title.textContent, 'Discos');
  assert.ok(navDiscos.classList.contains('active'));
});

test('router.navigate trata hash desconhecido como overview', () => {
  const viewOverview = document.getElementById('view-overview');
  viewOverview.className = 'view active';
  const title = document.getElementById('viewTitle');
  location.hash = '#/lixo';
  R.navigate();
  assert.ok(viewOverview.classList.contains('active'));
  assert.equal(title.textContent, 'Visão Geral');
});