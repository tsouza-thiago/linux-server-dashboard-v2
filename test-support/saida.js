// Saída da CLI em memória para os testes: junta tudo o que o comando escreveu, sem TTY e sem cor.
import { makeOutput } from '../server/cli/saida.js';

/** Devolve `out` (para passar ao comando) e o texto escrito até agora (`text()`, ou `texto()` em pt-BR). */
export function memOut() {
  const partes = [];
  const out = makeOutput({ stream: { isTTY: false, write: (s) => { partes.push(s); return true; } }, env: {} });
  const text = () => partes.join('');
  return { out, text, texto: text };
}
