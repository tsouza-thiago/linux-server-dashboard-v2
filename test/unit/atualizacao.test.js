// Versão nova (ADR 0030): recorte do CHANGELOG, agenda diária, estado guardado e o processo à
// parte. As rotas e o git de verdade ficam em test/integration/atualizacao.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recortarNovidades } from '../../server/atualizacao/novidades.js';
import { Atualizacao, esperaAteProcurar, procurarEmProcesso, MANUAL_MS } from '../../server/atualizacao/index.js';
import { blocosDeNovidade } from '../../public/js/core/novidades.js';

const CHANGELOG = `# Changelog

## [Não publicado]

- nada ainda

## [2.5.0] — 2026-11-02

Versão nova.

### Adicionado

- Item A.

## [2.5.0-rc.1] — 2026-11-01

### Adicionado

- Item da pré-versão.

## [2.4.1] — 2026-10-31

- Item B.

## [2.4.0] — 2026-10-30

- Item velho.
`;

const HORA = 3600000;
const AGORA = Date.parse('2026-11-01T12:00:00Z');

function novaAtualizacao(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-atu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'atualizacao.json');
  return new Atualizacao({ file, instalada: 'v2.4.1', loginExigido: true, procurar: async () => ({}), agora: () => AGORA, aleatorio: () => 0, ...extra });
}

test('novidades: só as seções entre a instalada e a nova, da mais nova para a mais antiga', () => {
  const { secoes, cortado } = recortarNovidades(CHANGELOG, { de: 'v2.4.0', ate: 'v2.5.0' });
  assert.deepEqual(secoes.map((s) => s.versao), ['2.5.0', '2.5.0-rc.1', '2.4.1']);
  assert.equal(secoes[0].data, '2026-11-02');
  assert.match(secoes[0].texto, /^Versão nova\.\n\n### Adicionado\n\n- Item A\.$/);
  assert.equal(cortado, false);
  assert.ok(!secoes.some((s) => /Item velho|nada ainda/.test(s.texto)), 'nem a instalada nem o [Não publicado]');
});

test('novidades: a instalada fica de fora e a seção posterior à nova também', () => {
  const { secoes } = recortarNovidades(CHANGELOG, { de: 'v2.4.1', ate: 'v2.5.0-rc.1' });
  assert.deepEqual(secoes.map((s) => s.versao), ['2.5.0-rc.1']);
});

test('novidades: texto além do teto é cortado e avisado', () => {
  const longo = 'x'.repeat(40 * 1024);
  const md = `## [2.6.0] — 2026-12-01\n\n${longo}\n\n## [2.5.0] — 2026-11-01\n\n- item\n`;
  const { secoes, cortado } = recortarNovidades(md, { de: 'v2.4.0', ate: 'v2.6.0' });
  assert.deepEqual(secoes.map((s) => s.versao), ['2.6.0']);
  assert.equal(secoes[0].texto.length, 32 * 1024);
  assert.equal(cortado, true);
});

test('novidades na tela: títulos, itens com continuação, código, e HTML continua sendo texto', () => {
  const blocos = blocosDeNovidade('Frase.\n\n### Adicionado\n\n- Item **forte** com `cmd --x`\n  e [#90](https://exemplo.test/90).\n- <img src=x>\n');
  assert.deepEqual(blocos.map((b) => b.tipo), ['texto', 'titulo', 'item', 'item']);
  assert.deepEqual(blocos[2].partes, [
    { texto: 'Item forte com ', codigo: false }, { texto: 'cmd --x', codigo: true }, { texto: ' e #90.', codigo: false },
  ]);
  assert.deepEqual(blocos[3].partes, [{ texto: '<img src=x>', codigo: false }]);
});

test('agenda: ~5 min depois de ligar, 1 vez por dia, e reiniciar não adianta a procura', () => {
  const base = { agora: AGORA, aleatorio: 0 };
  assert.equal(esperaAteProcurar({ ...base, verificadoEm: null }), 5 * 60000, 'nunca procurou');
  assert.equal(esperaAteProcurar({ ...base, aleatorio: 0.5, verificadoEm: null }), 5 * 60000 + HORA / 2, 'atraso de até 1 h');
  assert.equal(esperaAteProcurar({ ...base, verificadoEm: new Date(AGORA - 2 * HORA).toISOString() }), 22 * HORA);
  assert.equal(esperaAteProcurar({ ...base, verificadoEm: new Date(AGORA - 48 * HORA).toISOString() }), 5 * 60000, 'atrasada: logo depois de ligar');
  assert.equal(esperaAteProcurar({ ...base, verificadoEm: 'lixo' }), 5 * 60000);
});

test('estado: guarda a versão achada, avisa as telas e sobrevive a reiniciar', async (t) => {
  const avisos = [];
  const a = novaAtualizacao(t, {
    procurar: async () => ({ nova: 'v2.5.0', novidades: { secoes: [], cortado: false }, bloqueio: 'arquivos-alterados', erro: null }),
    onChange: (e) => avisos.push(e.nova),
  });
  assert.equal(a.estado().nova, null);
  const e = await a.verificar();
  assert.deepEqual(avisos, ['v2.5.0']);
  assert.equal(e.nova, 'v2.5.0');
  assert.equal(e.bloqueio, 'arquivos-alterados');
  assert.equal(e.verificadoEm, new Date(AGORA).toISOString());
  assert.equal(fs.statSync(a.arquivo.file).mode & 0o777, 0o600);
  const depois = new Atualizacao({ file: a.arquivo.file, instalada: 'v2.4.1', loginExigido: true, procurar: async () => ({}) });
  assert.equal(depois.estado().nova, 'v2.5.0');
  const atualizado = new Atualizacao({ file: a.arquivo.file, instalada: 'v2.5.0', loginExigido: true, procurar: async () => ({}) });
  assert.equal(atualizado.estado().nova, null, 'depois de atualizar, o aviso some');
  assert.equal(atualizado.estado().novidades, null);
});

test('estado: procura que falha inteira mantém a versão achada e registra o erro', async (t) => {
  const respostas = [{ nova: 'v2.5.0', erro: null }, { erro: 'falhou' }];
  const a = novaAtualizacao(t, { procurar: async () => { const r = respostas.shift(); if (!respostas.length) throw new Error('quebrou'); return r; } });
  await a.verificar();
  const e = await a.verificar();
  assert.equal(e.nova, 'v2.5.0');
  assert.equal(e.erro, 'falhou');
});

test('estado: arquivo ilegível ou em outro formato começa vazio', (t) => {
  const a = novaAtualizacao(t);
  for (const lixo of ['{quebrado', '[1,2]', 'null']) {
    fs.writeFileSync(a.arquivo.file, lixo);
    const b = new Atualizacao({ file: a.arquivo.file, instalada: 'v2.4.1', loginExigido: true, procurar: async () => ({}) });
    assert.equal(b.estado().verificadoEm, null);
  }
});

test('estado: sem login, o bloqueio é sempre sem-login', async (t) => {
  const a = novaAtualizacao(t, { loginExigido: false, procurar: async () => ({ nova: 'v2.5.0', bloqueio: null, erro: null }) });
  assert.equal((await a.verificar()).bloqueio, 'sem-login');
  assert.equal(a.estado().nova, 'v2.5.0', 'o aviso aparece mesmo sem login');
});

test('procura: pedidos ao mesmo tempo viram uma só, e o manual respeita 1 por minuto', async (t) => {
  let chamadas = 0;
  let agora = AGORA;
  const a = novaAtualizacao(t, { agora: () => agora, procurar: async () => { chamadas += 1; return {}; } });
  await Promise.all([a.verificar(), a.verificar()]);
  assert.equal(chamadas, 1);
  const primeira = a.verificarAgora();
  assert.equal(a.verificarAgora(), null);
  await primeira;
  agora += MANUAL_MS;
  await a.verificarAgora();
  assert.equal(chamadas, 3);
});

test('processo à parte: devolve o JSON da saída; saída inválida ou erro viram `falhou`', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-proc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const escreve = (nome, corpo) => { const f = path.join(dir, nome); fs.writeFileSync(f, corpo); return f; };
  const certo = escreve('certo.mjs', "console.log(JSON.stringify({ nova: 'v2.5.0' }));");
  assert.deepEqual(await procurarEmProcesso({ script: certo }), { nova: 'v2.5.0' });
  assert.deepEqual(await procurarEmProcesso({ script: escreve('ruim.mjs', "console.log('oi');") }), { erro: 'falhou' });
  assert.deepEqual(await procurarEmProcesso({ script: escreve('lento.mjs', 'setTimeout(() => {}, 60000);'), tetoMs: 200 }), { erro: 'falhou' });
});
