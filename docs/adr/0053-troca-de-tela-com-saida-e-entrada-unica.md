# ADR 0053 — Troca de tela com saída, curva espalhada e entrada única

- **Status:** Aceita
- **Data:** 06/11/2026
- **Substitui:** os valores de movimento da entrada de tela da [ADR 0052](0052-transicoes-mais-visiveis.md) e acrescenta a regra de saída (a troca de período da 0052 continua)

## Contexto

O mantenedor testou a v2.6.3 na instalação real e não sentiu diferença ao trocar de tela pelo menu lateral. A medição da opacidade da `.view` a cada quadro (#187) achou 3 causas:

1. A curva `cubic-bezier(.2,.8,.2,1)` concentra a mudança no início: a opacidade chega a 0,63 em ~55 ms e a 0,94 em ~137 ms. O olho vê quase um corte seco.
2. Não havia saída: a tela velha ficava parada e inteira por ~200 ms, esperando os dados, e sumia de uma vez.
3. A entrada rodava 2 vezes: o esqueleto entrava e, ~550 ms depois, o conteúdo que o substituía entrava de novo, com a opacidade voltando a 0.

## Decisão

| Valor | Antes (0052) | Agora |
|---|---|---|
| `--t-enter` | 280 ms | 300 ms |
| `--enter-y` | 12 px | 16 px |
| `--ease-enter` | `cubic-bezier(.2,.8,.2,1)` | `cubic-bezier(.4,0,.2,1)` |
| Saída da tela velha (`.view-sai`) | não existia | `--t-sai` 140 ms, `--ease-sai` `cubic-bezier(.3,0,.6,1)`, opacidade até 0 e subida de `--enter-y` ÷ 2 |

1. **Saída:** ao trocar de tela com os dados ainda por chegar, a tela velha recebe `.view-sai` na hora. Ela roda durante a espera que já existe (ADR 0027) e não acrescenta tempo. Se os dados chegam antes, a nova entra e corta a saída. Se a tela já tem os dados, não há espera nem saída.
2. **Entrada única:** a entrada (`.view-entra`) vale só para a `.view` de uma tela diferente da anterior, isto é, o esqueleto. O conteúdo que o substitui, e toda atualização ao vivo, não animam de novo.
3. Só `opacity` e `transform`. Clique e teclado nunca ficam bloqueados. `prefers-reduced-motion` continua zerando tudo. A troca de período (fade `troca`, 220 ms) mantém o valor e passa a usar a nova curva.

## Consequências

- O teste `e2e: troca de tela — a velha sai na hora…` amostra a opacidade a cada quadro: saída, opacidade abaixo de 0,5 aos 25% da duração e entrada que não recomeça.
- Sem espera nova e sem bytes relevantes: CSS e uma classe.
