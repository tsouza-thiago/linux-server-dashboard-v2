// `dashboard reconfigurar --pela-tela` de ponta a ponta (F8, ADR 0034): o ./dashboard de verdade numa
// pasta temporária, com o painel de pé. O assistente sobe na porta do painel, e desistir traz o
// painel de volta. Terminar o assistente fica com o painel novo, ou volta ao anterior se ele não
// subir (ADR 0035). O disparo pela tela e o executor entram nas próximas etapas da F8.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseDetection } from '../../server/setup/deteccao.js';
import { criarCodigoPelaTela } from '../../server/setup/pela-tela.js';
import { esperarAte } from '../../test-support/esperar.js';
import { FIXTURE, saidaColeta } from '../../test-support/instalacao-fake.js';
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

// Servidor falso, só o ssh: o `ssh` e o `ssh-keyscan` do PATH da instalação de teste respondem pelo
// servidor. O ./dashboard, o assistente e o painel são os de verdade.
const CHAVE = 'AAAAC3NzaC1lZDI1NTE5AAAAICLXaq8Zb0WG4QWeKtFRHjyahVNxZFkczJ5it2xMlpU2';
function servidorFalso(bin) {
  const devs = [...new Set(parseDetection(FIXTURE).mounts.filter((m) => m.target === '/').map((m) => m.disk).filter(Boolean))];
  fs.writeFileSync(path.join(bin, 'deteccao.txt'), FIXTURE);
  fs.writeFileSync(path.join(bin, 'coleta.txt'), saidaColeta({ mounts: ['/'], devs, smartDevs: [], services: [], netIf: '' }));
  const script = (nome, corpo) => fs.writeFileSync(path.join(bin, nome), `#!/bin/sh\n${corpo}\n`, { mode: 0o755 });
  script('ssh-keyscan', `echo "127.0.0.1 ssh-ed25519 ${CHAVE}"`);
  // Admin vem com `-F /dev/null` e o script no stdin; a coleta vem com o config do painel.
  script('ssh', `case " $* " in
  *" -V "*) exit 0;;
  *" -F /dev/null "*) e=$(cat); case "$e" in *===WHO===*) cat "${path.join(bin, 'deteccao.txt')}";; *) printf '@@ok sshd\\n@@ok usuario\\n@@ok chave\\n@@ok sudoers\\n';; esac;;
  *) cat "${path.join(bin, 'coleta.txt')}";;
esac`);
}

// Uma porta aberta em 127.0.0.1 (o passo do servidor confere o alcance; a outra serve de porta tomada).
async function portaAberta(t) {
  const srv = net.createServer();
  await new Promise((r) => { srv.listen(0, '127.0.0.1', r); });
  t.after(() => srv.close());
  return srv.address().port;
}

// Sobe o assistente de verdade e vai até antes de concluir. Devolve o `post` com a sessão dele.
async function assistenteAteOFim(t, { pasta, porta, bin, dashAoFundo }) {
  servidorFalso(bin);
  const codigo = criarCodigoPelaTela(path.join(pasta, 'data'));
  const processo = dashAoFundo(['reconfigurar', '--pela-tela']);
  const csrf = await assistenteNoAr(porta);
  let cookie = csrf;
  const post = async (p, body = {}) => {
    const r = await request(porta, { method: 'POST', path: `/api/configurar/${p}`, body, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Cookie: cookie } });
    const set = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('dash_setup='));
    if (set) cookie = `${csrf}; ${set.split(';')[0]}`;
    return r;
  };
  assert.equal((await post('entrar', { codigo })).status, 200);
  assert.equal((await post('servidor', { host: '127.0.0.1', user: 'maria', port: await portaAberta(t) })).status, 200);
  assert.equal((await post('identidade')).status, 200);
  assert.equal((await post('conectar', { senha: 'certa', confirmo: true })).status, 200);
  assert.equal((await post('escolhas', { mounts: ['/'], smart: [], netIf: '', services: [] })).status, 200);
  assert.equal((await post('plano', { from: false })).status, 200);
  const preparo = await post('preparar');
  assert.equal(preparo.json.ok, true, JSON.stringify(preparo.json));
  return { post, processo };
}
const CONCLUIR = { iniciarComComputador: false, atalho: false, link: false };

test('ponta a ponta: terminar o assistente fica com o painel novo, que responde de verdade', semFerramentas, async (t) => {
  const instalacao = await instalacaoReal(t);
  const { pasta, dash, estadoNoAr } = instalacao;
  assert.equal(dash(['iniciar']).codigo, 0);
  const { post, processo } = await assistenteAteOFim(t, instalacao);
  assert.equal((await post('concluir', CONCLUIR)).status, 200);
  assert.equal(await processo.fim, 0, fs.readFileSync(path.join(pasta, 'data', 'reconfigurar.log'), 'utf8'));
  assert.ok((await estadoNoAr()).instalada, 'o painel novo aceita o mesmo token');
  const env = fs.readFileSync(path.join(pasta, '.env'), 'utf8');
  assert.match(env, /^SSH_HOST=servidor$/m);
  assert.ok(env.includes(`DASH_TOKEN=${TOKEN}`));
  assert.deepEqual(fs.readdirSync(path.join(pasta, 'data')).filter((f) => /env|copia/i.test(f)), [], 'nenhuma cópia no disco');
});

test('ponta a ponta: painel novo que não sobe volta ao anterior, e o log diz o motivo', semFerramentas, async (t) => {
  const instalacao = await instalacaoReal(t);
  const { pasta, porta, dash, estadoNoAr } = instalacao;
  const dados = path.join(pasta, 'data');
  const env = () => fs.readFileSync(path.join(pasta, '.env'), 'utf8');
  assert.equal(dash(['iniciar']).codigo, 0);
  const envAntes = env();
  const { post, processo } = await assistenteAteOFim(t, instalacao);
  assert.match(env(), /^SSH_HOST=servidor$/m, 'o passo 5 já regravou o .env');
  assert.equal(fs.existsSync(path.join(dados, 'ssh', 'known_hosts')), true);

  // A configuração nova aponta para uma porta tomada: o painel novo não tem como subir.
  const tomada = await portaAberta(t);
  fs.writeFileSync(path.join(pasta, '.env'), env().replace(/^PORT=.*$/m, `PORT=${tomada}`), { mode: 0o600 });
  assert.equal((await post('concluir', CONCLUIR)).status, 200);
  assert.equal(await processo.fim, 1);

  assert.equal(env(), envAntes, 'o .env anterior voltou, com o mesmo DASH_TOKEN');
  assert.equal(fs.statSync(path.join(pasta, '.env')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(dados, 'ssh', 'known_hosts')), false);
  assert.equal(fs.existsSync(path.join(dados, 'ssh', 'config')), false);
  assert.ok((await estadoNoAr()).instalada, 'o painel anterior voltou, na porta anterior');
  assert.equal(porta, Number(/^PORT=(\d+)$/m.exec(env())[1]));
  const log = fs.readFileSync(path.join(dados, 'reconfigurar.log'), 'utf8');
  assert.match(log, new RegExp(`o painel não subiu com a configuração nova \\(a porta ${tomada} já está em uso`));
  assert.match(log, /painel de volta com a configuração anterior/);
  assert.ok(!log.includes(TOKEN), 'o log não traz segredo');
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
