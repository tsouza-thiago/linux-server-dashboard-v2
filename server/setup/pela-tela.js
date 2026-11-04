// Código de entrada do "Reconfigurar pela tela" (ADR 0034). O painel cria o código e o entrega só
// ao navegador que pediu; o `dashboard reconfigurar --pela-tela` lê o hash daqui, porque nada que
// vem da tela entra no comando (I11). Em disco fica só o SHA-256: quem lê o arquivo não entra.
// Módulo pequeno de propósito: o painel vai usá-lo sem carregar o resto da instalação.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../storage/ndjson.js';

const ARQUIVO = 'reconfigurar.json';
// O tempo de parar o painel e subir o assistente: o navegador entra logo depois.
const CODIGO_MS = 5 * 60 * 1000;

/** Cria o código (devolve o texto puro; só o hash e o prazo ficam em data/reconfigurar.json). */
export function criarCodigoPelaTela(dataDir, { ttlMs = CODIGO_MS, now = Date.now() } = {}) {
  // Só A-F e 0-9: o assistente compara em maiúsculas, sem o que não for letra ou número.
  const codigo = crypto.randomBytes(16).toString('hex').toUpperCase();
  const hash = crypto.createHash('sha256').update(codigo).digest('hex');
  writeFileAtomicSync(path.join(dataDir, ARQUIVO), JSON.stringify({ hash, exp: now + ttlMs }));
  return codigo;
}

/**
 * Tira o código do disco e devolve `{ hash, exp }`, ou null se faltar, vencer ou vier malformado.
 * O arquivo sai sempre que é lido: um 2º `--pela-tela` não encontra nada para aproveitar.
 */
export function retirarCodigoPelaTela(dataDir, { now = Date.now() } = {}) {
  const file = path.join(dataDir, ARQUIVO);
  let texto;
  try { texto = fs.readFileSync(file, 'utf8'); } catch { return null; }
  fs.rmSync(file, { force: true });
  try {
    const { hash, exp } = JSON.parse(texto);
    return /^[0-9a-f]{64}$/.test(hash) && exp > now ? { hash, exp } : null;
  } catch {
    return null;
  }
}

// Saída do `--pela-tela`, que não tem terminal (ADR 0034). Guarda só a última vez.
export const LOG_PELA_TELA = 'reconfigurar.log';
// O que a tela lê do log: o começo dele, e poucas linhas curtas.
const MAX_LIDO = 64 * 1024;
const MAX_MOTIVOS = 5;
const MAX_LINHA = 300;

/**
 * A última reconfiguração pela tela, para a tela mostrar o motivo de uma recusa ou de uma volta (ADR
 * 0035): `{ em, motivos }`, com o instante da última escrita e só as linhas de falha (✗). O resto do
 * log descreve a pasta e a máquina e não ajuda quem está na tela. O log nunca traz o código nem a
 * senha (ADR 0034); mesmo assim, só as falhas saem daqui. Null sem log.
 */
export function lerResultadoPelaTela(dataDir) {
  const file = path.join(dataDir, LOG_PELA_TELA);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { mtimeMs } = fs.fstatSync(fd);
    const buf = Buffer.alloc(MAX_LIDO);
    const lidos = fs.readSync(fd, buf, 0, MAX_LIDO, 0);
    const motivos = buf.subarray(0, lidos).toString('utf8').split('\n')
      .filter((l) => l.startsWith('✗ '))
      .map((l) => l.slice(2).trim().slice(0, MAX_LINHA))
      .slice(0, MAX_MOTIVOS);
    return { em: new Date(mtimeMs).toISOString(), motivos };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
