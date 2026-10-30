# ADR 0027 — Esqueleto no formato final, só em espera longa

- **Status:** Aceita
- **Data:** 30/10/2026
- **Complementa:** a [ADR 0022](0022-animacao-de-interface-so-com-css.md) (animação só com CSS) e a
  [ADR 0026](0026-entrada-de-tela-so-quando-ela-muda.md) (entrada de tela)

## Contexto

Só a Visão geral tinha esqueleto no formato final (#89). As outras telas mostravam 4 cartões e 1
painel genéricos, e a tela pulava quando os dados chegavam. Rede e Relatórios mostravam texto. A
troca de período deixava o gráfico velho na tela, sem sinal de espera. Numa rede local, a resposta
costuma ser rápida: um bloco cinza a cada troca piscaria mais do que ajudaria.

## Decisão

1. **Espera visível:** `core/espera.js` é o único lugar com o tempo. `esperaVisivel()` só mostra
   depois de 150 ms e, uma vez visível, segura a troca até completar 300 ms.
2. **Peças com a classe do conteúdo:** `skelCartao`, `skelGrafico`, `skelTabela`, `skelTexto`,
   `skelFaixas`, `skelCabeca` e `skelLinha`, em `views/common.js`. A altura vem das mesmas classes
   e de um texto invisível. Com um exemplo do tamanho do texto final, o bloco quebra de linha onde
   o texto quebraria. A altura do gráfico vai em `data-px`, aplicado pelo CSSOM.
3. **Esqueleto por tela:** `ownSkeleton(state)`, nas 8. Já com uma amostra, ele usa o número real
   de discos e serviços. O esqueleto geral de `main.js` fica só como reserva.
4. **Tela pronta** quer dizer: sem `loading` e sem a navegação esperando baldes. Antes disso,
   `refreshView()` não redesenha. Na troca de tela, a tela velha fica até o atraso, para a
   resposta rápida trocar direto.
5. **Troca de período:** o gráfico mantém os dados velhos. Passado o atraso, a tela ganha
   `.atualizando`: o gráfico esmaece e uma faixa de 2 px corre no topo com `transform`. O botão do
   período responde na hora.
6. **Região que carrega depois** (`carregarRegiao`: 7 dias da Rede, previsão de Armazenamento,
   Relatórios): as peças entram logo, com `visibility: hidden`, e guardam o espaço. A região fica
   visível depois do atraso. Vindo de um esqueleto visível, ela aparece na hora: um vão entre os
   2 esqueletos piscaria. Na troca de período dos Relatórios, os dados velhos ficam até o atraso.
7. **Acessibilidade:** `aria-busy` em `#view` e nas regiões, com o texto "carregando" só para
   leitor de tela. Com movimento reduzido, o bloco e a faixa ficam parados.
8. **Ajuda sem configuração:** o texto "Carregando configuração…" só aparecia depois de uma falha
   da API. Um bloco pulsando prometeria o que não vai chegar. A tela diz que a configuração está
   indisponível.
9. **Descartados:** o brilho que corre pelo bloco, que custa mais pintura, e o atraso só por CSS
   (`animation-delay`). Por CSS, a tela velha sumiria antes da hora e a resposta rápida piscaria.

## Consequências

- Tela nova com dados lentos sobe com o esqueleto dela, mesmo enquanto os baldes não chegam.
- Em Recursos e na Rede, o exemplo de texto segue o formato atual dos cartões. Mudou o texto de um
  cartão? O teste `e2e: esqueleto — nas 8 telas` confere o pulo a 1600 px.
- Em tela mais estreita, uma nota no limite da quebra depende do valor que chegou: o esqueleto pode
  errar por 1 linha, e os blocos abaixo andam essa linha. Por isso o teste mede a 1600 px.
- O número de discos e serviços só é conhecido depois da 1ª amostra. Antes dela, o esqueleto
  supõe 1 disco, e os blocos depois deles podem descer.
- Um novo carregamento de tela deve usar `carregarRegiao`, sem timer próprio.
