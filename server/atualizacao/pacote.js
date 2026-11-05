// Atualização pelo pacote .deb (modo sistema, F9 etapa 8, ADR 0048). O painel não roda o git: ele
// lê o que o executor (libexec/atualizador) gravou em <base>/estado/ e pede as 2 unidades de uso
// único do sistema, sem parâmetro (ADR 0044 e 0045). Quem libera o pedido é a regra do polkit,
// pelo grupo server-dashboard (ADR 0046). Os nomes das unidades são fixos: nada da tela entra (I11).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_TAG, compareVersions } from '../setup/assinatura.js';
import { recortarNovidades } from './novidades.js';

export const UNIDADE_ATUALIZAR = 'server-dashboard-atualizar.service';
export const UNIDADE_VOLTAR = 'server-dashboard-voltar.service';
// O `systemctl start` da unidade de uso único espera ela terminar. O teto é o da unidade
// `atualizar` (TimeoutStartSec=20min, por causa do download do Node, ADR 0047) mais 1 min.
const TETO_UNIDADE_MS = 21 * 60000;
// Maior arquivo de estado lido: os de chave=valor têm poucas linhas; o novidades.md, até 256 KB.
const MAX_CHAVES = 4096;
const MAX_NOVIDADES = 256 * 1024;
// Maior pedaço do registro do executor copiado para o log da troca, por pedido.
const MAX_REGISTRO = 64 * 1024;

const estado = (base, nome) => path.join(base, 'estado', nome);

// Lê no máximo `max` bytes do começo do arquivo; null se ele faltar.
function lerInicio(arquivo, max) {
  let fd;
  try { fd = fs.openSync(arquivo, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(max);
    return buf.subarray(0, fs.readSync(fd, buf, 0, max, 0)).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** As chaves de um arquivo `chave=valor` de estado/ (ADR 0044, item 6); {} sem o arquivo. */
export function lerChaves(arquivo) {
  const out = {};
  for (const linha of (lerInicio(arquivo, MAX_CHAVES) ?? '').split('\n')) {
    const m = /^([a-z]+)=(.*)$/.exec(linha);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

/** A versão para onde aponta o link `versoes/atual` do pacote ("v2.6.0"); null sem ele. */
export function versaoDoPacote(base) {
  try {
    const nome = path.basename(fs.realpathSync(path.join(base, 'versoes', 'atual')));
    return RELEASE_TAG.test(nome) ? nome : null;
  } catch {
    return null;
  }
}

/**
 * O que o `verificar` do executor achou (no lugar do `git fetch` da ADR 0030). Devolve
 * `{ nova, novidades, erro, verificadoEm }`. O executor já conferiu a assinatura e o nome gravado
 * na tag; aqui a versão só passa pelo formato e precisa ser mais nova que a instalada.
 */
export function procurarNoPacote({ base, instalada }) {
  const d = lerChaves(estado(base, 'disponivel'));
  const segundos = Number(d.verificado);
  const verificadoEm = d.verificado && Number.isInteger(segundos) && segundos > 0 ? new Date(segundos * 1000).toISOString() : null;
  // O executor grava `falhou` quando o git fetch falha: para a tela, é falta de acesso ao GitHub.
  const erro = d.erro === 'falhou' ? 'sem-acesso' : null;
  const nova = RELEASE_TAG.test(d.versao ?? '') && compareVersions(d.versao, instalada) > 0 ? d.versao : null;
  const md = nova ? lerInicio(estado(base, 'novidades.md'), MAX_NOVIDADES) : null;
  const novidades = md ? recortarNovidades(md, { de: instalada, ate: nova }) : null;
  return { nova, novidades, erro, verificadoEm };
}

/** Tamanho do registro do executor agora: a troca copia só o que vier depois dele. */
export function tamanhoDoRegistro(base) {
  try { return fs.statSync(estado(base, 'registro.log')).size; } catch { return 0; }
}

/**
 * As linhas que o executor escreveu no estado/registro.log desde `desde` (até 64 KB). Se o log
 * girou (ficou menor), lê do começo do novo.
 */
export function registroDesde(base, desde) {
  let fd;
  try { fd = fs.openSync(estado(base, 'registro.log'), 'r'); } catch { return ''; }
  try {
    const { size } = fs.fstatSync(fd);
    const de = desde > size ? 0 : desde;
    const buf = Buffer.alloc(Math.min(size - de, MAX_REGISTRO));
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, de)).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Pede uma unidade do executor ao systemd do sistema: `systemctl start` sem parâmetro e sem pedir
 * senha (sem terminal, o pedido que o polkit não libera falha logo). Só os 2 nomes fixos.
 */
export function iniciarUnidade(unidade, { run = spawnSync } = {}) {
  if (unidade !== UNIDADE_ATUALIZAR && unidade !== UNIDADE_VOLTAR) throw new Error('unidade desconhecida');
  const r = run('systemctl', ['--no-ask-password', 'start', unidade], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TETO_UNIDADE_MS });
  if (r.error) return { ok: false, erro: r.error.code === 'ENOENT' ? 'systemctl não encontrado' : r.error.message };
  const erro = String(r.stderr || '').trim().split('\n').pop();
  return { ok: r.status === 0, erro: r.status === 0 ? null : erro || `systemctl saiu com código ${r.status}` };
}
