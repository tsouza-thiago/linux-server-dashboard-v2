// Espera visível e peças de esqueleto (F6, ADR 0027), sem DOM: rodam no Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ATRASO_MS, MINIMO_MS, esperaVisivel } from '../../public/js/core/espera.js';
import { applyDataStyles } from '../../public/js/core/html.js';
import {
  carregarRegiao, skelCabeca, skelCartao, skelFaixas, skelGrafico, skelLinha, skelRegiao, skelTabela, skelTexto,
} from '../../public/js/views/common.js';
import { VIEWS } from '../../public/js/core/router.js';

// Quantas vezes o trecho aparece no HTML gerado.
const conta = (texto, trecho) => String(texto).split(trecho).length - 1;

test('espera: o atraso e o tempo mínimo da F6', () => {
  assert.equal(ATRASO_MS, 150);
  assert.equal(MINIMO_MS, 300);
});

test('espera: resposta antes do atraso não mostra nada e troca direto', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let vezes = 0;
  const fim = esperaVisivel(() => { vezes += 1; });
  t.mock.timers.tick(ATRASO_MS - 1);
  assert.equal(fim(), 0);
  t.mock.timers.tick(1000);
  assert.equal(vezes, 0, 'fim() cancela o atraso');
});

test('espera: depois de visível, faltam os ms do tempo mínimo, e nunca menos que 0', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let vezes = 0;
  const fim = esperaVisivel(() => { vezes += 1; });
  t.mock.timers.tick(ATRASO_MS);
  assert.equal(vezes, 1);
  t.mock.timers.tick(100);
  assert.equal(fim(), MINIMO_MS - 100);
  t.mock.timers.tick(MINIMO_MS);
  assert.equal(fim(), 0);
  assert.equal(vezes, 1);
});

test('peças: usam as classes do conteúdo final e nada de style no HTML', () => {
  const cartao = String(skelCartao({ medidor: true, numero: 'md', nota: 'nota <b>' }));
  assert.match(cartao, /<article class="card">/);
  assert.match(cartao, /class="big md"/);
  assert.match(cartao, /class="meter"/);
  assert.match(cartao, /nota &lt;b&gt;/, 'o exemplo passa pelo escape');
  assert.doesNotMatch(String(skelCartao()), /class="meter"/);
  assert.match(String(skelLinha(40)), /data-w="40"/);
  assert.doesNotMatch(String(skelLinha(null, 'exemplo')), /data-w/);
  assert.match(String(skelCabeca(true)), /class="hint"/);
  assert.doesNotMatch(String(skelCabeca()), /class="hint"/);
  assert.match(String(skelGrafico(240)), /data-px="240"/);
  const tabela = String(skelTabela(3, 4, { cabeca: '<tr></tr>', cls: 'daily' }));
  assert.equal(conta(tabela, '<tr>'), 3);
  assert.equal(conta(tabela, '<td>'), 12);
  assert.match(tabela, /class="table daily"/);
  const faixas = String(skelFaixas(2, 'psi'));
  assert.equal(conta(faixas, 'class="strip-row"'), 2);
  assert.match(faixas, /class="strips psi"/);
  assert.equal(conta(skelTexto(5), 'skel-txt'), 5);
  for (const p of [cartao, tabela, faixas, skelGrafico(), skelTexto()]) assert.doesNotMatch(String(p), /style=/);
});

test('peças: a altura do gráfico vai pelo CSSOM (data-px), limitada', () => {
  const el = { dataset: { px: '240' }, style: {} };
  const negativo = { dataset: { px: '-5' }, style: {} };
  applyDataStyles({ querySelectorAll: (sel) => { assert.match(sel, /\[data-px\]/); return [el, negativo]; } });
  assert.equal(el.style.height, '240px');
  assert.equal(negativo.style.height, '0px');
});

test('peças: a região avisa que carrega, com ou sem as peças visíveis', () => {
  const oculta = String(skelRegiao({ local: {} }, skelTexto(1)));
  assert.match(oculta, /class="esqueleto oculto" aria-busy="true"/);
  assert.match(oculta, /class="visually-hidden">carregando</);
  assert.match(String(skelRegiao({ local: { regiaoVisivel: true } }, '')), /class="esqueleto" aria-busy="true"/);
});

test('telas: as 8 têm esqueleto próprio, e nenhuma fala "Carregando"', async () => {
  assert.equal(VIEWS.length, 8);
  const state = { period: '1h', sample: null, meta: null, config: null, alerts: { all: [] } };
  for (const { id } of VIEWS) {
    const mod = await import(`../../public/js/views/${id}.js`);
    assert.equal(typeof mod.ownSkeleton, 'function', id);
    assert.match(String(mod.ownSkeleton(state)), /class="skel|skel-txt/, id);
    assert.doesNotMatch(fs.readFileSync(`public/js/views/${id}.js`, 'utf8'), /Carregando/, id);
  }
});

// Espera as promessas e os timers de 1 tique.
const respira = () => new Promise((r) => { setImmediate(r); });

test('região: resposta rápida entrega sem mostrar as peças; só o último pedido vale', async () => {
  const ctx = { el: {}, local: {} };
  const entregas = [];
  let atualizou = 0;
  let soltaVelho;
  const velho = new Promise((r) => { soltaVelho = r; });
  carregarRegiao(ctx, () => { atualizou += 1; }, () => velho, (v) => entregas.push(v));
  await carregarRegiao(ctx, () => { atualizou += 1; }, async () => 'novo', (v) => entregas.push(v));
  soltaVelho('velho');
  await respira();
  assert.deepEqual(entregas, ['novo']);
  assert.equal(atualizou, 1);
  assert.equal(ctx.local.regiaoVisivel, false);
});

test('região: falha entrega null, e a tela que saiu não recebe nada', async () => {
  const ctx = { el: {}, local: {} };
  const entregas = [];
  await carregarRegiao(ctx, () => {}, () => Promise.reject(new Error('fora do ar')), (v) => entregas.push(v));
  assert.deepEqual(entregas, [null]);
  const fora = { el: { isConnected: false }, local: {} };
  await carregarRegiao(fora, () => assert.fail('não atualiza'), async () => 'x', () => assert.fail('não entrega'));
});

test('região: vindo de um esqueleto visível, as peças aparecem na hora, e só na 1ª vez', async () => {
  const ctx = { el: {}, local: {}, semAtraso: true };
  const espera = carregarRegiao(ctx, () => {}, () => new Promise((r) => { setTimeout(r, 5); }), () => {});
  assert.equal(ctx.local.regiaoVisivel, true);
  assert.equal(ctx.semAtraso, false);
  await espera;
  assert.equal(ctx.local.regiaoVisivel, false);
});
