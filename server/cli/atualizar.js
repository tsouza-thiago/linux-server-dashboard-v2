// `dashboard atualizar` (ADR 0012): git fetch → tag assinada mais nova (conferida com a
// lista de chaves da versão QUE JÁ ESTÁ instalada: a nova não se autoaprova) → backup de
// data/ → troca de versão → a versão nova liga o painel e confere a saúde → se algo
// falhar, volta sozinha para a versão anterior com o data/ do backup. Com --registro (quem
// roda é o painel, ADR 0031), as linhas e as fases vão para .atualizacao/ em vez do terminal.
// Sem --terminal e com tela, o comando só abre o painel no diálogo da versão nova (ADR 0032).
// No pacote .deb (modo sistema, ADR 0048), não há git: quem troca o código em /opt é o executor do
// pacote, pedido pelas unidades do sistema; aqui ficam a cópia dos dados, a saúde e a volta.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SIGNERS, newestSignedTag } from '../setup/assinatura.js';
import { GIT_ENV, versaoDaPasta } from '../atualizacao/procurar.js';
import { recortarNovidades } from '../atualizacao/novidades.js';
import { abrirRegistro, cancelarPre, liberarPre, pegarTrava, preLiberada, soltarTrava } from '../atualizacao/registro.js';
import { UNIDADE_ATUALIZAR, UNIDADE_VOLTAR, iniciarUnidade, procurarNoPacote, registroDesde, tamanhoDoRegistro, versaoDoPacote } from '../atualizacao/pacote.js';
import { backupsDe, caminhosDoPacote, dataDe, envDe, loadEnvFile, pastasDe } from '../config.js';
import { installService, situacaoDoLink } from '../setup/local.js';
import { motivoSemPainel, openBrowser, otherServiceRoot, panelHealthy, panelPort, panelStatus, panelUrl, startPanel, stopPanel, unitPath, systemctlUser, UNIT_NAME } from './servico.js';
import { parseFlags } from './instalar.js';
import { makeOutput } from './saida.js';

// Cópias de data/ guardadas em .backups/ (as mais antigas saem).
const KEEP_BACKUPS = 3;
// A tela do painel que o `dashboard atualizar` abre: o menu de manutenção, com o diálogo aberto.
const TELA_DE_ATUALIZAR = '#/visao-geral?atualizar=1';

/** Roda o git na pasta do painel (argumentos em lista, teto de 2 min) e devolve o resultado. */
function git(root, args, run = spawnSync, env = process.env) {
  const r = run('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env });
  return { status: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/** Copia data/ para .backups/<data>-<versão>/ (0700) e mantém só os 3 mais novos. */
export function backupData(root, label, now = new Date()) {
  const base = backupsDe(root);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  const dir = path.join(base, `${now.toISOString().replace(/[:.]/g, '-')}-${label}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const data = dataDe(root);
  if (fs.existsSync(data)) fs.cpSync(data, path.join(dir, 'data'), { recursive: true, preserveTimestamps: true });
  const all = fs.readdirSync(base).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(base, old), { recursive: true, force: true });
  return dir;
}

/** Volta o data/ da cópia de segurança (quando a versão nova falhou). */
export function restoreData(root, backupDir) {
  const data = dataDe(root);
  fs.rmSync(data, { recursive: true, force: true });
  if (fs.existsSync(path.join(backupDir, 'data'))) fs.cpSync(path.join(backupDir, 'data'), data, { recursive: true, preserveTimestamps: true });
}

// Pasta da instalação desta máquina, se for outra: a do serviço ou a do comando `dashboard`.
function installedElsewhere(root, home) {
  const service = otherServiceRoot(root, home);
  if (service) return service;
  const link = situacaoDoLink({ root, home });
  return link.estado === 'outra-pasta' ? path.dirname(link.alvo) : null;
}

/**
 * Esta pasta pode ser atualizada? Sem .env ela não é uma instalação, e o serviço de outra pasta
 * não pode mudar para cá (#118): a pasta passaria a servir o painel sem login e sem o servidor.
 * Devolve false depois de explicar; mudar de pasta de propósito é com o instalar/reconfigurar.
 */
function checkFolder({ out, root, home }) {
  const installed = installedElsewhere(root, home);
  if (!fs.existsSync(envDe(root))) {
    out.fail('esta pasta não é uma instalação do painel', 'não tem .env');
    out.explain(`o atualizar só vale na pasta da instalação. Nada foi alterado em ${root}.`, installed
      ? `a instalação está em ${installed}. Rode lá: cd "${installed}" && ./dashboard atualizar`
      : `rode na pasta onde o painel foi instalado ou instale nesta com ${out.cmd} instalar.`);
    return false;
  }
  const service = otherServiceRoot(root, home);
  if (service) {
    out.fail('o serviço do painel roda de outra pasta');
    out.line(`  Serviço:     ${service}`);
    out.line(`  Esta pasta:  ${root}`);
    out.explain('atualizar daqui levaria o serviço para esta pasta. Nada foi alterado.',
      `rode na pasta do serviço: cd "${service}" && ./dashboard atualizar. Para mudar o serviço para cá de propósito, rode ${out.cmd} reconfigurar nesta pasta.`);
    return false;
  }
  return true;
}

/** Fase 2, rodada pela versão NOVA: refaz o serviço (Node pode ter mudado) e liga o painel. */
export async function afterUpdate({ out, root, home = os.homedir(), deps = {} }) {
  const port = panelPort(root);
  const unit = unitPath(home);
  if (fs.existsSync(unit)) {
    // A fase 1 já confere; aqui protege a fase 1 de uma versão anterior, que não conferia.
    const other = otherServiceRoot(root, home);
    if (other) { out.fail('o serviço do painel roda de outra pasta', other); return 1; }
    const enabled = (systemctlUser(['is-enabled', UNIT_NAME])?.stdout || '').trim() === 'enabled';
    const r = await (deps.installService ?? installService)({ root, home, enable: enabled });
    if (!r.ok) { out.fail('o serviço não subiu na versão nova', r.error); return 1; }
  } else {
    const r = await (deps.startPanel ?? startPanel)({ root, home });
    if (!r.ok) { out.fail('o painel não subiu na versão nova', r.error); return 1; }
  }
  if (!(await (deps.healthy ?? panelHealthy)(port))) { out.fail('o painel não respondeu na versão nova'); return 1; }
  out.ok('versão nova no ar', `http://127.0.0.1:${port}`);
  return 0;
}

/** A versão nova muda o script de coleta? Só o acesso restrito guarda o script no servidor. */
function exigeReconfigurar({ root, run, de, ate }) {
  if (loadEnvFile(envDe(root)).SSH_ACESSO !== 'restrito') return false;
  const changelog = git(root, ['show', `${ate}:CHANGELOG.md`], run);
  return changelog.status === 0 && recortarNovidades(changelog.stdout, { de, ate }).exigeReconfigurar;
}

/**
 * A troca de versão em si, com a trava já pega. `registro` só existe quando quem roda é o painel:
 * as fases vão para a tela, a fase 2 escreve no mesmo log e o git não pode perguntar nada.
 */
async function trocarDeVersao({ out, root, home, deps, flags, run, registro }) {
  const marcar = registro?.marcar ?? (() => {});
  const stdio = registro ? ['ignore', registro.fd, registro.fd] : 'inherit';
  const reexec = deps.reexec ?? ((a) => spawnSync(path.join(root, 'dashboard'), a, { stdio }).status);
  marcar({ fase: 'procurando' });
  const current = versaoDaPasta(root);
  const oldRef = git(root, ['rev-parse', 'HEAD'], run).stdout;
  const fetched = git(root, ['fetch', '--quiet', '--tags', 'origin'], run, registro ? GIT_ENV : process.env);
  if (fetched.status !== 0) {
    out.fail('não consegui buscar as versões novas', fetched.stderr.split('\n').pop());
    out.explain('sem acesso ao GitHub agora.', 'confira a internet e rode de novo.');
    return 1;
  }
  // A lista de chaves vem da versão instalada (copiada antes de qualquer checkout).
  const signers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-signers-')), 'allowed_signers');
  fs.copyFileSync(SIGNERS(root), signers);
  // Pré-versões só para quem já está numa ou pediu --pre (AGENTS, "Versões").
  const pre = current.includes('-') || Boolean(flags.pre);
  const target = newestSignedTag(root, { current, signersFile: signers, includePre: pre, run: deps.gitRun });
  fs.rmSync(path.dirname(signers), { recursive: true, force: true });
  if (!target) {
    out.ok(`você já está na versão mais nova (${current})`);
    marcar({ resultado: 'ja-na-mais-nova' });
    return 0;
  }
  out.ok(`versão nova encontrada: ${target}`, 'assinatura conferida com a chave da versão instalada');
  marcar({ alvo: target, de: current });
  // Arquivo do painel alterado à mão: o checkout apagaria a alteração, então para aqui.
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'], run).stdout;
  if (dirty) {
    out.fail('há arquivos do painel alterados nesta pasta');
    out.explain('trocar de versão apagaria essas alterações.', `guarde ou desfaça as alterações (git status) e rode de novo.`);
    return 1;
  }
  marcar({ fase: 'trocando' });
  const wasRunning = (deps.panelStatus ?? panelStatus)({ root, home }).running;
  await (deps.stopPanel ?? stopPanel)({ root, home });
  const backup = backupData(root, current);
  out.ok('cópia de segurança de data/ feita', path.relative(root, backup));
  const co = git(root, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', target], run);
  if (co.status !== 0) {
    out.fail('não consegui trocar de versão', co.stderr.split('\n').pop());
    if (wasRunning) await (deps.startPanel ?? startPanel)({ root, home });
    return 1;
  }
  // A versão nova liga o painel (o ./dashboard dela garante o Node que ela pede).
  marcar({ fase: 'ligando' });
  const second = reexec(['atualizar', '--pos-atualizacao']);
  if (second === 0) {
    out.ok(`atualizado de ${current} para ${target}`);
    if (!wasRunning) out.line(out.c.dim('O painel estava parado antes; ele foi ligado para conferir a versão nova.'));
    if (exigeReconfigurar({ root, run, de: current, ate: target })) {
      out.warn('esta versão exige reconfigurar o acesso ao servidor', `rode ${out.cmd} reconfigurar e confirme o passo "Preparar o servidor"`);
    }
    return 0;
  }
  // A versão nova não subiu: volta o código e os dados, e a versão anterior se liga de novo.
  marcar({ fase: 'voltando', resultado: 'voltou' });
  out.fail(`a versão ${target} não funcionou aqui: voltando para ${current}`);
  await (deps.stopPanel ?? stopPanel)({ root, home });
  git(root, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', oldRef], run);
  restoreData(root, backup);
  const back = reexec(['atualizar', '--pos-atualizacao']);
  if (back === 0) out.ok(`de volta à ${current}, com os dados de antes da atualização`);
  else out.fail('a versão anterior também não subiu', `rode ${out.cmd} diagnosticar`);
  out.explain(`a versão ${target} não ligou o painel nesta máquina.`, `nada foi perdido. Rode ${out.cmd} diagnosticar e, se quiser, avise no GitHub do projeto.`);
  return 1;
}

/**
 * A troca pelo pacote .deb (ADR 0042 item 4 e ADR 0048), com a trava já pega: a cópia dos dados da
 * pessoa, a unidade `atualizar` do executor (sem parâmetro: ela instala a versão que o `verificar`
 * conferiu), a versão nova liga o painel e, se ele não responder, a unidade `voltar` e os dados da
 * cópia. Este processo nunca grava em /opt: só o executor troca o código (`pacote` é a base dele).
 */
async function trocarNoPacote({ out, root, home, deps, pacote, registro }) {
  const marcar = registro?.marcar ?? (() => {});
  const stdio = registro ? ['ignore', registro.fd, registro.fd] : 'inherit';
  // O lançador resolve o link `atual` de novo: a fase 2 roda a versão que o executor deixou lá.
  const reexec = deps.reexec ?? ((a) => spawnSync(path.join(pacote, 'bin', 'dashboard'), a, { stdio }).status);
  const pedir = deps.iniciarUnidade ?? iniciarUnidade;
  // A tela de progresso junta o registro do executor ao desta troca (ADR 0042, item 4.6).
  const executor = (unidade) => {
    const desde = tamanhoDoRegistro(pacote);
    const r = pedir(unidade);
    for (const linha of registroDesde(pacote, desde).split('\n').filter(Boolean)) out.line(`  executor: ${linha}`);
    return r;
  };
  marcar({ fase: 'procurando' });
  const current = versaoDaPasta(root);
  const { nova: target, novidades, erro } = procurarNoPacote({ base: pacote, instalada: current });
  if (!target) {
    if (erro) out.warn('a última procura do pacote não alcançou o GitHub', 'o pacote procura de novo 1 vez por dia');
    out.ok(`você já está na versão mais nova (${current})`);
    marcar({ resultado: 'ja-na-mais-nova' });
    return 0;
  }
  out.ok(`versão nova encontrada: ${target}`, 'assinatura conferida pelo executor do pacote');
  marcar({ alvo: target, de: current });
  marcar({ fase: 'trocando' });
  const wasRunning = (deps.panelStatus ?? panelStatus)({ root, home }).running;
  await (deps.stopPanel ?? stopPanel)({ root, home });
  const backup = backupData(root, current);
  out.ok('cópia de segurança dos dados feita', path.relative(pastasDe(root).dados, backup));
  const troca = executor(UNIDADE_ATUALIZAR);
  // Vale o link `atual`, não só o código de saída: é ele que o lançador e o serviço seguem.
  const alvo = versaoDoPacote(pacote);
  if (!alvo || alvo === current) {
    out.fail('o executor do pacote não trocou de versão', troca.erro ?? 'o link atual não mudou');
    out.explain('nada mudou no código do painel.', `confira se você está no grupo server-dashboard (rode: id). Se entrou nele agora há pouco, saia e entre de novo na sessão. Depois, rode ${out.cmd} atualizar de novo.`);
    if (wasRunning) await (deps.startPanel ?? startPanel)({ root, home });
    return 1;
  }
  // O timer pode ter achado uma versão mais nova entre a leitura e o pedido.
  if (alvo !== target) marcar({ alvo });
  marcar({ fase: 'ligando' });
  if (reexec(['atualizar', '--pos-atualizacao']) === 0) {
    out.ok(`atualizado de ${current} para ${alvo}`);
    if (!wasRunning) out.line(out.c.dim('O painel estava parado antes; ele foi ligado para conferir a versão nova.'));
    if (alvo === target && novidades?.exigeReconfigurar && loadEnvFile(envDe(root)).SSH_ACESSO === 'restrito') {
      out.warn('esta versão exige reconfigurar o acesso ao servidor', `rode ${out.cmd} reconfigurar e confirme o passo "Preparar o servidor"`);
    }
    return 0;
  }
  // A versão nova não subiu: o executor volta o código, e os dados voltam da cópia.
  marcar({ fase: 'voltando', resultado: 'voltou' });
  out.fail(`a versão ${alvo} não funcionou aqui: voltando para ${current}`);
  await (deps.stopPanel ?? stopPanel)({ root, home });
  const volta = executor(UNIDADE_VOLTAR);
  if (versaoDoPacote(pacote) !== current) {
    // O código continua na versão nova: os dados ficam como ela os deixou, e a cópia fica guardada.
    marcar({ resultado: 'falhou' });
    out.fail('o executor do pacote não voltou para a versão anterior', volta.erro ?? 'o link atual não mudou');
    out.explain(`a versão ${alvo} continua instalada, e a cópia dos dados está em ${backup}.`, `rode ${out.cmd} diagnosticar e avise no GitHub do projeto.`);
    return 1;
  }
  restoreData(root, backup);
  const back = reexec(['atualizar', '--pos-atualizacao']);
  if (back === 0) out.ok(`de volta à ${current}, com os dados de antes da atualização`);
  else out.fail('a versão anterior também não subiu', `rode ${out.cmd} diagnosticar`);
  out.explain(`a versão ${alvo} não ligou o painel nesta máquina.`, `nada foi perdido. Rode ${out.cmd} diagnosticar e, se quiser, avise no GitHub do projeto.`);
  return 1;
}

/** Abre o painel já logado, no diálogo da versão nova. false: a atualização segue no terminal. */
async function abrirNoPainel({ out, root, home, deps, flags }) {
  const motivo = await motivoSemPainel({ root, home, deps });
  if (motivo) {
    out.warn(motivo, 'sigo aqui no terminal');
    return false;
  }
  if (flags.pre) liberarPre(root);
  if (!(deps.openBrowser ?? openBrowser)(panelUrl(root, panelPort(root), TELA_DE_ATUALIZAR).url)) {
    cancelarPre(root);
    out.warn('não consegui abrir o navegador', 'sigo aqui no terminal');
    return false;
  }
  out.ok('painel aberto no navegador', 'a atualização continua no diálogo da versão nova');
  out.line(out.c.dim(`Prefere o terminal? Rode ${out.cmd} atualizar --terminal.`));
  return true;
}

/** As conferências da pasta e a trava: 2 atualizações ao mesmo tempo trocariam o código uma da outra. */
async function atualizarAqui({ out, root, home, deps, flags, registro, pacote }) {
  out.title('Server Dashboard · atualizar');
  if (!checkFolder({ out, root, home })) return 1;
  const run = deps.run ?? spawnSync;
  // A unidade do executor não recebe parâmetro, e liberar o --pre pediria uma pasta que a pessoa
  // grava e o executor lê (ADR 0048): no pacote, pré-versão só para quem já está numa.
  if (pacote && flags.pre && !registro) {
    out.fail('o pacote não instala pré-versão pelo --pre');
    out.explain('o executor do pacote só aceita pré-versão para quem já está numa.', `rode ${out.cmd} atualizar sem o --pre.`);
    return 1;
  }
  if (!pacote && git(root, ['rev-parse', '--is-inside-work-tree'], run).status !== 0) {
    out.fail('esta pasta não veio de um git clone');
    out.explain('o atualizar troca de versão com o git.', `baixe de novo com o comando do README e importe os dados: ${out.cmd} instalar --importar-v1 não serve aqui; copie a pasta data/.`);
    return 1;
  }
  if (!registro && !flags.terminal && await abrirNoPainel({ out, root, home, deps, flags })) return 0;
  if (!(registro ? registro.pegarTrava(deps.trava) : pegarTrava(root, deps.trava))) {
    out.fail('já há uma atualização rodando nesta pasta');
    out.explain('2 atualizações ao mesmo tempo trocariam o código uma da outra.', 'espere ela terminar. O painel mostra o andamento.');
    return 1;
  }
  try {
    if (pacote) return await trocarNoPacote({ out, root, home, deps, pacote, registro });
    return await trocarDeVersao({ out, root, home, deps, flags, run, registro });
  } finally {
    // Com registro, quem solta é o `fim`, depois de gravar o estado final (#130).
    if (!registro) soltarTrava(root);
  }
}

// Rodado pelo painel (ADR 0031): sem terminal, tudo vai para .atualizacao/.
async function comRegistro({ root, home, deps, flags, pacote }) {
  const registro = abrirRegistro(root);
  const out = makeOutput({ stream: registro.stream, root });
  let codigo = 1;
  try {
    // O comando do executor é fixo (I11): o --pre chega pelo que o dono liberou no terminal.
    codigo = await atualizarAqui({ out, root, home, deps, flags: { ...flags, pre: !pacote && preLiberada(root) }, registro, pacote });
  } catch (err) {
    out.fail('a atualização parou', err.message);
  }
  cancelarPre(root);
  registro.fim(codigo);
  return codigo;
}

/**
 * `./dashboard atualizar`. Opções: --terminal (não abre o painel), --pre (aceita pré-versão),
 * --registro (interna: escreve em .atualizacao/, usada pelo painel) e --pos-atualizacao (interna:
 * a 2ª fase, rodada pela versão nova). Devolve 0 aberto no painel, atualizado ou já na mais nova;
 * 1 falha.
 */
export async function atualizar({ out, root, args = [], home = os.homedir(), deps = {} }) {
  const flags = parseFlags(args);
  if (flags['pos-atualizacao']) return afterUpdate({ out, root, home, deps });
  // A base do pacote .deb (modo sistema); null no clone. Os testes passam uma base falsa.
  const pacote = deps.pacote ?? (pastasDe(root).modo === 'sistema' ? caminhosDoPacote(root).base : null);
  if (flags.registro) return comRegistro({ root, home, deps, flags, pacote });
  return atualizarAqui({ out, root, home, deps, flags, pacote });
}
