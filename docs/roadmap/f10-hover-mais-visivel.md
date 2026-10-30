# F10 — Hover mais visível em tudo o que é clicável

- **Nível:** M · **Versão:** 2.2.4 · **Área:** telas · **Issue:** #100
- **Pedido do mantenedor (30/10/2026):** as animações da F1 ficaram fracas. A animação precisa
  ficar mais visível, e tudo o que for clicável precisa de hover, principalmente todo e
  qualquer botão da interface.
- **Depende de:** F1 (tokens e bloco "Resposta ao mouse"). Vem antes da F2.

## Objetivo

Quem passa o mouse sobre qualquer elemento clicável vê uma resposta clara, sem precisar
procurar por ela.

## Situação hoje

Levantamento do código na 2.2.3 (`public/js/`, `public/*.html` e `public/css/`):

| Situação | Elementos |
|---|---|
| Sobem 1 px com sombra | `.btn-primary`, `.btn-soft`, `.wz-next` |
| Só trocam de cor | `.btn` (com `-quiet`, `-surface` e `-danger`), `.btn-link`, `.icon-btn`, `.segmented button`, `.th-sort`, `.export-btn`, `.wz-back`, `.wz-linkbtn` e `a` |
| Barra de destaque | `.nav-item` |
| **Sem nenhum hover** | `.wz-mini`, `.wz-more`, `.wz-eye`, `.wz-seg button`, `.wz-radio`, `.wz-svc`, `.wz-switch`, `.wz-from`, `summary` e `.link` (só o `a:hover` geral) |

## Decisão proposta

A [ADR 0022](../adr/0022-animacao-de-interface-so-com-css.md) proíbe deslocamento em grupos e
limita o deslocamento a 3 tipos de botão. Por isso, a F10 precisa de uma ADR que substitua os
itens 3 e 4 dela. As outras regras continuam: só CSS, só propriedades baratas, efeito só com
`(hover: hover)` e nada se desloca com "reduzir movimento".

1. **Mais visível:** `--lift` de 1 px para 2 px, sombra mais forte nos 2 temas e troca de fundo
   ou borda com contraste maior. Os valores finais saem do teste no navegador.
2. **Todo botão responde:** todas as variantes de `.btn`, `.icon-btn`, `.wz-next`, `.wz-back`,
   `.wz-mini`, `.wz-more`, `.wz-eye` e `.export-btn` sobem com sombra.
3. **Botão em grupo:** `.segmented button` e `.wz-seg button` ganham fundo visível, sem subir,
   para não tremer na borda do grupo.
4. **Outros clicáveis:** `.wz-radio`, `.wz-svc`, `.wz-switch`, `.wz-from` e `summary` ganham
   fundo ou borda com a cor de destaque; links e `.th-sort` ganham sublinhado animado ou cor
   mais forte.
5. **Desligado:** elemento `:disabled` não responde ao mouse.

## Etapas

1. Conferir a lista acima na tela e achar o que o código não mostra (ex.: cartão clicável).
2. Escrever a ADR que substitui os itens 3 e 4 da ADR 0022.
3. Ajustar os tokens nos 2 temas e aplicar o efeito por tipo, no bloco "Resposta ao mouse".
4. Mover o `::after` que cobre o espaço deixado para valer no novo `--lift`.
5. Conferir o contraste do texto no hover nos 2 temas e medir o tamanho da página.
6. Atualizar o item "Hover" de [testes-no-navegador.md](../testes-no-navegador.md).
7. Mostrar o resultado ao mantenedor antes da versão: ele aprova a intensidade.

## Testes

- e2e: um teste por tipo de elemento; cada clicável da lista muda de estilo no hover e, com
  movimento reduzido, não se desloca.
- e2e: nenhum `button`, `a` ou `summary` visível fica sem mudança de estilo no hover.
- Navegador real: os 2 temas, nas 8 telas, no login e no assistente. Leia o estilo depois de
  uma captura: a janela da extensão só desenha quadros quando há captura.

## Riscos

- Efeito forte demais em tabela ou lista longa. Mitigação: nada se desloca nessas áreas.
- Orçamento de 300 KB (292 KB hoje). Mitigação: só CSS; medir no e2e.
- Conflito com o `:active` da F2. Mitigação: a F2 vem depois e parte dos novos tokens.
