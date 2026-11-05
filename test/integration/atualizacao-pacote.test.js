// Atualização pelo pacote .deb (F9 etapa 8, ADR 0048): o painel lê o estado/ do executor no lugar
// do git, e a troca pede as unidades `atualizar` e `voltar` do sistema, sem parâmetro. Tudo roda
// numa pasta temporária com o layout do pacote; o `systemctl` e a versão nova são falsos e
// injetados. Nenhum systemd, polkit ou rede de verdade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOutput } from '../../server/cli/saida.js';
import { atualizar } from '../../server/cli/atualizar.js';
import { UNIDADE_ATUALIZAR, UNIDADE_VOLTAR, iniciarUnidade, lerChaves, procurarNoPacote, registroDesde, versaoDoPacote } from '../../server/atualizacao/pacote.js';
import { bloqueioDaPasta, bloqueioDaReconfiguracao, procurar } from '../../server/atualizacao/procurar.js';
import { executarForaDoServico, reconfigurarForaDoServico } from '../../server/atualizacao/executor.js';
import { Atualizacao, PERIODO_NO_PACOTE_MS, esperaAteProcurar } from '../../server/atualizacao/index.js';
import { pastasDaInstalacao } from '../../server/config.js';
import { serviceNode } from '../../server/setup/local.js';
import { MARCADOR_RECONFIGURAR } from '../../server/atualizacao/novidades.js';
import { aoFim } from '../../test-support/limpeza.js';

function memOut() {
  const partes = [];
  const out = makeOutput({ stream: { isTTY: false, write: (s) => { partes.push(s); return true; } }, env: {} });
  return { out, texto: () => partes.join('') };
}

const CHANGELOG = `# Changelog\n\n## [2.7.0] — 2026-11-20\n\n- novidade da 2.7.0\n\n## [2.6.0] — 2026-11-10\n\n- a de hoje\n`;

// Layout do pacote: <base>/versoes/{v2.6.0,v2.7.0}, o link versoes/atual e o estado/ do executor.
// A pasta da versão instalada faz o papel do código e também guarda .env e data/ (um clone para o
// pastasDe), para o teste nunca tocar nas pastas XDG de quem roda a suíte.
function pacote(t, { disponivel = 'v2.7.0', erro = '', changelog = CHANGELOG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-'));
  aoFim(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base');
  const versoes = path.join(base, 'versoes');
  for (const v of ['2.6.0', '2.7.0']) {
    fs.mkdirSync(path.join(versoes, `v${v}`), { recursive: true });
    fs.writeFileSync(path.join(versoes, `v${v}`, 'package.json'), JSON.stringify({ version: v }));
  }
  fs.symlinkSync('v2.6.0', path.join(versoes, 'atual'));
  const estado = path.join(base, 'estado');
  fs.mkdirSync(estado);
  fs.writeFileSync(path.join(estado, 'disponivel'), `versao=${disponivel}\nobjeto=abc\nverificado=1794787200\nerro=${erro}\n`);
  fs.writeFileSync(path.join(estado, 'novidades.md'), changelog);
  fs.writeFileSync(path.join(estado, 'registro.log'), '2026-11-20T00:00:00Z verificar: versão nova v2.7.0\n');
  const root = path.join(versoes, 'v2.6.0');
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=servidor\nSSH_ACESSO=restrito\n', { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'data', 'alerts.json'), '[]');
  const home = path.join(dir, 'casa');
  fs.mkdirSync(home);
  return { base, root, home, estado };
}

// O executor falso: anota as unidades pedidas, escreve no registro e troca o link como o de verdade.
function executorFalso(p, { atualiza = true, volta = true, negado = false } = {}) {
  const pedidos = [];
  const trocar = (v) => {
    fs.rmSync(path.join(p.base, 'versoes', 'atual'));
    fs.symlinkSync(v, path.join(p.base, 'versoes', 'atual'));
  };
  const iniciar = (unidade) => {
    pedidos.push(unidade);
    if (negado) return { ok: false, erro: 'Interactive authentication required.' };
    const ok = unidade === UNIDADE_ATUALIZAR ? atualiza : volta;
    fs.appendFileSync(path.join(p.estado, 'registro.log'), `2026-11-20T00:01:00Z ${unidade}: ${ok ? 'feito' : 'ERRO: falhou'}\n`);
    if (ok) trocar(unidade === UNIDADE_ATUALIZAR ? 'v2.7.0' : 'v2.6.0');
    return { ok, erro: ok ? null : 'falhou' };
  };
  return { pedidos, iniciar };
}

// As dependências do painel: parar, ligar e a fase 2 (rodada pela versão do link atual).
function painelFalso(p, { novaSobe = true } = {}) {
  const passos = [];
  return {
    passos,
    deps: {
      pacote: p.base,
      panelStatus: () => ({ running: true }),
      stopPanel: async () => { passos.push('parar'); return { ok: true }; },
      startPanel: async () => { passos.push('ligar'); return { ok: true }; },
      reexec: (args) => {
        const versao = versaoDoPacote(p.base);
        passos.push(`fase2 ${versao}`);
        assert.deepEqual(args, ['atualizar', '--pos-atualizacao']);
        if (versao === 'v2.7.0' && !novaSobe) {
          fs.writeFileSync(path.join(p.root, 'data', 'alerts.json'), 'estragado pela versão nova');
          return 1;
        }
        return 0;
      },
    },
  };
}

const lerEstado = (p) => JSON.parse(fs.readFileSync(path.join(p.root, '.atualizacao', 'estado.json'), 'utf8'));
const log = (p) => fs.readFileSync(path.join(p.root, '.atualizacao', 'ultima.log'), 'utf8');

test('pacote: lê a versão do estado/ do executor, com as novidades e a hora dele', (t) => {
  const p = pacote(t);
  const r = procurarNoPacote({ base: p.base, instalada: 'v2.6.0' });
  assert.equal(r.nova, 'v2.7.0');
  assert.equal(r.erro, null);
  assert.equal(r.verificadoEm, new Date(1794787200 * 1000).toISOString());
  assert.deepEqual(r.novidades.secoes.map((s) => s.versao), ['2.7.0']);
  // Mesma versão, mais velha ou fora do padrão: nada de versão nova.
  for (const v of ['v2.6.0', 'v2.5.0', 'v3.0.0', '../../etc', 'v2.7.0;rm']) {
    fs.writeFileSync(path.join(p.estado, 'disponivel'), `versao=${v}\nverificado=1\nerro=\n`);
    assert.equal(procurarNoPacote({ base: p.base, instalada: 'v2.6.0' }).nova, null, v);
  }
  // O git fetch do executor falhou: para a tela, sem acesso ao GitHub.
  fs.writeFileSync(path.join(p.estado, 'disponivel'), 'versao=\nobjeto=\nverificado=1794787200\nerro=falhou\n');
  assert.equal(procurarNoPacote({ base: p.base, instalada: 'v2.6.0' }).erro, 'sem-acesso');
  // Sem o estado/ (o timer nunca rodou): nada, e sem hora inventada.
  fs.rmSync(p.estado, { recursive: true });
  assert.deepEqual(procurarNoPacote({ base: p.base, instalada: 'v2.6.0' }), { nova: null, novidades: null, erro: null, verificadoEm: null });
});

test('pacote: chave=valor só no formato fixo; o registro continua depois de girar', (t) => {
  const p = pacote(t);
  fs.writeFileSync(path.join(p.estado, 'troca'), 'em=1\nem=2\nDe=x\n de=y\npara=v2.7.0\n');
  assert.deepEqual(lerChaves(path.join(p.estado, 'troca')), { em: '1', para: 'v2.7.0' });
  assert.deepEqual(lerChaves(path.join(p.estado, 'nao-existe')), {});
  const desde = fs.statSync(path.join(p.estado, 'registro.log')).size;
  fs.appendFileSync(path.join(p.estado, 'registro.log'), 'linha nova\n');
  assert.equal(registroDesde(p.base, desde), 'linha nova\n');
  fs.writeFileSync(path.join(p.estado, 'registro.log'), 'log girado\n');
  assert.equal(registroDesde(p.base, desde), 'log girado\n', 'menor que antes: lê do começo');
});

test('pacote: o systemctl pede só as 2 unidades, sem parâmetro e sem pedir senha', () => {
  const chamadas = [];
  const run = (cmd, args, opts) => { chamadas.push({ cmd, args, opts }); return { status: 0, stderr: '' }; };
  assert.deepEqual(iniciarUnidade(UNIDADE_ATUALIZAR, { run }), { ok: true, erro: null });
  assert.deepEqual(iniciarUnidade(UNIDADE_VOLTAR, { run }), { ok: true, erro: null });
  assert.deepEqual(chamadas.map((c) => [c.cmd, ...c.args]), [
    ['systemctl', '--no-ask-password', 'start', 'server-dashboard-atualizar.service'],
    ['systemctl', '--no-ask-password', 'start', 'server-dashboard-voltar.service'],
  ]);
  assert.equal(chamadas[0].opts.shell, undefined);
  for (const outra of ['server-dashboard-verificar.service', 'server-dashboard.service', 'ssh.service', 'server-dashboard-atualizar.service x']) {
    assert.throws(() => iniciarUnidade(outra, { run }), /unidade desconhecida/, outra);
  }
  // O polkit negou (fora do grupo): a última linha do erro vai para o log.
  const negado = () => ({ status: 1, stderr: 'Failed to start server-dashboard-atualizar.service: Interactive authentication required.\n' });
  assert.match(iniciarUnidade(UNIDADE_ATUALIZAR, { run: negado }).erro, /Interactive authentication required/);
  assert.equal(iniciarUnidade(UNIDADE_ATUALIZAR, { run: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) }).erro, 'systemctl não encontrado');
});

test('pacote: a troca para o painel, copia os dados, pede o executor e liga a versão nova', async (t) => {
  const p = pacote(t);
  const ex = executorFalso(p);
  const painel = painelFalso(p);
  const silencioso = memOut();
  const codigo = await atualizar({ out: silencioso.out, root: p.root, home: p.home, args: ['--registro'], deps: { ...painel.deps, iniciarUnidade: ex.iniciar } });
  assert.equal(codigo, 0, log(p));
  assert.equal(silencioso.texto(), '', 'pela tela, nada no terminal');
  assert.deepEqual(ex.pedidos, [UNIDADE_ATUALIZAR]);
  assert.deepEqual(painel.passos, ['parar', 'fase2 v2.7.0']);
  const texto = log(p);
  assert.match(texto, /✓ versão nova encontrada: v2\.7\.0/);
  assert.match(texto, /✓ cópia de segurança dos dados feita \(\.backups\/.*-v2\.6\.0\)/);
  assert.match(texto, /executor: 2026-11-20T00:01:00Z server-dashboard-atualizar\.service: feito/, 'o registro do executor entra no log da troca');
  assert.doesNotMatch(texto, /verificar: versão nova/, 'só o que o executor escreveu durante a troca');
  assert.match(texto, /✓ atualizado de v2\.6\.0 para v2\.7\.0/);
  assert.doesNotMatch(texto, /exige reconfigurar/, 'sem o marcador, sem aviso');
  const e = lerEstado(p);
  assert.equal(e.resultado, 'atualizado');
  assert.equal(e.alvo, 'v2.7.0');
  assert.equal(e.de, 'v2.6.0');
  assert.equal(fs.readdirSync(path.join(p.root, '.backups')).length, 1);
  assert.equal(fs.existsSync(path.join(p.root, '.atualizacao', 'trava.pid')), false);
});

test('pacote: a versão nova que não sobe chama o voltar e devolve os dados da cópia', async (t) => {
  const p = pacote(t);
  const ex = executorFalso(p);
  const painel = painelFalso(p, { novaSobe: false });
  assert.equal(await atualizar({ out: memOut().out, root: p.root, home: p.home, args: ['--registro'], deps: { ...painel.deps, iniciarUnidade: ex.iniciar } }), 1);
  assert.deepEqual(ex.pedidos, [UNIDADE_ATUALIZAR, UNIDADE_VOLTAR]);
  assert.deepEqual(painel.passos, ['parar', 'fase2 v2.7.0', 'parar', 'fase2 v2.6.0']);
  assert.equal(versaoDoPacote(p.base), 'v2.6.0');
  assert.equal(fs.readFileSync(path.join(p.root, 'data', 'alerts.json'), 'utf8'), '[]', 'data/ volta da cópia');
  assert.equal(lerEstado(p).resultado, 'voltou');
  assert.match(log(p), /✓ de volta à v2\.6\.0, com os dados de antes da atualização/);
  assert.match(log(p), /executor: .*server-dashboard-voltar\.service: feito/);
});

test('pacote: o voltar que falha deixa a versão nova, não mexe nos dados e diz onde está a cópia', async (t) => {
  const p = pacote(t);
  const ex = executorFalso(p, { volta: false });
  const painel = painelFalso(p, { novaSobe: false });
  assert.equal(await atualizar({ out: memOut().out, root: p.root, home: p.home, args: ['--registro'], deps: { ...painel.deps, iniciarUnidade: ex.iniciar } }), 1);
  assert.equal(versaoDoPacote(p.base), 'v2.7.0');
  assert.equal(lerEstado(p).resultado, 'falhou');
  assert.match(log(p), /✗ o executor do pacote não voltou para a versão anterior/);
  assert.match(log(p), /a cópia dos dados está em .*\.backups/);
});

test('pacote: pedido negado pelo polkit não muda nada e religa o painel', async (t) => {
  const p = pacote(t);
  const ex = executorFalso(p, { negado: true });
  const painel = painelFalso(p);
  const a = memOut();
  assert.equal(await atualizar({ out: a.out, root: p.root, home: p.home, args: ['--terminal'], deps: { ...painel.deps, iniciarUnidade: ex.iniciar } }), 1);
  assert.deepEqual(ex.pedidos, [UNIDADE_ATUALIZAR]);
  assert.deepEqual(painel.passos, ['parar', 'ligar']);
  assert.equal(versaoDoPacote(p.base), 'v2.6.0');
  assert.match(a.texto(), /✗ o executor do pacote não trocou de versão \(Interactive authentication required\.\)/);
  assert.match(a.texto(), /grupo server-dashboard/);
});

test('pacote: já na mais nova, sem trocar nada; o --pre é recusado no terminal', async (t) => {
  const p = pacote(t, { disponivel: '' });
  const ex = executorFalso(p);
  const painel = painelFalso(p);
  const deps = { ...painel.deps, iniciarUnidade: ex.iniciar };
  const a = memOut();
  assert.equal(await atualizar({ out: a.out, root: p.root, home: p.home, args: ['--terminal'], deps }), 0);
  assert.match(a.texto(), /você já está na versão mais nova \(v2\.6\.0\)/);
  const b = memOut();
  assert.equal(await atualizar({ out: b.out, root: p.root, home: p.home, args: ['--terminal', '--pre'], deps }), 1);
  assert.match(b.texto(), /o pacote não instala pré-versão pelo --pre/);
  assert.equal(fs.existsSync(path.join(p.root, '.atualizacao', 'pre.json')), false, 'nada liberado');
  assert.deepEqual(ex.pedidos, []);
  assert.deepEqual(painel.passos, []);
});

test('pacote: a versão que muda a coleta avisa no fim, no acesso restrito', async (t) => {
  const p = pacote(t, { changelog: CHANGELOG.replace('- novidade da 2.7.0', `${MARCADOR_RECONFIGURAR}\n\n- novidade`) });
  const painel = painelFalso(p);
  const a = memOut();
  assert.equal(await atualizar({ out: a.out, root: p.root, home: p.home, args: ['--terminal'], deps: { ...painel.deps, iniciarUnidade: executorFalso(p).iniciar } }), 0);
  assert.match(a.texto(), /esta versão exige reconfigurar o acesso ao servidor/);
});

test('pacote: o painel procura sem git; bloqueio só sem o .env; reconfigurar sem conferir a tag', (t) => {
  const p = pacote(t);
  const semGit = () => { throw new Error('o git não roda no pacote'); };
  const r = procurar(p.root, { run: semGit, home: p.home, modo: 'sistema', base: p.base });
  assert.equal(r.nova, 'v2.7.0');
  assert.equal(r.bloqueio, null);
  assert.equal(bloqueioDaReconfiguracao(p.root, p.home, semGit, 'sistema'), null);
  fs.rmSync(path.join(p.root, '.env'));
  assert.equal(bloqueioDaPasta(p.root, p.home, semGit, 'sistema'), 'outra-pasta');
  assert.equal(bloqueioDaReconfiguracao(p.root, p.home, semGit, 'sistema'), 'outra-pasta');
});

test('pacote: a agenda relê de hora em hora e guarda a hora da procura do executor', async (t) => {
  const AGORA = Date.parse('2026-11-20T12:00:00Z');
  const base = { agora: AGORA, aleatorio: 0, periodoMs: PERIODO_NO_PACOTE_MS };
  assert.equal(esperaAteProcurar({ ...base, verificadoEm: new Date(AGORA - 20 * 60000).toISOString() }), 40 * 60000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-agenda-'));
  aoFim(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  const verificadoEm = '2026-11-20T03:00:00.000Z';
  const a = new Atualizacao({ file: path.join(dir, 'atualizacao.json'), instalada: 'v2.6.0', loginExigido: true, agora: () => AGORA, procurar: async () => ({ nova: 'v2.7.0', novidades: null, erro: null, verificadoEm, bloqueio: null }) });
  assert.equal((await a.verificar()).verificadoEm, verificadoEm);
  const b = new Atualizacao({ file: path.join(dir, 'b.json'), instalada: 'v2.6.0', loginExigido: true, agora: () => AGORA, procurar: async () => ({ nova: null, verificadoEm: null }) });
  assert.equal((await b.verificar()).verificadoEm, null, 'o executor nunca procurou: sem hora inventada');
});

// Filho falso do spawn: termina como o teste mandar.
function espiao(fim) {
  const chamadas = [];
  const spawnFn = (cmd, args, opts) => {
    chamadas.push({ cmd, args, opts });
    const filho = new EventEmitter();
    filho.unref = () => {};
    setImmediate(() => fim(filho));
    return filho;
  };
  return { chamadas, spawnFn };
}

test('pacote: o painel dispara o lançador do pacote, com as pastas XDG da instalação (I11)', async () => {
  const pastas = pastasDaInstalacao({ ambiente: { SERVER_DASHBOARD_MODO: 'sistema', XDG_DATA_HOME: '/dados/ana' }, home: '/casa/ana', codigo: '/srv/pacote/versoes/v2.6.0' });
  const root = '/srv/pacote/versoes/v2.6.0';
  const u = espiao((f) => f.emit('close', 0));
  assert.deepEqual(await executarForaDoServico({ root, modo: 'systemd', spawnFn: u.spawnFn, pastas }), { ok: true });
  assert.deepEqual(u.chamadas[0].args, ['--user', '--unit=server-dashboard-atualizar', '--collect', '--quiet', `--working-directory=${root}`,
    '--setenv=XDG_CONFIG_HOME=/casa/ana/.config', '--setenv=XDG_DATA_HOME=/dados/ana', '/srv/pacote/bin/dashboard', 'atualizar', '--registro']);
  const r = espiao((f) => f.emit('close', 0));
  await reconfigurarForaDoServico({ root, modo: 'systemd', spawnFn: r.spawnFn, pastas });
  assert.deepEqual(r.chamadas[0].args.slice(-3), ['/srv/pacote/bin/dashboard', 'reconfigurar', '--pela-tela']);
  const s = espiao((f) => f.emit('spawn'));
  await executarForaDoServico({ root, modo: 'segundo-plano', spawnFn: s.spawnFn, pastas });
  assert.equal(s.chamadas[0].cmd, '/srv/pacote/bin/dashboard');
  assert.deepEqual(s.chamadas[0].args, ['atualizar', '--registro']);
});

test('pacote: o serviço usa o link node/bin do pacote, não a pasta do Node que o executor apaga', (t) => {
  const p = pacote(t);
  const pastas = pastasDaInstalacao({ ambiente: { SERVER_DASHBOARD_MODO: 'sistema' }, home: p.home, codigo: p.root });
  const real = '/srv/node-v24.0.0-linux-x64/bin/node';
  assert.equal(serviceNode(p.root, real, pastas), real, 'sem o Node do pacote, o do sistema');
  fs.mkdirSync(path.join(p.base, 'node', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(p.base, 'node', 'bin', 'node'), '');
  assert.equal(serviceNode(p.root, real, pastas), path.join(p.base, 'node', 'bin', 'node'));
});
