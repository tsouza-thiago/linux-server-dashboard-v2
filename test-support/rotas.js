// Rotas HTTP lidas do código-fonte (server/index.js e server/setup/web.js).
//
// A matriz de ataque (test/seguranca/superficie-ataque.test.js), o teste da documentação e
// a varredura do OWASP ZAP (scripts/seguranca.mjs) usam esta lista. Uma rota nova entra
// sozinha em todas as verificações, sem ninguém precisar lembrar de cadastrá-la.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `app.get('/x', …)`, `app.post(…)`, `app.delete(…)` e `app.put(…)` de um arquivo. */
function rotasDe(arquivo, root = ROOT) {
  const fonte = fs.readFileSync(path.join(root, arquivo), 'utf8');
  return [...fonte.matchAll(/app\.(get|post|delete|put)\('(\/[^']*)'/g)]
    .map(([, metodo, caminho]) => ({ metodo: metodo.toUpperCase(), caminho }));
}

/** Rotas do painel (server/index.js). */
export const rotasDoPainel = (root) => rotasDe('server/index.js', root);

/** Rotas do assistente de instalação (server/setup/web.js). */
export const rotasDoAssistente = (root) => rotasDe('server/setup/web.js', root);

/** Troca os parâmetros `:id` por um valor de exemplo, para montar uma URL de verdade. */
export const caminhoConcreto = (caminho, valor = 'id-inexistente') => caminho.replace(/:[A-Za-z]+/g, valor);
