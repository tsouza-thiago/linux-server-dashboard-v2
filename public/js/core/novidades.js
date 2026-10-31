// Novidades de uma versão: transforma o trecho do CHANGELOG em blocos simples para a tela. Só
// títulos, itens e parágrafos; o resto do Markdown vira texto, e o template `html` escapa tudo.

// Trechos de uma linha: `código` à parte; negrito e link viram texto puro.
function partes(linha) {
  const limpa = linha.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return limpa.split('`').map((texto, i) => ({ texto, codigo: i % 2 === 1 })).filter((p) => p.texto);
}

/** Blocos `{ tipo: 'titulo'|'item'|'texto', partes }` do texto, na ordem. */
export function blocosDeNovidade(texto) {
  const blocos = [];
  let aberto = null; // linha de continuação (recuada ou colada) entra no bloco anterior
  for (const bruta of String(texto).split('\n')) {
    const linha = bruta.trim();
    if (!linha) { aberto = null; continue; }
    const titulo = /^#{2,6}\s+(.*)$/.exec(linha);
    const item = /^[-*]\s+(.*)$/.exec(linha);
    if (titulo) { blocos.push({ tipo: 'titulo', linhas: [titulo[1]] }); aberto = null; continue; }
    if (item) { aberto = { tipo: 'item', linhas: [item[1]] }; blocos.push(aberto); continue; }
    if (aberto) { aberto.linhas.push(linha); continue; }
    aberto = { tipo: 'texto', linhas: [linha] };
    blocos.push(aberto);
  }
  return blocos.map((b) => ({ tipo: b.tipo, partes: partes(b.linhas.join(' ')) }));
}
