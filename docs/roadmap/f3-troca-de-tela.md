# F3 — Transição suave na troca de telas

- **Nível:** P · **Versão:** 2.3.0 · **Área:** telas

## Objetivo

Trocar de tela (menu lateral, atalhos 1–8, link com `#/tela`) com uma entrada leve, sem
corte seco.

## Situação hoje

- `renderView()` em `public/js/main.js` cria um `div.view` novo e troca o conteúdo de
  `#view` de uma vez (`replaceChildren`).
- `refreshView()` chama `renderView()` de novo quando a tela não tem `update()` ou está
  no esqueleto. Isso acontece também a cada amostra nova do SSE (1 por minuto).
- O menu lateral em tela estreita já desliza (`transform` em `components.css`).
- O toast já entra com animação (`toast-in`).

## Decisão proposta

A decisão final está na [ADR 0026](../adr/0026-entrada-de-tela-so-quando-ela-muda.md): a própria
`renderView()` compara a tela, sem receber a origem da chamada, e a tecla mais nova cancela as
navegações anteriores.

1. **Entrada por CSS:** `.view` entra com `opacity` de 0 a 1 e `translateY(4px)` para 0,
   em ~180 ms com `--ease-out`. Nenhum JavaScript novo para animar.
2. **Animar só quando a tela muda de verdade:** `renderView()` recebe a origem da
   chamada. A classe de entrada (`.view-entra`) vai só quando a tela é outra ou quando o
   esqueleto dá lugar ao conteúdo. A atualização do SSE e a troca de período **não**
   animam (piscaria a cada minuto).
3. **Foco e rolagem:** mantém o comportamento de hoje (foco em `#view`), sem esperar a
   animação.
4. Com movimento reduzido: sem deslocamento e sem esmaecer.
5. **Diálogos** (`<dialog>`) e o login ganham a mesma entrada, por CSS.

### Alternativas

- **View Transitions API** (`document.startViewTransition`): faz a transição cruzada entre
  a tela velha e a nova. Hoje existe no Chrome/Edge, no Safari e no Firefox recente. Fica
  como melhoria futura: tira foto dos gráficos `<canvas>` do uPlot e custa mais na troca.
  Se for adotada, entra com teste de recurso (`if (document.startViewTransition)`).
- **Saída animada da tela velha:** atrasa a tela nova em ~150 ms a cada troca. Descartada:
  o painel precisa responder rápido.

## Etapas

1. Separar, em `main.js`, a troca de tela da re-renderização (parâmetro ou função nova).
2. Classe `.view-entra` e `@keyframes` em `components.css`.
3. Entrada do `<dialog>` e do login.
4. Conferir os atalhos 1–8 apertados em sequência rápida (a animação não acumula).
5. Itens novos em [testes-no-navegador.md](../testes-no-navegador.md) e bateria no
   navegador real.

## Testes

- e2e: trocar de tela adiciona `.view-entra`; uma amostra nova do SSE não adiciona.
- e2e: com movimento reduzido emulado, a duração calculada é ~0.

## Riscos

- Gráfico do uPlot medido com a largura errada durante o `transform`. Mitigação: animar
  só `opacity` e `translateY` (não muda a largura) e conferir no navegador real.
