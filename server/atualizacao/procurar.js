// Procura versão nova (ADR 0030): git fetch das tags, tag assinada mais nova que a instalada,
// novidades dela e o que impediria a troca de versão. Roda em processo próprio, com prioridade
// baixa: o fetch pode levar até 2 min, a conferência das assinaturas é síncrona, e nada disso
// pode segurar o painel. Não usa SSH nem a trava de coleta (I1). Só lê o clone; o fetch grava no
// espelho bare do painel (ADR 0051), não no .git; a troca fica com o `dashboard atualizar`. No pacote .deb, só
// lê o estado/ do executor, sem git e sem rede (ADR 0048).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentVersionStatus, newestSignedTag } from '../setup/assinatura.js';
import { otherServiceRoot } from '../cli/servico.js';
import { caminhosDoPacote, envDe, pastasDe } from '../config.js';
import { procurarNoPacote } from './pacote.js';
import { recortarNovidades } from './novidades.js';
import { pastaDoPainel, preLiberada } from './registro.js';
import { SIGNERS } from '../setup/assinatura.js';

const TETO_GIT_MS = 120000;
// Sem pergunta nenhuma: o painel roda sem terminal, e uma janela de senha do ssh ficaria aberta.
export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

/** Roda o git na pasta (argumentos em lista), sem perguntas, com teto de 2 min. */
function git(root, args, run) {
  const r = run('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TETO_GIT_MS, env: GIT_ENV, maxBuffer: 4 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout || '' };
}

/** Versão instalada como tag ("v2.0.1"), lida do package.json da pasta (muda com o checkout). */
export const versaoDaPasta = (root) => {
  try { return `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`; } catch { return 'v0.0.0'; }
};

// Só a pasta da instalação troca de versão ou reconfigura pela tela (#118): a que tem o .env e é a
// do serviço. No pacote .deb (modo sistema), o .env fica na pasta XDG da pessoa, e o serviço roda o
// código pelo link `atual`, que é esta pasta (ADR 0048).
const foraDaInstalacao = (root, home) => !fs.existsSync(envDe(root)) || otherServiceRoot(root, home);

// O que impediria o `dashboard atualizar` nesta pasta; null se nada impede. `--no-optional-locks`:
// esta conferência não pode disputar o índice do git com um `dashboard atualizar` em andamento.
// No pacote não há git: o código em /opt é do executor, e ninguém o altera à mão.
export function bloqueioDaPasta(root, home = os.homedir(), run = spawnSync, modo = pastasDe(root).modo) {
  if (foraDaInstalacao(root, home)) return 'outra-pasta';
  if (modo === 'sistema') return null;
  return git(root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], run).stdout.trim() ? 'arquivos-alterados' : null;
}

/**
 * O que faria o `reconfigurar --pela-tela` recusar com o painel já esperando; null se nada impede.
 * Arquivo alterado não entra: o comando não troca de versão e aceita a pasta assim (ADR 0036). No
 * pacote, quem conferiu a assinatura foi o pacote ou o executor (ADR 0042), e não há git aqui.
 */
export function bloqueioDaReconfiguracao(root, home = os.homedir(), run = spawnSync, modo = pastasDe(root).modo) {
  if (foraDaInstalacao(root, home)) return 'outra-pasta';
  if (modo === 'sistema') return null;
  return currentVersionStatus(root, { run }).ok ? null : 'sem-assinatura';
}

/**
 * O espelho bare das tags (ADR 0051): repositório próprio em .atualizacao/painel/espelho.git, a única
 * pasta do registro com escrita do serviço. Nasce vazio e só recebe as tags do `origin` do clone (a
 * URL é lida da configuração, sem escrever nela). Nunca é usado pelo `dashboard atualizar`.
 * Devolve `{ dir, origem }` ou null se não der para criar/ler.
 */
function prepararEspelho(root, run) {
  const dir = path.join(pastaDoPainel(root), 'espelho.git');
  const origem = git(root, ['config', '--get', 'remote.origin.url'], run).stdout.trim();
  if (!origem || origem.startsWith('-')) return null;
  if (!fs.existsSync(path.join(dir, 'HEAD')) && git(path.dirname(dir), ['init', '--quiet', '--bare', dir], run).status !== 0) return null;
  return { dir, origem };
}

/**
 * Procura versão nova. Devolve `{ nova, novidades, bloqueio, erro }`. Sem acesso à internet
 * (`erro: 'sem-acesso'`), segue com as tags que já estão aqui: a versão achada antes continua
 * valendo. No pacote, só lê o estado/ do executor (`base`), sem git e sem rede (ADR 0048).
 */
export function procurar(root, { run = spawnSync, home = os.homedir(), modo = pastasDe(root).modo, base = caminhosDoPacote(root).base } = {}) {
  if (modo === 'sistema') {
    return { ...procurarNoPacote({ base, instalada: versaoDaPasta(root) }), bloqueio: bloqueioDaPasta(root, home, run, modo) };
  }
  if (git(root, ['rev-parse', '--is-inside-work-tree'], run).status !== 0) {
    return { nova: null, novidades: null, bloqueio: 'sem-git', erro: null };
  }
  // O serviço não escreve no .git (ADR 0051): o fetch vai para o espelho, em .atualizacao/painel/.
  const espelho = prepararEspelho(root, run);
  if (!espelho) return { nova: null, novidades: null, bloqueio: bloqueioDaPasta(root, home, run), erro: 'falhou' };
  const erro = git(espelho.dir, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', '--force', '--no-write-fetch-head', '--no-tags', '--', espelho.origem, '+refs/tags/*:refs/tags/*'], run).status === 0 ? null : 'sem-acesso';
  const instalada = versaoDaPasta(root);
  // A lista de chaves é a desta pasta, a da versão instalada. O espelho só alimenta o aviso da tela:
  // a troca de versão confere tudo de novo no .git real (ADR 0051).
  const nova = newestSignedTag(espelho.dir, { current: instalada, signersFile: SIGNERS(root), includePre: instalada.includes('-') || preLiberada(root), run });
  const changelog = nova ? git(espelho.dir, ['show', `${nova}:CHANGELOG.md`], run) : null;
  const novidades = changelog?.status === 0 ? recortarNovidades(changelog.stdout, { de: instalada, ate: nova }) : null;
  return { nova, novidades, bloqueio: bloqueioDaPasta(root, home, run), erro };
}

// Rodado pelo painel (procurarEmProcesso): imprime o resultado em JSON, numa linha.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(procurar(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))));
}
