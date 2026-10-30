# ADR 0022 — Animação de interface só com CSS e propriedades baratas

- **Status:** Aceita
- **Data:** 30/10/2026
- **Complementa:** a [ADR 0010](0010-frontend-em-es-modules-nativos-sem-bundler.md) (frontend sem
  bundler e sem `style="…"` no HTML)

## Contexto

O painel só trocava a cor dos botões ao passar o mouse, sem resposta visual suave (#84). As
próximas features de interface (clique, troca de tela e skeleton) também animam elementos. A
página inicial tem 300 KB de orçamento e a CSP não aceita `'unsafe-inline'`. Falta uma regra
comum para que cada animação não recalcule o layout nem ignore "reduzir movimento".

## Decisão

1. Toda animação de interface é **CSS em arquivo**. Sem biblioteca e sem JavaScript de animação.
2. Anima só **propriedades baratas**: `transform`, `opacity`, `background-color`,
   `border-color`, `color` e `box-shadow`. Nunca `width`, `height`, `margin` ou `padding`.
3. **Tokens** em `tokens.css`: `--ease-out` (curva), `--lift` (deslocamento) e `--shadow-lift`
   (sombra, uma por tema), além de `--t-fast` e `--t-base`.
4. **Resposta ao mouse:** `.btn-primary`, `.btn-soft` e `.wz-next` sobem `--lift` com sombra;
   `.nav-item` mostra a barra de destaque com `scaleY`; os outros clicáveis só trocam de cor.
   Nada se desloca dentro de grupos (`.segmented`). Elemento desligado não se desloca.
5. Efeito de hover só em `@media (hover: hover) and (pointer: fine)`: em tela de toque, o
   `:hover` fica preso depois do toque.
6. **Deslocamento** só com `prefers-reduced-motion: no-preference`. Zerar a duração no
   `base.css` não basta: sem a condição, o elemento ainda muda de posição.
7. Elemento que sobe ganha uma faixa `::after` que cobre o espaço deixado. Sem ela, o mouse na
   borda de baixo perde o `:hover` e o botão treme.

## Consequências

- O custo em bytes é só o CSS: cerca de 1 KB antes do gzip.
- As features F2, F3 e F6 usam os mesmos tokens e seguem estas regras.
- A F2 precisa manter o `:active` compatível com o `transform` do hover.
- O teste `e2e: hover` confere o deslocamento e a condição de movimento reduzido.
