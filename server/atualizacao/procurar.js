// Procura versão nova (ADR 0030): git fetch das tags, tag assinada mais nova que a instalada,
// novidades dela e o que impediria a troca de versão. Roda em processo próprio, com prioridade
// baixa: o fetch pode levar até 2 min, a conferência das assinaturas é síncrona, e nada disso
// pode segurar o painel. Não usa SSH nem a trava de coleta (I1). Só lê, menos as tags que o
// fetch traz para o .git; a troca de versão fica com o `dashboard atualizar`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestSignedTag } from '../setup/assinatura.js';
import { otherServiceRoot } from '../cli/servico.js';
import { recortarNovidades } from './novidades.js';

const TETO_GIT_MS = 120000;
// Sem pergunta nenhuma: o painel roda sem terminal, e uma janela de senha do ssh ficaria aberta.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

/** Roda o git na pasta (argumentos em lista), sem perguntas, com teto de 2 min. */
function git(root, args, run) {
  const r = run('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TETO_GIT_MS, env: GIT_ENV, maxBuffer: 4 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout || '' };
}

/** Versão instalada como tag ("v2.0.1"), lida do package.json da pasta (muda com o checkout). */
export const versaoDaPasta = (root) => {
  try { return `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`; } catch { return 'v0.0.0'; }
};

// O que impediria o `dashboard atualizar` nesta pasta; null se nada impede. `--no-optional-locks`:
// esta conferência não pode disputar o índice do git com um `dashboard atualizar` em andamento.
function bloqueioDaPasta(root, home, run) {
  if (!fs.existsSync(path.join(root, '.env')) || otherServiceRoot(root, home)) return 'outra-pasta';
  return git(root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], run).stdout.trim() ? 'arquivos-alterados' : null;
}

/**
 * Procura versão nova. Devolve `{ nova, novidades, bloqueio, erro }`. Sem acesso à internet
 * (`erro: 'sem-acesso'`), segue com as tags que já estão aqui: a versão achada antes continua
 * valendo.
 */
export function procurar(root, { run = spawnSync, home = os.homedir() } = {}) {
  if (git(root, ['rev-parse', '--is-inside-work-tree'], run).status !== 0) {
    return { nova: null, novidades: null, bloqueio: 'sem-git', erro: null };
  }
  const erro = git(root, ['fetch', '--quiet', '--tags', 'origin'], run).status === 0 ? null : 'sem-acesso';
  const instalada = versaoDaPasta(root);
  // A lista de chaves é a desta pasta, a da versão instalada: nada mudou de versão aqui.
  const nova = newestSignedTag(root, { current: instalada, includePre: instalada.includes('-'), run });
  const changelog = nova ? git(root, ['show', `${nova}:CHANGELOG.md`], run) : null;
  const novidades = changelog?.status === 0 ? recortarNovidades(changelog.stdout, { de: instalada, ate: nova }) : null;
  return { nova, novidades, bloqueio: bloqueioDaPasta(root, home, run), erro };
}

// Rodado pelo painel (procurarEmProcesso): imprime o resultado em JSON, numa linha.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(procurar(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))));
}
