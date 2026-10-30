# F6 — Skeleton em tudo o que carrega

- **Nível:** M · **Versão:** 2.3.0 · **Área:** telas · **Depende de:** F3 (entrada
  do conteúdo)

## Objetivo

Enquanto um dado carrega, mostrar blocos cinzas no formato final (skeleton), para a tela
não "pular" quando o dado chega. Trocar os textos "Carregando…" por esses blocos.

## Situação hoje

- `.skel` e a animação `shimmer` (pulso de opacidade) existem em `components.css`.
- `renderView()` (`public/js/main.js`) mostra um esqueleto genérico (4 cartões + 1
  painel) em toda tela antes da 1ª resposta da API.
- A Visão geral tem o esqueleto próprio, no formato final (`ownSkeleton`).
- Ainda em texto: Rede ("Carregando os últimos 7 dias…"), Relatórios ("Carregando
  resumo…") e Ajuda ("Carregando configuração…").
- Troca de período: `loadBuckets()` pede os baldes depois de 300 ms; os gráficos ficam
  com os dados velhos até a resposta, sem sinal de que estão atualizando.

## Decisão proposta

1. **Peças reutilizáveis** em `public/js/views/common.js`, pelo template `html`:
   `skelCartao()`, `skelGrafico()`, `skelTabela(linhas)` e `skelTexto(linhas)`.
2. **Cada tela com o esqueleto no formato dela** (`ownSkeleton` nas 8). O esqueleto
   genérico de `main.js` fica só como reserva.
3. **Trocar os 3 textos** "Carregando…" pelas peças do item 1.
4. **Troca de período:** o gráfico mantém os dados velhos, fica esmaecido e ganha uma
   faixa fina animada no topo até os baldes novos chegarem. Motivo: trocar por um bloco
   cinza a cada troca de período "pisca" mais do que ajuda.
5. **Sem piscar em resposta rápida:** o esqueleto só aparece se o carregamento passar de
   ~150 ms. Uma vez visível, fica pelo menos ~300 ms.
6. **Acessibilidade:** `aria-busy="true"` na região que carrega e um texto só para leitor
   de tela ("carregando").
7. **Animação:** fica o pulso de opacidade de hoje (barato). O brilho que corre da
   esquerda para a direita custa mais pintura e foi descartado. Com movimento reduzido, o
   bloco fica parado.

## Etapas

1. Inventário: cada tela, cada carregamento assíncrono e o estado que ela mostra hoje
   (tabela no PR).
2. Peças do item 1, com teste unitário do HTML gerado.
3. Esqueleto próprio de Recursos, Armazenamento, Rede e Processos.
4. Esqueleto próprio de Eventos, Relatórios e Ajuda; troca dos 3 textos.
5. Estado "atualizando" dos gráficos na troca de período (item 4).
6. Atraso mínimo e tempo mínimo (item 5) num utilitário único.
7. Medir o tamanho da página e rodar a bateria no navegador real.

## Testes

- e2e com a API atrasada de propósito (`page.route` do Playwright): o esqueleto aparece, o
  conteúdo entra e a posição dos blocos principais não muda mais de 2 px (sem "pulo").
- e2e com resposta rápida: o esqueleto não aparece.
- Unitário das peças.

## Riscos

- Esqueleto com altura diferente do conteúdo final: a tela pula do mesmo jeito.
  Mitigação: o teste de posição do e2e.
- Orçamento de 450 KB: as peças são pequenas, mas F1, F2, F3 e F6 somam. Medir a cada PR.
