# ADR 0037 — Reconfigurar pela tela: a espera do assistente e o motivo na tela

- **Status:** Aceita
- **Data:** 04/11/2026

## Contexto

A etapa 4 da F8 (#91) deixou um link provisório no diálogo: depois do 202, a pessoa clicava para abrir
o assistente. A etapa 5 troca o clique pela espera e pela entrada automática, traz o botão Cancelar do
assistente e mostra na tela o motivo de uma reconfiguração que não valeu. As ADRs 0035 e 0036 deixaram
esse motivo em `data/reconfigurar.log`, um arquivo 0600 que o painel não lia. Era preciso decidir como
a tela sabe que o assistente subiu, como o motivo chega a ela sem expor o log e como a espera termina
quando nada sobe.

## Decisão

1. **A tela reconhece o assistente pelo `/`.** O assistente responde `/` com 302 para `/configurar`, e o
   painel nunca redireciona o `/`. A tela pede `/` a cada 1 s sem seguir o redirecionamento
   (`redirect: 'manual'`). Assim ela não abre o login do painel com o 401 do assistente e não enche o
   console de 404.
2. **A tela entra sozinha com `/configurar#codigo=<código>`.** O código fica no fragmento, que não vai ao
   servidor, e o assistente o tira do endereço ao entrar, como no link do terminal.
3. **O motivo vai pelo estado que já existe.** `GET /api/atualizacao` e o evento SSE `atualizacao` trazem
   `reconfiguracao: { em, motivos }`: o instante da última escrita do log e só as linhas de falha (✗),
   no máximo 5, com até 300 caracteres cada. O resto do log descreve a pasta e a máquina e fica no disco.
   Nenhuma rota nova: o estado já exige sessão e já é da manutenção (ADR 0036).
4. **A tela decide pelo instante.** Na espera, só vale uma falha mais nova que o clique: é a recusa deste
   pedido, e o painel continua no ar. Na volta do assistente, a página chega com
   `#/visao-geral?reconfigurado=1` e mostra as falhas dos últimos 10 min: é a volta da ADR 0035. Sem
   falha, um aviso curto diz que a configuração nova vale. O pedido sai do endereço, como o
   `?atualizar=1` da ADR 0032.
5. **A espera tem fim.** Depois de 90 s, o diálogo para de esperar e libera o Esc e o Fechar. O link do
   assistente fica, porque o código ainda pode servir se ele subir depois. O texto muda conforme quem
   respondeu por último: o painel no ar ou ninguém.
6. **Cancelar no assistente espera o painel voltar** e entra na Visão geral pela sessão que já existe. O
   botão só aparece no modo `--pela-tela` (o estado do assistente diz o modo), depois de entrar e antes
   de abrir o painel. No terminal, quem cancela continua sendo o Ctrl+C.
7. **Pela tela, os textos do assistente não mandam olhar o terminal.** O modo vem também nas respostas
   sem sessão, para o pedido de código virar a explicação de que o código veio do painel e vale 1 vez.

## Consequências

- O `estado()` da manutenção lê até 64 KB de um arquivo pequeno a cada chamada. Ele roda a cada mudança
  de estado e a cada pedido da tela, nunca em laço.
- A tela não sabe por que um comando que nem chegou a escrever o log falhou. Ela diz que o painel continua
  no ar e mostra o comando do terminal.
- O painel de teste e o e2e simulam a troca numa porta só (`portaTrocavel` em `scripts/painel-teste.mjs`),
  com o assistente falso.

## Alternativas descartadas

- **Rota nova para o log:** aumentaria a superfície por um dado que cabe no estado.
- **Mandar o log inteiro:** ele traz caminhos e o servidor, que a tela não precisa.
- **Arquivo de resultado em JSON ao lado do log:** mais um arquivo em `data/`, com o mesmo conteúdo das
  linhas de falha, que o comando já escreve.
- **Perguntar por `/api/configurar/estado`:** o painel responde 404, que o navegador mostra no console a
  cada segundo, e o 401 do assistente passaria pelo cliente da API do painel, que abre o login.
