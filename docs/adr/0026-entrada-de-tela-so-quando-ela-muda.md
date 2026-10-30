# ADR 0026 — Entrada de tela só quando ela muda

- **Status:** Aceita
- **Data:** 30/10/2026
- **Complementa:** a [ADR 0022](0022-animacao-de-interface-so-com-css.md) (animação só com CSS)

## Contexto

A troca de tela era um corte seco (#86). `renderView()` também roda sem a tela mudar: na troca de
tema ou de período e, nas telas sem `update()`, a cada amostra do SSE. Animar nesses casos faria o
painel piscar a cada minuto.

## Decisão

1. **Entrada por CSS:** `.view-entra`, `.login > *` e `dialog[open]` usam o `@keyframes entra`
   (`opacity` e `translateY(--enter-y)`, 4 px), em `--t-enter` (180 ms) com `--ease-out`. Sem
   `animation-fill-mode`: ao terminar, a tela não guarda `transform`.
2. **Quem decide é a `renderView()`:** ela compara a tela nova com a atual. A origem da chamada só
   entra com `entra: true`, quando o conteúdo substitui o esqueleto, o geral ou o da Visão geral.
3. **Atalhos em sequência:** cada navegação tem um número. Depois de esperar os baldes, a que
   ficou para trás desiste. Só a tecla mais nova desenha e anima. Navegação com a mesma tela e o
   mesmo período não faz nada: montar de novo cortaria a entrada.
4. **Foco e rolagem** não esperam a animação.
5. **Movimento reduzido:** a regra fica em `prefers-reduced-motion: no-preference`. A classe
   continua na tela, sem efeito.
6. **Descartadas:** a View Transitions API, que tira foto dos gráficos `<canvas>` e custa mais na
   troca, e a saída animada da tela velha, que atrasa a tela nova em cerca de 150 ms.

## Consequências

- O custo em bytes continua sendo só o CSS.
- O painel ainda não usa `<dialog>`. O seletor deixa pronta a entrada do 1º diálogo, e o teste
  confere isso com um diálogo criado na hora.
- O teste `e2e: troca de tela` confere o que anima, o que não anima, a sequência de atalhos, a
  largura do gráfico e o movimento reduzido.
