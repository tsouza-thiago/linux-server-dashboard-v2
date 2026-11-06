// Menor privilégio do serviço do painel (#181, ADR 0051): a unidade systemd só libera a escrita
// de data/ e de .atualizacao/painel/; o executor nunca usa o espelho do painel; o painel não
// importa o que só o executor pode escrever (pre.json, trava, estado e log).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pastasDe } from '../../server/config.js';
import { unitText } from '../../server/setup/local.js';
import { pastaDoPainelEm } from '../../server/atualizacao/registro.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// Os caminhos liberados para escrita na unidade (o `-` inicial só tolera pasta ausente).
function escritaDaUnidade(texto) {
  return [...texto.matchAll(/^ReadWritePaths=(.*)$/gm)]
    .flatMap((m) => [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/^-/, '').replace(/\\(.)/g, '$1')));
}

for (const [nome, root, pastas] of [
  ['clone', '/home/pessoa/painel', undefined],
  ['modo sistema', '/opt/server-dashboard/versoes/v2.6.2', { modo: 'sistema', dados: '/home/pessoa/.local/share/server-dashboard', config: '/home/pessoa/.config/server-dashboard' }],
]) {
  test(`unidade (${nome}): a escrita cobre tudo o que o painel grava e nada do que só o executor grava`, () => {
    const p = pastas ?? pastasDe(root);
    const texto = unitText({ root, nodeBin: '/usr/bin/node', pastas: p });
    const rw = escritaDaUnidade(texto);
    assert.deepEqual(rw.sort(), [path.join(p.dados, 'data'), pastaDoPainelEm(p.dados)].sort());
    // O painel/ é uma pasta dentro de .atualizacao/; a .atualizacao/ em si (pre.json, trava, estado
    // e log do executor) e o .git do clone ficam somente leitura.
    assert.ok(!rw.includes(path.join(p.dados, '.atualizacao')));
    assert.ok(rw.every((c) => !c.includes('.git')));
    assert.match(texto, /^ProtectSystem=strict$/m);
  });
}

test('o executor nunca cita o espelho nem a pasta do painel (ADR 0051)', () => {
  // O espelho só alimenta o aviso da tela. A troca refaz o fetch e a conferência no .git real.
  for (const rel of ['server/cli/atualizar.js', 'libexec/atualizador', 'server/atualizacao/pacote.js', 'server/atualizacao/executor.js']) {
    const texto = ler(rel);
    assert.ok(!/espelho|pastaDoPainel|painel\/pedido|SUBPASTA_PAINEL/.test(texto), `${rel} cita o espelho ou a pasta do painel`);
  }
});

test('o painel não importa o que só o executor pode escrever (ADR 0051)', () => {
  const proibidos = ['liberarPre', 'cancelarPre', 'pegarTrava', 'soltarTrava', 'abrirRegistro', 'garantirPasta'];
  for (const rel of ['server/index.js', 'server/atualizacao/index.js', 'server/atualizacao/procurar.js']) {
    const texto = ler(rel);
    for (const nome of proibidos) assert.ok(!new RegExp(`\\b${nome}\\b`).test(texto), `${rel} usa ${nome}`);
  }
});

test('a procura grava no espelho, nunca no .git do clone', () => {
  const texto = ler('server/atualizacao/procurar.js');
  // Nenhum fetch no clone: todo `fetch` leva o espelho como pasta.
  const fetches = texto.match(/git\([^\n]*'fetch'/g) ?? [];
  assert.ok(fetches.length > 0);
  for (const f of fetches) assert.match(f, /^git\(espelho\.dir/);
  assert.match(texto, /core\.hooksPath=\/dev\/null/);
});
