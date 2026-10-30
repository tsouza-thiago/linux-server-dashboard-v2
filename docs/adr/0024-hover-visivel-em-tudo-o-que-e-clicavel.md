# ADR 0024 — Hover visível em tudo o que é clicável

- **Status:** Aceita
- **Data:** 30/10/2026
- **Substitui:** os itens 3 e 4 da [ADR 0022](0022-animacao-de-interface-so-com-css.md) (tokens e
  resposta ao mouse)

## Contexto

A F1 (#84) levou o hover discreto para a 2.2.3: só 3 tipos de botão subiam 1 px, e os outros
clicáveis trocavam pouco de cor. O mantenedor achou fraco. Vários clicáveis do assistente nem
tinham hover (#100). As outras regras da ADR 0022 continuam: só CSS, só propriedades baratas,
efeito só com mouse e nenhum deslocamento com "reduzir movimento".

## Decisão

1. **Tokens** em `tokens.css`: `--ease-out`, `--lift` (agora 2 px), `--shadow-lift` (mais forte,
   uma por tema), `--t-fast` e `--t-base`, e 3 novos: `--hover-bg` e `--hover-bg-strong` (fundo
   com a cor de destaque) e `--accent-strong-hover` (fundo do botão principal, um por tema).
2. **Todo botão solto sobe:** todas as variantes de `.btn`, `.icon-btn`, `.export-btn`,
   `.wz-next`, `.wz-back`, `.wz-mini`, `.wz-more` e `.wz-eye` sobem `--lift` com sombra, e o
   fundo e a borda ganham a cor de destaque (`.btn-danger`, a cor de crítico).
3. **Botão em grupo não sobe:** `.segmented button` e `.wz-seg button` ganham só o fundo, para
   não tremer na borda do grupo. O mesmo vale para o `.btn-link`, que fica dentro do aviso.
4. **Lista longa não se desloca:** os botões de `.event-list` trocam de fundo e borda, sem subir.
5. **Outros clicáveis:** `.wz-radio`, `.wz-svc`, `.wz-from` e `.wz-switch` ganham fundo de
   destaque; `.wz-row` ganha a borda; `.nav-item` ganha o fundo, a barra e o ícone na cor de
   destaque; links, `.th-sort` e `summary` ganham sublinhado com a cor de destaque, e o rótulo
   de uma caixa de seleção fica na cor de destaque.
6. **Desligado não responde:** toda regra de hover exclui `:disabled`, e o cartão com a caixa
   desligada também não responde.
7. A lista de propriedades baratas da ADR 0022 ganha `text-decoration-color`, que só repinta o
   sublinhado.
8. Os `:hover` ficam só no bloco "Resposta ao mouse" de `components.css` e `configurar.css`,
   dentro do `@media (hover: hover) and (pointer: fine)`.

## Consequências

- O custo em bytes continua sendo só o CSS. O teste de tamanho da página inicial confere os 300 KB.
- A F2 parte destes tokens e precisa manter o `:active` compatível com o `--lift` de 2 px.
- O teste `e2e: hover` passa por todo `button`, `a` e `summary` visível das 8 telas e confere que
  o estilo muda. Clicável novo sem hover reprova nesse teste.
