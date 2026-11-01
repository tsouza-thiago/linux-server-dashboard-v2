// Atualização de ponta a ponta (F7, etapa 10): o ./dashboard de verdade numa pasta temporária, com
// tags assinadas por uma chave de teste. O painel liga de verdade, o botão dispara o executor em
// segundo plano e a versão muda no disco. A conferência com o systemd fica nos contêineres de
// scripts/e2e-instalacao/, porque aqui ela tomaria o serviço desta máquina.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { consumeLoginCode } from '../../server/http/entrar.js';
import { esperarAte } from '../../test-support/esperar.js';
import { instalacaoReal, TOKEN } from '../../test-support/instalacao-real.js';

const temFerramentas = !spawnSync('git', ['--version']).error && !spawnSync('ssh-keygen', ['-?']).error;
const semFerramentas = { skip: !temFerramentas && 'sem git ou ssh-keygen' };

test('ponta a ponta: o botão troca de versão e, se a nova não liga, volta atrás com os dados', semFerramentas, async (t) => {
  const { pasta, git, dash, publicar, apertarAtualizar, fimDaTroca, estadoNoAr } = await instalacaoReal(t);
  assert.equal(dash(['iniciar']).codigo, 0);

  publicar('2.91.0');
  await apertarAtualizar('v2.91.0');
  const certo = await fimDaTroca();
  assert.equal(certo?.resultado, 'atualizado', JSON.stringify(certo));
  assert.equal(git(pasta, 'describe', '--tags', '--exact-match'), 'v2.91.0');
  assert.match(dash(['versao']).texto, /2\.91\.0/);
  const noAr = await estadoNoAr();
  assert.equal(noAr.instalada, 'v2.91.0', 'a versão nova responde');
  assert.equal(noAr.modo, 'segundo-plano');

  publicar('2.92.0', { quebrada: true });
  await apertarAtualizar('v2.92.0');
  const voltou = await fimDaTroca();
  assert.equal(voltou?.resultado, 'voltou', JSON.stringify(voltou));
  assert.equal(git(pasta, 'describe', '--tags', '--exact-match'), 'v2.91.0');
  assert.equal(fs.existsSync(path.join(pasta, 'data', 'estragado.txt')), false, 'data/ voltou do backup');
  assert.equal((await estadoNoAr()).instalada, 'v2.91.0', 'o painel anterior religou');

  const log = fs.readFileSync(path.join(pasta, '.atualizacao', 'ultima.log'), 'utf8');
  assert.match(log, /voltando para v2\.91\.0/, 'o log sobrevive à volta atrás');
  assert.ok(!log.includes(TOKEN), 'o log não traz o token');
  assert.equal(fs.existsSync(path.join(pasta, '.atualizacao', 'trava.pid')), false);
});

test('ponta a ponta: com tela, só abre o painel; sem tela ou com o painel parado, segue no terminal', semFerramentas, async (t) => {
  const { pasta, bin, git, dash, publicar, porta, estadoNoAr } = await instalacaoReal(t);
  // Um xdg-open falso guarda o endereço, e o teste entra por ele como o navegador entraria.
  const abertos = path.join(bin, 'abertos.txt');
  fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${abertos}"\n`, { mode: 0o755 });
  assert.equal(dash(['iniciar']).codigo, 0);
  publicar('2.91.0');

  const comTela = dash(['atualizar'], { DISPLAY: ':0' });
  assert.equal(comTela.codigo, 0, comTela.texto);
  assert.match(comTela.texto, /painel aberto no navegador/);
  assert.equal(git(pasta, 'describe', '--tags', '--exact-match'), 'v2.90.0', 'quem troca é o clique na tela');
  assert.ok(await esperarAte(() => fs.existsSync(abertos)), 'o xdg-open não rodou');
  const url = fs.readFileSync(abertos, 'utf8').trim();
  const [, codigo] = new RegExp(`^http://127\\.0\\.0\\.1:${porta}/entrar\\?codigo=([\\w-]+)#/visao-geral\\?atualizar=1$`).exec(url);
  // A rota /entrar e o fragmento ficam no e2e: aqui, o código é o que o painel aceitaria.
  assert.equal(consumeLoginCode(path.join(pasta, 'data'), codigo), true, 'o link entra logado');
  assert.equal(consumeLoginCode(path.join(pasta, 'data'), codigo), false, 'o link vale 1 vez');

  const semTela = dash(['atualizar']);
  assert.equal(semTela.codigo, 0, semTela.texto);
  assert.match(semTela.texto, /não há tela gráfica nesta sessão/);
  assert.match(semTela.texto, /atualizado de v2\.90\.0 para v2\.91\.0/);
  assert.equal((await estadoNoAr()).instalada, 'v2.91.0');

  assert.equal(dash(['parar']).codigo, 0);
  publicar('2.92.0');
  const parado = dash(['atualizar'], { DISPLAY: ':0' });
  assert.equal(parado.codigo, 0, parado.texto);
  assert.match(parado.texto, /o painel está parado/);
  assert.match(parado.texto, /atualizado de v2\.91\.0 para v2\.92\.0/);
  assert.equal(git(pasta, 'describe', '--tags', '--exact-match'), 'v2.92.0');

  publicar('2.93.0');
  const terminal = dash(['atualizar', '--terminal'], { DISPLAY: ':0' });
  assert.equal(terminal.codigo, 0, terminal.texto);
  assert.match(terminal.texto, /atualizado de v2\.92\.0 para v2\.93\.0/);
  assert.equal(fs.readFileSync(abertos, 'utf8').trim().split('\n').length, 1, 'com --terminal, nada abre');
});
