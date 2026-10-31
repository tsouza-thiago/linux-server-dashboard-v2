// Registro da troca de versão (ADR 0031): log, estado e trava em .atualizacao/, fora de data/,
// porque a volta atrás apaga data/ e perderia o log. Quem escreve é o `dashboard atualizar
// --registro`; o painel só prepara o início e lê. A pasta sobrevive à queda do painel, e é por
// isso que a tela de progresso consegue continuar depois da troca de versão.
import fs from 'node:fs';
import path from 'node:path';

const PASTA = '.atualizacao';
const LOG = 'ultima.log';
const ESTADO = 'estado.json';
const TRAVA = 'trava.pid';
// Maior pedaço do log numa resposta: a tela pede de novo até alcançar o fim.
const MAX_PEDACO = 64 * 1024;
// Tempo para o executor pegar a trava depois do pedido da tela. Passou disso sem trava, ele não subiu.
const GRACA_MS = 60000;

const arquivo = (root, nome) => path.join(root, PASTA, nome);

/** Cria a pasta (0700) ou corrige a permissão dela. */
export function garantirPasta(root) {
  const dir = path.join(root, PASTA);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** O estado gravado; {} sem arquivo ou com arquivo inválido. */
export function lerEstado(root) {
  try {
    const salvo = JSON.parse(fs.readFileSync(arquivo(root, ESTADO), 'utf8'));
    return salvo && typeof salvo === 'object' && !Array.isArray(salvo) ? salvo : {};
  } catch {
    return {};
  }
}

// Troca atômica: quem lê no meio da escrita nunca vê meio JSON.
function gravarEstado(root, estado) {
  const tmp = `${arquivo(root, ESTADO)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(estado), { mode: 0o600 });
  fs.renameSync(tmp, arquivo(root, ESTADO));
}

/** Junta `mudanca` ao estado gravado. */
export function marcarEstado(root, mudanca) {
  gravarEstado(root, { ...lerEstado(root), ...mudanca });
}

/**
 * Começo pedido pela tela: zera o log e grava a fase `iniciando`. É síncrono de propósito:
 * 2 pedidos seguidos não passam juntos pela conferência de `emAndamento`.
 */
export function prepararRegistro(root, { alvo, de, agora = Date.now() }) {
  garantirPasta(root);
  fs.writeFileSync(arquivo(root, LOG), '', { mode: 0o600 });
  gravarEstado(root, { fase: 'iniciando', alvo, de, inicio: new Date(agora).toISOString(), fim: null, resultado: null });
}

/** Acrescenta uma linha ao log e encerra o estado como falha (o executor nem subiu). */
export function registrarFalha(root, linha, agora = Date.now()) {
  fs.appendFileSync(arquivo(root, LOG), `${linha}\n`, { mode: 0o600 });
  marcarEstado(root, { fase: 'fim', fim: new Date(agora).toISOString(), resultado: 'falhou' });
}

// O PID é mesmo um `dashboard atualizar`? Um PID reaproveitado pelo sistema não segura a trava.
function ehAtualizar(pid, procDir) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const args = fs.readFileSync(path.join(procDir, String(pid), 'cmdline'), 'utf8').split('\0');
    return args.includes('atualizar') && args.some((a) => a.endsWith('/server/cli/index.js'));
  } catch {
    return false;
  }
}

/** PID da atualização que segura a trava, ou null se ninguém segura. */
export function donoDaTrava(root, procDir = '/proc') {
  let pid;
  try { pid = Number(fs.readFileSync(arquivo(root, TRAVA), 'utf8').trim()); } catch { return null; }
  return ehAtualizar(pid, procDir) ? pid : null;
}

/** Tenta pegar a trava; false se outra atualização segura. Trava de processo morto é retirada. */
export function pegarTrava(root, { pid = process.pid, procDir = '/proc' } = {}) {
  garantirPasta(root);
  const file = arquivo(root, TRAVA);
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    try {
      fs.writeFileSync(file, `${pid}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (donoDaTrava(root, procDir)) return false;
    fs.rmSync(file, { force: true });
  }
  return false;
}

/** Solta a trava. */
export function soltarTrava(root) {
  fs.rmSync(arquivo(root, TRAVA), { force: true });
}

/** Há uma troca de versão em andamento, ou pedida agora há pouco? */
export function emAndamento(root, { agora = Date.now(), procDir = '/proc' } = {}) {
  if (donoDaTrava(root, procDir)) return true;
  const e = lerEstado(root);
  return e.fase === 'iniciando' && agora - Date.parse(e.inicio) < GRACA_MS;
}

// Bytes do log a partir de `inicio`, só com linhas inteiras: o corte nunca parte um caractere.
function pedacoDoLog(root, inicio) {
  let fd;
  try { fd = fs.openSync(arquivo(root, LOG), 'r'); } catch { return { texto: '', proximo: 0 }; }
  try {
    const { size } = fs.fstatSync(fd);
    // Depois de maior que o arquivo: o log foi zerado por outra atualização.
    const de = inicio > size ? 0 : inicio;
    const buf = Buffer.alloc(Math.min(size - de, MAX_PEDACO));
    const lidos = fs.readSync(fd, buf, 0, buf.length, de);
    const fimDeLinha = buf.subarray(0, lidos).lastIndexOf(10);
    const corte = fimDeLinha >= 0 ? fimDeLinha + 1 : (lidos === MAX_PEDACO ? lidos : 0);
    return { texto: buf.subarray(0, corte).toString('utf8'), proximo: de + corte };
  } finally {
    fs.closeSync(fd);
  }
}

/** O que a tela de progresso lê: o pedaço novo do log e o estado. */
export function lerRegistro(root, desde = 0, opcoes = {}) {
  const e = lerEstado(root);
  const rodando = emAndamento(root, opcoes);
  // Sem trava e sem `fim`: o executor morreu no meio (ex.: desligaram o computador).
  const interrompida = Boolean(e.fase) && e.fase !== 'fim' && !rodando;
  return {
    ...pedacoDoLog(root, desde),
    fase: interrompida ? 'fim' : e.fase ?? null,
    alvo: e.alvo ?? null,
    de: e.de ?? null,
    inicio: e.inicio ?? null,
    fim: e.fim ?? null,
    resultado: interrompida ? 'interrompida' : e.resultado ?? null,
    rodando,
  };
}

/**
 * Abre o log para o `dashboard atualizar --registro`. `stream` é síncrono: uma falha logo depois
 * de uma linha não leva a linha junto. `fd` também vai para a fase 2, rodada pela versão nova.
 */
export function abrirRegistro(root, { agora = Date.now } = {}) {
  garantirPasta(root);
  const fd = fs.openSync(arquivo(root, LOG), 'a', 0o600);
  return {
    fd,
    stream: { isTTY: false, write: (texto) => fs.writeSync(fd, texto) },
    marcar: (mudanca) => marcarEstado(root, mudanca),
    /** Fecha o registro. `resultado` já marcado (voltou, já na mais nova) continua valendo. */
    fim(codigo) {
      const resultado = lerEstado(root).resultado ?? (codigo === 0 ? 'atualizado' : 'falhou');
      marcarEstado(root, { fase: 'fim', fim: new Date(agora()).toISOString(), resultado });
      fs.closeSync(fd);
    },
  };
}
