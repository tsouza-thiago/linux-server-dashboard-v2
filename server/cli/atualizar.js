// `dashboard atualizar` (seção 11): git fetch → tag assinada mais nova (conferida com a
// lista de chaves da versão QUE JÁ ESTÁ instalada: a nova não se autoaprova) → backup de
// data/ → troca de versão → a versão nova liga o painel e confere a saúde → se algo
// falhar, volta sozinha para a versão anterior com o data/ do backup.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SIGNERS, compareVersions, signedReleaseTags, currentVersionStatus } from '../setup/assinatura.js';
import { installService } from '../setup/local.js';
import { panelPort, panelStatus, startPanel, stopPanel, unitPath, waitForPort, systemctlUser, UNIT_NAME } from './servico.js';
import { parseFlags } from './instalar.js';

const KEEP_BACKUPS = 3;

function git(root, args, run = spawnSync) {
  const r = run('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  return { status: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

const versionOf = (root) => {
  try { return `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`; } catch { return 'v0.0.0'; }
};

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

export function restoreData(root, backupDir) {
  const data = path.join(root, 'data');
  fs.rmSync(data, { recursive: true, force: true });
  if (fs.existsSync(path.join(backupDir, 'data'))) fs.cpSync(path.join(backupDir, 'data'), data, { recursive: true, preserveTimestamps: true });
}

/** Painel respondendo de verdade (porta aberta e /api/session em JSON). */
export async function panelHealthy(port, { timeoutMs = 30000 } = {}) {
  if (!(await waitForPort(port, { timeoutMs }))) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { Host: '127.0.0.1' } });
    const body = await res.json();
    return 'authRequired' in body;
  } catch {
    return false;
  }
}

/** Fase 2, rodada pela versão NOVA: refaz o serviço (Node pode ter mudado) e liga o painel. */
export async function afterUpdate({ out, root, home = os.homedir(), deps = {} }) {
  const port = panelPort(root);
  const unit = unitPath(home);
  if (fs.existsSync(unit)) {
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

export async function atualizar({ out, root, args = [], home = os.homedir(), deps = {} }) {
  const flags = parseFlags(args);
  if (flags['pos-atualizacao']) return afterUpdate({ out, root, home, deps });
  out.title('Server Dashboard · atualizar');
  const run = deps.run ?? spawnSync;
  if (git(root, ['rev-parse', '--is-inside-work-tree'], run).status !== 0) {
    out.fail('esta pasta não veio de um git clone');
    out.explain('o atualizar troca de versão com o git.', 'baixe de novo com o comando do README e importe os dados: ./dashboard instalar --importar-v1 não serve aqui; copie a pasta data/.');
    return 1;
  }
  const current = versionOf(root);
  const oldRef = git(root, ['rev-parse', 'HEAD'], run).stdout;
  const fetched = git(root, ['fetch', '--quiet', '--tags', 'origin'], run);
  if (fetched.status !== 0) {
    out.fail('não consegui buscar as versões novas', fetched.stderr.split('\n').pop());
    out.explain('sem acesso ao GitHub agora.', 'confira a internet e rode de novo.');
    return 1;
  }
  // A lista de chaves vem da versão instalada (copiada antes de qualquer checkout).
  const signers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-signers-')), 'allowed_signers');
  fs.copyFileSync(SIGNERS(root), signers);
  const pre = current.includes('-') || Boolean(flags.pre);
  const newer = signedReleaseTags(root, { signersFile: signers, includePre: pre, run: deps.gitRun })
    .filter((t) => compareVersions(t, current) > 0);
  fs.rmSync(path.dirname(signers), { recursive: true, force: true });
  if (!newer.length) {
    out.ok(`você já está na versão mais nova (${current})`);
    return 0;
  }
  const target = newer[0];
  out.ok(`versão nova encontrada: ${target}`, 'assinatura conferida com a chave da versão instalada');
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'], run).stdout;
  if (dirty) {
    out.fail('há arquivos do painel alterados nesta pasta');
    out.explain('trocar de versão apagaria essas alterações.', `guarde ou desfaça as alterações (git status) e rode de novo.`);
    return 1;
  }
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
  const second = (deps.reexec ?? ((a) => spawnSync(path.join(root, 'dashboard'), a, { stdio: 'inherit' }).status))(['atualizar', '--pos-atualizacao']);
  if (second === 0) {
    out.ok(`atualizado de ${current} para ${target}`);
    if (!wasRunning) out.line(out.c.dim('O painel estava parado antes; ele foi ligado para conferir a versão nova.'));
    return 0;
  }
  out.fail(`a versão ${target} não funcionou aqui: voltando para ${current}`);
  await (deps.stopPanel ?? stopPanel)({ root, home });
  git(root, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', oldRef], run);
  restoreData(root, backup);
  const back = (deps.reexec ?? ((a) => spawnSync(path.join(root, 'dashboard'), a, { stdio: 'inherit' }).status))(['atualizar', '--pos-atualizacao']);
  if (back === 0) out.ok(`de volta à ${current}, com os dados de antes da atualização`);
  else out.fail('a versão anterior também não subiu', 'rode ./dashboard diagnosticar');
  out.explain(`a versão ${target} não ligou o painel nesta máquina.`, 'nada foi perdido. Rode ./dashboard diagnosticar e, se quiser, avise no GitHub do projeto.');
  return 1;
}

export { currentVersionStatus };
