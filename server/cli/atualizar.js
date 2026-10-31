// `dashboard atualizar` (ADR 0012): git fetch → tag assinada mais nova (conferida com a
// lista de chaves da versão QUE JÁ ESTÁ instalada: a nova não se autoaprova) → backup de
// data/ → troca de versão → a versão nova liga o painel e confere a saúde → se algo
// falhar, volta sozinha para a versão anterior com o data/ do backup. Com --registro (quem
// roda é o painel, ADR 0031), as linhas e as fases vão para .atualizacao/ em vez do terminal.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SIGNERS, newestSignedTag } from '../setup/assinatura.js';
import { GIT_ENV, versaoDaPasta } from '../atualizacao/procurar.js';
import { abrirRegistro, pegarTrava, soltarTrava } from '../atualizacao/registro.js';
import { installService, situacaoDoLink } from '../setup/local.js';
import { otherServiceRoot, panelPort, panelStatus, startPanel, stopPanel, unitPath, waitForPort, systemctlUser, UNIT_NAME } from './servico.js';
import { parseFlags } from './instalar.js';
import { makeOutput } from './saida.js';

// Cópias de data/ guardadas em .backups/ (as mais antigas saem).
const KEEP_BACKUPS = 3;

/** Roda o git na pasta do painel (argumentos em lista, teto de 2 min) e devolve o resultado. */
function git(root, args, run = spawnSync, env = process.env) {
  const r = run('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env });
  return { status: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/** Copia data/ para .backups/<data>-<versão>/ (0700) e mantém só os 3 mais novos. */
export function backupData(root, label, now = new Date()) {
  const base = path.join(root, '.backups');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  const dir = path.join(base, `${now.toISOString().replace(/[:.]/g, '-')}-${label}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const data = path.join(root, 'data');
  if (fs.existsSync(data)) fs.cpSync(data, path.join(dir, 'data'), { recursive: true, preserveTimestamps: true });
  const all = fs.readdirSync(base).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(base, old), { recursive: true, force: true });
  return dir;
}

/** Volta o data/ da cópia de segurança (quando a versão nova falhou). */
export function restoreData(root, backupDir) {
  const data = path.join(root, 'data');
  fs.rmSync(data, { recursive: true, force: true });
  if (fs.existsSync(path.join(backupDir, 'data'))) fs.cpSync(path.join(backupDir, 'data'), data, { recursive: true, preserveTimestamps: true });
}

/** Painel respondendo de verdade (porta aberta e /api/session em JSON). */
async function panelHealthy(port, { timeoutMs = 30000 } = {}) {
  if (!(await waitForPort(port, { timeoutMs }))) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { Host: '127.0.0.1' } });
    const body = await res.json();
    return 'authRequired' in body;
  } catch {
    return false;
  }
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
  if (!fs.existsSync(path.join(root, '.env'))) {
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

/** As conferências da pasta e a trava: 2 atualizações ao mesmo tempo trocariam o código uma da outra. */
async function atualizarAqui({ out, root, home, deps, flags, registro }) {
  out.title('Server Dashboard · atualizar');
  if (!checkFolder({ out, root, home })) return 1;
  const run = deps.run ?? spawnSync;
  if (git(root, ['rev-parse', '--is-inside-work-tree'], run).status !== 0) {
    out.fail('esta pasta não veio de um git clone');
    out.explain('o atualizar troca de versão com o git.', `baixe de novo com o comando do README e importe os dados: ${out.cmd} instalar --importar-v1 não serve aqui; copie a pasta data/.`);
    return 1;
  }
  if (!pegarTrava(root, deps.trava)) {
    out.fail('já há uma atualização rodando nesta pasta');
    out.explain('2 atualizações ao mesmo tempo trocariam o código uma da outra.', 'espere ela terminar. O painel mostra o andamento.');
    return 1;
  }
  try {
    return await trocarDeVersao({ out, root, home, deps, flags, run, registro });
  } finally {
    soltarTrava(root);
  }
}

// Rodado pelo painel (ADR 0031): sem terminal, tudo vai para .atualizacao/.
async function comRegistro({ root, home, deps, flags }) {
  const registro = abrirRegistro(root);
  const out = makeOutput({ stream: registro.stream, root });
  let codigo = 1;
  try {
    codigo = await atualizarAqui({ out, root, home, deps, flags, registro });
  } catch (err) {
    out.fail('a atualização parou', err.message);
  }
  registro.fim(codigo);
  return codigo;
}

/**
 * `./dashboard atualizar`. Opções: --pre (aceita pré-versão), --registro (interna: escreve em
 * .atualizacao/, usada pelo painel) e --pos-atualizacao (interna: a 2ª fase, rodada pela versão
 * nova). Devolve 0 atualizado ou já na mais nova, 1 falha.
 */
export async function atualizar({ out, root, args = [], home = os.homedir(), deps = {} }) {
  const flags = parseFlags(args);
  if (flags['pos-atualizacao']) return afterUpdate({ out, root, home, deps });
  if (flags.registro) return comRegistro({ root, home, deps, flags });
  return atualizarAqui({ out, root, home, deps, flags });
}
