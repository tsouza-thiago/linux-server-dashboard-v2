# ADR 0019 — Testes no navegador no fluxo de trabalho

- **Status:** Aceita
- **Data:** 20/10/2026
- **Complementa:** a [ADR 0014](0014-verificacao-de-seguranca-continua.md) (verificação
  contínua) e a [ADR 0016](0016-fluxo-no-github-issue-primeiro.md) (fluxo no GitHub)

## Contexto

A suíte confere o código, e o e2e (`test/e2e/`) confere que as telas carregam no Chromium.
Nenhum dos dois confere o que a pessoa vê com dados reais: se o mesmo número aparece igual em
duas telas, se um dia sem coleta aparece como "sem dados", se a versão nova chega à tela
depois de atualizar. Em 20/10/2026, conferir as telas no navegador real, pela extensão Claude
in Chrome, achou 2 bugs que a suíte não pegava: a tabela por dia dos Relatórios omitia dias
(#43), e o navegador mantinha o JS antigo depois de atualizar (#44).

## Decisão

1. **Toda mudança de tela** é conferida no navegador real, pela extensão Claude in Chrome, no
   navegador do mantenedor. O agente conduz o teste sozinho, sem pedir permissão a cada vez.
2. O teste usa um **painel de teste** (`npm run painel-teste`, `scripts/painel-teste.mjs`):
   o painel de verdade em `127.0.0.1`, numa porta separada, sem token, com dados semeados
   numa pasta temporária e sem SSH. Os cenários são `normal`, `lacunas`, `offline` e
   `vazio`. Ele nunca lê nem grava o `data/` de uma instalação.
3. A **bateria completa** segue o roteiro de [docs/testes-no-navegador.md](../testes-no-navegador.md)
   e roda antes de cada versão publicada e quando o mantenedor pedir. O PR registra os
   cenários rodados e o resultado; cada falha nova vira uma issue de bug.
4. O painel real só entra para conferir uma versão instalada, e só para leitura: nunca
   digitar nem ler o token, reconhecer alertas ou criar anotações sem pedido.

## Consequências

- Bugs de apresentação e de coerência entre telas aparecem antes da versão sair.
- A bateria depende da extensão conectada. Sem ela, o PR diz que a bateria não rodou, e a
  versão espera o mantenedor decidir.
- O roteiro é documentação viva: tela ou estado novo entra nele no mesmo PR.
