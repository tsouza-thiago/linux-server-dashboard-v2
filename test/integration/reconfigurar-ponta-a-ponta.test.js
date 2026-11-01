// `dashboard reconfigurar --pela-tela` de ponta a ponta (F8, ADR 0034): o ./dashboard de verdade numa
// pasta temporária, com o painel de pé. O assistente sobe na porta do painel, e desistir traz o
// painel de volta. O disparo pela tela e o executor entram nas próximas etapas da F8.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { criarCodigoPelaTela } from '../../server/setup/pela-tela.js';
import { esperarAte } from '../../test-support/esperar.js';
import { instalacaoReal, TOKEN } from '../../test-support/instalacao-real.js';
import { request } from '../../test-support/request.js';

const temFerramentas = !spawnSync('git', ['--version']).error && !spawnSync('ssh-keygen', ['-?']).error;
const semFerramentas = { skip: !temFerramentas && 'sem git ou ssh-keygen' };

// Espera o assistente responder na porta e devolve o cookie do CSRF.
async function assistenteNoAr(porta) {
  let csrf = null;
  await esperarAte(async () => {
    const r = await request(porta, { path: '/configurar' }).catch(() => null);
    if (r?.status === 200) csrf = [].concat(r.headers['set-cookie']).find((c) => c.startsWith('dash_csrf=')).split(';')[0];
    return csrf;
  }, { timeoutMs: 30000, passoMs: 100 });
  assert.ok(csrf, 'o assistente não respondeu');
  return csrf;
}

test('ponta a ponta: --pela-tela sobe o assistente no lugar do painel, e desistir religa o painel', semFerramentas, async (t) => {
  const { pasta, dash, dashAoFundo, porta, estadoNoAr } = await instalacaoReal(t);
  const dados = path.join(pasta, 'data');
  const log = () => fs.readFileSync(path.join(dados, 'reconfigurar.log'), 'utf8');
  const env = () => fs.readFileSync(path.join(pasta, '.env'), 'utf8');
  assert.equal(dash(['iniciar']).codigo, 0);
  const envAntes = env();

  // Sem o código da tela, nada muda.
  const semCodigo = dash(['reconfigurar', '--pela-tela']);
  assert.equal(semCodigo.codigo, 1);
  assert.match(log(), /sem código válido da tela/, semCodigo.texto);
  assert.ok((await estadoNoAr()).instalada, 'o painel seguiu no ar');

  // Cancelar pela rota do assistente.
  const codigo = criarCodigoPelaTela(dados);
  const primeira = dashAoFundo(['reconfigurar', '--pela-tela']);
  const csrf = await assistenteNoAr(porta);
  const post = (p, body, cookie = csrf) => request(porta, { method: 'POST', path: `/api/configurar/${p}`, body, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Cookie: cookie } });
  assert.equal((await post('entrar', { codigo: 'ERRADO' })).status, 401);
  const entrou = await post('entrar', { codigo });
  assert.equal(entrou.status, 200);
  assert.equal((await post('entrar', { codigo })).status, 410, 'o código vale 1 vez');
  const sessao = [].concat(entrou.headers['set-cookie']).find((c) => c.startsWith('dash_setup=')).split(';')[0];
  assert.equal((await post('cancelar', {}, `${csrf}; ${sessao}`)).status, 200);
  assert.equal(await primeira.fim, 0);
  assert.ok((await estadoNoAr()).instalada, 'o painel voltou');
  assert.equal(env(), envAntes);
  assert.match(log(), /painel de volta com a configuração anterior/);
  assert.ok(!log().includes(codigo) && !log().includes(TOKEN), 'o log não traz segredo');

  // SIGTERM: é o que o `systemctl --user stop` da unidade manda.
  criarCodigoPelaTela(dados);
  const segunda = dashAoFundo(['reconfigurar', '--pela-tela']);
  await assistenteNoAr(porta);
  segunda.filho.kill('SIGTERM');
  assert.equal(await segunda.fim, 0);
  assert.ok((await estadoNoAr()).instalada, 'o painel voltou depois do SIGTERM');
});

test('ponta a ponta: --pela-tela nunca troca a versão da pasta', semFerramentas, async (t) => {
  const { pasta, git, dash, estadoNoAr } = await instalacaoReal(t);
  assert.equal(dash(['iniciar']).codigo, 0);
  // Um commit sem tag: o `instalar` trocaria para a tag assinada; pela tela, só recusa.
  git(pasta, '-c', 'user.email=teste@example.com', '-c', 'user.name=Teste', 'commit', '-q', '--allow-empty', '-m', 'sem tag');
  const antes = git(pasta, 'rev-parse', 'HEAD');
  criarCodigoPelaTela(path.join(pasta, 'data'));
  assert.equal(dash(['reconfigurar', '--pela-tela']).codigo, 1);
  assert.equal(git(pasta, 'rev-parse', 'HEAD'), antes);
  assert.ok((await estadoNoAr()).instalada, 'o painel seguiu no ar');
});
