// Versão conferida (ADR 0012): as releases são tags assinadas com a chave SSH do
// mantenedor, listada em docs/allowed_signers. O instalador e o `dashboard atualizar`
// recusam versão sem assinatura válida (exceto com --sem-assinatura, para quem desenvolve).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SIGNERS = (root) => path.join(root, 'docs', 'allowed_signers');
export const RELEASE_TAG = /^v2\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/;

function git(root, args, run = spawnSync) {
  const r = run('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { status: -1, stdout: '', stderr: r.error.code === 'ENOENT' ? 'git não encontrado' : r.error.message };
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/** Comparação SemVer (com pre-release alpha < beta < rc < final). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(v);
    if (!m) return null;
    const pre = { alpha: 0, beta: 1, rc: 2 }[m[4]] ?? (m[4] ? -1 : 3);
    return [Number(m[1]), Number(m[2]), Number(m[3]), pre, Number(m[5] || 0)];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < pa.length; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Confere a assinatura de uma tag com uma lista de chaves (por padrão a desta pasta; no
 * `atualizar`, a da versão que já estava instalada: a nova não pode se autoaprovar).
 */
export function verifyTag(root, tag, { signersFile = SIGNERS(root), run } = {}) {
  if (!RELEASE_TAG.test(tag)) return { ok: false, reason: 'tag-invalida' };
  if (!fs.existsSync(signersFile) || !/\S/.test(fs.readFileSync(signersFile, 'utf8').replace(/^#.*$/gm, ''))) {
    return { ok: false, reason: 'sem-chaves' };
  }
  // Tudo fixado na linha de comando: nenhuma configuração do git da pessoa (outro programa
  // de assinatura, outra lista de chaves) muda o resultado.
  const r = git(root, [
    '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${signersFile}`,
    'verify-tag', tag,
  ], run);
  if (r.status === 0) return { ok: true, tag };
  if (/no signature found|cannot verify a non-tag/i.test(r.stderr)) return { ok: false, reason: 'sem-assinatura', tag };
  return { ok: false, reason: 'invalida', tag, detail: r.stderr.split('\n').pop() };
}

/** Versão desta pasta: a tag exata do commit atual e se a assinatura confere. */
export function currentVersionStatus(root, { run } = {}) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'], run);
  if (inside.status !== 0) return { ok: false, reason: inside.status === -1 ? 'sem-git' : 'sem-repositorio' };
  const tags = git(root, ['tag', '--points-at', 'HEAD'], run).stdout.split('\n').filter((t) => RELEASE_TAG.test(t));
  if (!tags.length) return { ok: false, reason: 'sem-tag' };
  tags.sort(compareVersions);
  return verifyTag(root, tags.at(-1), { run });
}

/** Tags de release assinadas, da mais nova para a mais antiga. */
export function signedReleaseTags(root, { signersFile, includePre = true, run } = {}) {
  const all = git(root, ['tag', '--list', 'v2.*'], run).stdout.split('\n').filter((t) => RELEASE_TAG.test(t));
  return all
    .filter((t) => includePre || !t.includes('-'))
    .sort((a, b) => compareVersions(b, a))
    .filter((t) => verifyTag(root, t, { signersFile, run }).ok);
}

/** Frase da verificação para o terminal e o passo 1. */
export function describeVersion(st) {
  if (st.ok) return `versão ${st.tag} — assinatura conferida`;
  return {
    'sem-git': 'git não encontrado: não dá para conferir a assinatura',
    'sem-repositorio': 'esta pasta não veio de um git clone: não dá para conferir a assinatura',
    'sem-tag': 'esta pasta não está numa versão publicada (tag)',
    'sem-chaves': 'docs/allowed_signers está vazio: nenhuma chave para conferir',
    'sem-assinatura': `a versão ${st.tag} não tem assinatura`,
    invalida: `a assinatura da versão ${st.tag} não confere`,
    'tag-invalida': 'nome de versão inválido',
  }[st.reason] || 'versão não conferida';
}
