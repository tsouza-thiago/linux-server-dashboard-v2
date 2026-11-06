# ADR 0052 — Transições mais visíveis

- **Status:** Aceita
- **Data:** 06/11/2026
- **Substitui:** os valores de movimento das ADRs [0022](0022-animacao-de-interface-so-com-css.md) e [0026](0026-entrada-de-tela-so-quando-ela-muda.md) (a regra de cada uma continua)

## Contexto

O mantenedor pediu (06/11/2026) transições mais visíveis, ainda suaves. A entrada de tela (180 ms, 4 px) quase não aparecia. Na troca de período, os dados velhos esmaeciam só até 50% e o conteúdo novo surgia de corte seco.

## Decisão

| Valor | Antes | Agora |
|---|---|---|
| `--t-enter` (entrada de tela, login, diálogo) | 180 ms | 280 ms |
| `--enter-y` | 4 px | 12 px |
| Curva da entrada | `--ease-out` | `--ease-enter`: `cubic-bezier(.2,.8,.2,1)` |
| Dados velhos ao trocar o período | opacidade 0,5 em 150 ms | 0,35 em `--t-troca` |
| `--t-troca` (fade do conteúdo novo) | não existia | 220 ms |

1. **Troca de período** na mesma tela: a `renderView()` marca a tela com `.view-troca`, um fade de `opacity` sem deslocamento. A entrada (`.view-entra`) continua só para tela que muda (ADR 0026). Tema e amostra nova não animam.
2. Só `opacity` e `transform`. A animação não bloqueia clique nem foco.
3. `prefers-reduced-motion` continua zerando tudo.

## Consequências

- O custo em bytes é desprezível (CSS e uma classe).
- O teste `e2e: troca de tela` confere 0,28 s e a classe `.view-troca`.
