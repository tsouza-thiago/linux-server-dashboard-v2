// Novidades de uma versão nova: recorta do CHANGELOG da tag as seções entre a versão instalada
// e a nova (ADR 0030). O texto vem de uma tag assinada e vai para a tela como texto: o template
// `html` escapa tudo, e nada é buscado na internet além das tags.
import { compareVersions } from '../setup/assinatura.js';

// Teto do texto mandado à tela: pular várias versões não pode virar uma resposta enorme.
const MAX_TEXTO = 32 * 1024;
const SECAO = /^## \[(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)\](?:\s+[—-]\s+(\d{4}-\d{2}-\d{2}))?/;

/**
 * Seções do CHANGELOG `md` depois de `de` e até `ate` (inclusive), da mais nova para a mais
 * antiga. Devolve `{ secoes: [{ versao, data, texto }], cortado }`; `cortado` diz que o teto
 * deixou texto de fora.
 */
export function recortarNovidades(md, { de, ate }) {
  const secoes = [];
  let atual = null;
  for (const linha of String(md).split('\n')) {
    const m = SECAO.exec(linha);
    if (m || linha.startsWith('## ')) {
      const dentro = m && compareVersions(m[1], de) > 0 && compareVersions(m[1], ate) <= 0;
      atual = dentro ? { versao: m[1], data: m[2] ?? null, linhas: [] } : null;
      if (atual) secoes.push(atual);
    } else if (atual) {
      atual.linhas.push(linha);
    }
  }
  let resta = MAX_TEXTO;
  let cortado = false;
  const saida = [];
  for (const s of secoes) {
    const texto = s.linhas.join('\n').trim();
    if (resta <= 0) { cortado = true; break; }
    cortado = texto.length > resta;
    saida.push({ versao: s.versao, data: s.data, texto: texto.slice(0, resta) });
    resta -= texto.length;
  }
  return { secoes: saida, cortado };
}
