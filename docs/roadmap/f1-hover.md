# F1 — Animação ao passar o mouse (hover)

- **Nível:** P · **Versão:** 2.3.0-rc.1 · **Área:** telas
- **Decidido:** "animação do tipo hook ao sobrepor o mouse" é *hover* (confirmado em
  26/10/2026).

## Objetivo

Dar uma resposta visual leve e suave quando o mouse fica sobre um elemento clicável.

## Situação hoje

- `public/css/components.css` já troca a cor no `:hover` de `.btn` (e variantes),
  `.nav-item`, `.segmented button`, `.icon-btn`, `.btn-link` e `.th-sort`;
  `views.css` faz o mesmo em `.export-btn`.
- A transição usa só `background` e `color`, com `--t-fast` (150 ms) de `tokens.css`.
- `base.css` já zera as durações com `prefers-reduced-motion: reduce`.

## Decisão proposta

1. Animar só propriedades baratas: `transform`, `opacity`, `background-color`,
   `border-color`, `color` e `box-shadow`. Nunca `width`, `height`, `margin` ou `padding`
   (elas recalculam o layout da página).
2. Efeito por tipo de elemento:
   - `.btn-primary` e `.btn-soft`: sobe 1 px (`translateY(-1px)`) e ganha uma sombra
     suave com a cor de destaque.
   - `.btn`, `.btn-surface`, `.icon-btn`: só a troca de cor de hoje, com curva de
     suavização nova.
   - `.nav-item`: a barra de destaque à esquerda aparece com `scaleY` de 0 para 1.
   - Cartões clicáveis (se houver): borda com a cor de destaque.
3. Tokens novos em `tokens.css`: `--ease-out` (curva) e `--lift` (deslocamento). As
   durações continuam `--t-fast` e `--t-base`.
4. Efeitos de deslocamento só dentro de `@media (hover: hover) and (pointer: fine)`, para
   não "grudar" em tela de toque.
5. Com `prefers-reduced-motion: reduce`, o deslocamento some; a troca de cor fica.

### Alternativas descartadas

- **Biblioteca de animação** (ex.: Animate.css): peso extra no orçamento de 300 KB e
  efeitos maiores do que "leve e suave".
- **Animação por JavaScript**: desnecessária; CSS resolve e não tem custo na CSP.

## Etapas

1. Listar todos os seletores clicáveis das 8 telas, do login e do assistente.
2. Criar os tokens `--ease-out` e `--lift` nos 2 temas (escuro e claro).
3. Aplicar o efeito por tipo (item 2 da decisão), num bloco só de `components.css`.
4. Conferir o contraste do texto no estado hover nos 2 temas.
5. Medir o tamanho da página (`test/e2e/telas.test.js`).
6. Acrescentar o item "hover" em [testes-no-navegador.md](../testes-no-navegador.md) e
   rodar a bateria no navegador real.

## Testes

- e2e: o estilo calculado de `.btn-primary:hover` tem `transform` diferente de `none` e,
  com movimento reduzido emulado, volta a `none`.
- Navegador real: os 2 temas, teclado (o foco não pode depender do hover).

## Riscos

- Sombra com cor errada no tema claro. Mitigação: token por tema.
- Elemento que sobe 1 px e "treme" na borda de um grupo (`.segmented`). Mitigação: sem
  deslocamento dentro de grupos.
