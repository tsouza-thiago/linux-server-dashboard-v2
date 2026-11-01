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
