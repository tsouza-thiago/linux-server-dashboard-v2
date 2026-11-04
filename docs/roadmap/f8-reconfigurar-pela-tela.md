# F8 — Reconfigurar pela tela

- **Nível:** G · **Versão:** 2.5.0 · **Áreas:** telas, instalação, segurança
- **Depende de:** F7 (menu de manutenção no topo, executor fora do serviço, web como
  caminho padrão).
- **Decidido:** o botão "Reconfigurar" fica no menu de manutenção do topo (engrenagem),
  ao lado de "Atualizar". A web é o caminho padrão; o terminal continua. Painel sem login
  (`DASH_TOKEN` vazio): o botão fica desligado e mostra o comando do terminal, como na F7.

## Objetivo

Trocar servidor, pastas, discos, serviços e limiares pela interface, sem abrir o terminal
e sem deixar uma janela de terminal aberta até o fim.

## Situação hoje

- `./dashboard reconfigurar` chama `instalar({ reconfigurar: true })`
  (`server/cli/instalar.js`): para o painel, sobe o assistente (`server/setup/web.js`) na
  **mesma porta**, com código de uso único de 30 min, e abre o navegador. O terminal
  precisa ficar aberto até o fim.
- Cancelar (Ctrl+C) ou deixar 1 h parado fecha o assistente e devolve código 1. O painel
  **não** volta a ligar sozinho nesse caso.
- A web já é o padrão do `reconfigurar` no terminal; `--terminal` abre o TUI.
- O `DASH_TOKEN` é mantido ao reconfigurar (`server/setup/local.js`): a sessão do
  navegador continua válida depois.
- A senha do administrador do servidor fica só na memória do assistente e é descartada
  (`inst.esquecerSenha()`).

## Decisão proposta

1. **Reaproveitar o assistente que já existe**, sem colocar as rotas de instalação dentro
   do painel. Motivo: as rotas do assistente recebem a senha do administrador do servidor;
   mantê-las num processo separado, que só vive durante a reconfiguração, deixa a
   superfície do painel do mesmo tamanho de hoje.
2. **Fluxo:**
   1. "Reconfigurar" no menu abre um `<dialog>` que explica: a coleta pausa durante a
      reconfiguração e o painel volta sozinho no fim.
   2. `POST /api/reconfigurar/iniciar` (sessão, CSRF, limite de mutações) gera um código
      de uso único, devolve o código **só** na resposta para este navegador e grava só o
      hash dele num arquivo 0600 (como o `data/entrar.json`).
   3. O painel inicia, fora do próprio serviço (mesmo executor da F7),
      `dashboard reconfigurar --pela-tela`. Esse modo para o painel, sobe o assistente na
      mesma porta e aceita o código do item anterior no lugar de gerar um novo.
   4. O navegador espera `/configurar` responder e entra com `#codigo=<código>`.
   5. No fim do assistente, o painel liga com a configuração nova e o navegador volta à
      Visão geral, ainda logado.
3. **Cancelar ou abandonar sempre devolve o painel:** no modo `--pela-tela`, cancelar no
   assistente, fechar a aba ou ficar parado religa o painel com a configuração anterior.
   O tempo parado cai de 1 h para 15 min nesse modo, porque a coleta está pausada.
   Motivo: sem terminal aberto, ninguém religaria o painel.
4. **Nada fica pela metade:** o assistente regrava o `known_hosts` no passo 3 e o `.env` e o
   `data/ssh/config` a cada teste de coleta do passo 5. Por isso, o modo `--pela-tela` guarda
   esses 3 arquivos antes do assistente e os restaura ao desistir (ADR 0034). A cópia do
   `.env` anterior fica na memória até o painel novo responder. Se o painel não subir com a
   configuração nova, ele volta para a anterior e a tela diz o motivo (ADR 0035).
5. **Terminal:** `dashboard reconfigurar` continua abrindo o assistente no navegador
   (padrão) e `--terminal` abre o TUI. Com o painel rodando, o padrão passa a abrir o
   painel no menu de manutenção, no mesmo fluxo da tela.
6. **Atualização que exige reconfigurar** (F7, item 9): o resultado da atualização mostra
   o botão "Reconfigurar agora", que segue este mesmo fluxo.
7. **Modo `.deb` (F9):** o mesmo fluxo; só muda o lançador que sobe o assistente.

## Segurança

| Ameaça | Proteção |
|---|---|
| Site de fora dispara a reconfiguração | CSRF de 2 camadas, Host check e sessão |
| Outro programa local usa o código | o código vai só na resposta do `POST`, vale 1 vez e por poucos minutos; em disco só o hash |
| Senha do administrador do servidor exposta | continua só na memória do assistente, nunca no painel, no log ou na URL |
| Painel parado de propósito (negação de serviço) | limite de mutações; a reconfiguração abandonada religa o painel em 15 min |
| Injeção | o `--pela-tela` não recebe texto da tela; o código vai por arquivo 0600 com hash |

## Etapas

1. **Feita (ADR 0034).** Modo `--pela-tela` em `instalar.js`: aceitar o hash do código vindo
   do arquivo, religar o painel ao cancelar ou abandonar, tempo parado de 15 min. Inclui a rota
   `POST /api/configurar/cancelar`, a volta dos 3 arquivos ao desistir e o
   `data/reconfigurar.log`. O arquivo do código já tem as funções de criar e retirar
   (`server/setup/pela-tela.js`).
2. **Feita (ADR 0035).** A cópia fica na memória até o painel novo responder em `/api/session`.
   Se ele não subir, o comando volta à configuração anterior, religa o painel, sai com código 1
   e deixa o motivo em `data/reconfigurar.log`. A etapa 5 mostra esse motivo na tela.
3. **Feita (ADR 0036).** `POST /api/reconfigurar/iniciar`, com o código de `criarCodigoPelaTela`, e
   o executor da F7 para o comando fixo `reconfigurar --pela-tela`. Antes de disparar, a rota barra
   a pasta sem tag assinada, a pasta fora da instalação, a atualização em andamento e o painel sem
   login. Depois de disparar, nada mais dispara por 1 min, e a atualização também espera.
4. **Feita.** Item "Reconfigurar" no menu de manutenção e o diálogo de explicação, com os bloqueios
   da rota. Depois do 202, o diálogo mostra um link com o código, e a pessoa clica. Esse link é
   provisório: a etapa 5 troca o clique pela espera.
5. **Feita (ADR 0037).** Espera do assistente e entrada automática com o código, no lugar do link da
   etapa 4; volta ao painel no fim. O botão Cancelar do assistente entra aqui, só no modo
   `--pela-tela`, e espera o painel voltar. Os textos que mandam olhar o terminal também mudam nesse
   modo. Se o comando recusar ou o painel novo não subir, a tela mostra só as linhas de falha do
   `data/reconfigurar.log`, pelo estado de `/api/atualizacao`.
6. **Feita (ADR 0038).** Botão "Reconfigurar agora" no resultado da atualização (F7). A versão que muda a
   coleta não recarrega sozinha no fim, e o aviso de script desatualizado da Visão geral também traz o
   botão quando o painel tem login.
7. `dashboard reconfigurar` com o painel rodando abre o menu de manutenção; ajuda da CLI,
   README, TUTORIAL e AGENTS.
8. Segurança: rota nova na matriz de ataque, mutações novas (tirar a sessão; aceitar o
   código 2 vezes), ZAP autenticado, SECURITY.md e ADR.

## Testes

- Integração: rota com e sem sessão; código de uso único (2ª vez recusada); expiração.
- Integração: cancelar, abandonar e terminar o assistente no modo `--pela-tela` religam o
  painel (com a configuração anterior nos 2 primeiros casos).
- Integração: painel novo que não sobe volta ao anterior, com o `./dashboard` de verdade.
- e2e no navegador: menu → diálogo → assistente → volta logado à Visão geral.

## Riscos

- O navegador fecha no meio: o painel volta em 15 min, com a configuração anterior.
- Porta ocupada por outro programa na troca painel ↔ assistente: o executor confere e,
  se não conseguir subir o assistente, religa o painel e grava o motivo no log.
