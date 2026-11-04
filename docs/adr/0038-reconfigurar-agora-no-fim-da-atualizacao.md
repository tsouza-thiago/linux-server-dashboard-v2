# ADR 0038 — Reconfigurar pela tela: o botão no fim da atualização e na Visão geral

- **Status:** Aceita
- **Data:** 04/11/2026

## Contexto

A etapa 6 da F8 (#91) põe o botão "Reconfigurar agora" no resultado da atualização (F7) quando a versão
nova muda o script de coleta. O fim da troca recarrega a página em 3 s para carregar a interface nova, e
depois da recarga o estado de `/api/atualizacao` não diz mais que a versão exigia reconfigurar: a versão
nova já é a instalada. Quem sabe disso depois é a coleta, com o `hashMismatch`, que a Visão geral mostra
com o passo a passo do terminal. Era preciso decidir onde o botão aparece e o que acontece com a recarga.

## Decisão

1. **O botão aparece nos 2 lugares.** No fim da troca, para quem acabou de atualizar. Na Visão geral, no
   aviso de script desatualizado, para quem fechou o diálogo, recarregou ou atualizou pelo terminal.
2. **A versão que muda a coleta não recarrega sozinha.** O fim diz que a versão muda a coleta e traz
   "Reconfigurar agora" e "Agora não". "Agora não" recarrega, e a Visão geral repete o botão. As outras
   versões continuam com a recarga de 3 s.
3. **O mesmo fluxo da engrenagem.** O botão do fim chama o mesmo disparo, a mesma espera e a mesma entrada
   automática (ADR 0036 e 0037), com o texto da pausa da coleta no próprio fim. O botão da Visão geral abre
   o diálogo do item Reconfigurar, que explica a pausa antes de disparar. A rota, os bloqueios e o código
   de uso único não mudam.
4. **Quem diz que a troca exige reconfigurar é o estado de antes dela.** A tela guarda o
   `exigeReconfigurar` da versão detectada ao começar a acompanhar a troca, porque a versão nova some do
   estado quando o painel novo sobe.
5. **Sem login, o terminal.** Com o painel sem login, o aviso e o passo a passo continuam com
   `./dashboard reconfigurar`. Com a troca barrada (e feita pelo terminal), o aviso das novidades também.
   Os bloqueios que só aparecem depois do clique mostram o comando no diálogo, como no item da engrenagem.

## Consequências

- A interface que termina a troca é a da versão anterior, e o botão dela fala com o painel novo. A rota e
  a espera são as mesmas desde a 2.5.0, e o assistente que abre é o da versão nova.
- Depois de "Agora não", o botão da Visão geral só aparece depois da 1ª coleta do painel novo, que traz o
  `hashMismatch`.

## Alternativas descartadas

- **Só no fim da troca:** quem fecha o diálogo ou recarrega perde o botão e volta ao terminal.
- **Só na Visão geral, depois da recarga:** a pessoa precisaria esperar a 1ª coleta e procurar o aviso.
- **Guardar no navegador que a troca exigia reconfigurar:** o `hashMismatch` da coleta já diz isso, com o
  servidor como fonte, e vale também para a troca pelo terminal.
