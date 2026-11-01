# ADR 0035 — Reconfigurar pela tela: a cópia fica na memória até o painel novo responder

- **Status:** Aceita
- **Data:** 01/11/2026

## Contexto

A ADR 0034 guardou a configuração anterior na memória do processo e só a usava ao desistir. Ela deixou
2 pontos para a etapa 2 da F8 (#91): a volta quando o painel novo não sobe e o `kill -9`, que deixa o
painel parado. Sem terminal, ninguém religa o painel. Era preciso decidir o que conta como "o painel
subiu" e se a cópia passa para o disco.

## Decisão

1. **A cópia continua na memória.** Ela vive até o fim do processo do `--pela-tela`, que só termina
   depois de o painel novo responder ou de a volta acabar. A decisão 7 da ADR 0034 continua valendo.
2. **O painel novo só vale depois de responder.** `panelHealthy` pede `/api/session` e confere o JSON, na
   porta do `.env` novo. Porta aberta não basta: outro programa pode estar nela.
3. **A volta tem ordem fixa:** motivo no log, parar o painel novo, restaurar os 3 arquivos, ligar o
   painel e devolver o "iniciar com o computador" de antes. Parar vem primeiro porque um painel de pé e
   mudo faria o `startPanel` responder "já está rodando" com a configuração nova.
4. **`ligarPainel` que lança erro segue o mesmo caminho** de `ligarPainel` que devolve falha.
5. **Saída 1 depois da volta.** Desistir sai com 0, porque nada foi pedido. Aqui a pessoa pediu uma
   troca, e ela não valeu. O motivo fica em `data/reconfigurar.log`, para a tela mostrar.
6. **`SIGTERM` espera o fim.** Depois do assistente, o processo ignora o sinal até terminar. Morrer
   nesse ponto levaria a cópia junto, e só este processo traz o painel de volta. O `systemctl stop`
   manda `SIGKILL` depois de 90 s, e o pior caso aqui fica abaixo disso.
7. **O terminal não muda.** O `dashboard reconfigurar` mantém a configuração salva e manda rodar o
   `diagnosticar`: lá a pessoa está olhando.

## Consequências

- Um `kill -9`, uma queda de energia ou o OOM killer no meio deixam o painel parado, ou ligado no boot,
  com a configuração daquele momento. O `.env` nunca fica pela metade (`writeAtomic`) e o `DASH_TOKEN`
  não muda, então o login continua valendo. A saída é o `dashboard iniciar` ou o `dashboard reconfigurar`.
- O `known_hosts` e o `.env` do passo 5 podem já apontar para o servidor novo nesse caso. A coleta falha
  ou acusa `hashMismatch`, e a tela mostra isso, como em qualquer problema de coleta.
- A volta não desfaz o que o assistente mudou **no servidor** (ADR 0034) nem o atalho, o comando e o
  autocomplete. Eles não dependem da configuração, e o painel anterior funciona com eles.
- Nenhum segredo novo no disco: o `.backups/` do `atualizar` e o `desinstalar` não mudam.

## Alternativas descartadas

- **Cópia em disco (0600, pasta 0700):** sobreviveria ao `kill -9`, mas alguém precisaria restaurá-la, e
  o serviço do systemd sobe o Node direto, sem passar pelo `dashboard`. Restaurar no boot do painel faria
  o painel regravar o próprio `.env`. E a cópia que sobra é pior do que nenhuma: um `kill -9` depois de o
  painel novo responder deixa uma configuração velha no disco, e um `dashboard iniciar` dias depois
  desfaria uma configuração boa, em silêncio. Separar a sobra boa da ruim pediria carimbos e comparações,
  para um caso que já tem saída manual. Ela também levaria o `DASH_TOKEN` para os backups de `data/`.
- **Marcador sem segredo, só para o `diagnosticar` explicar:** ajuda pouco, e o `diagnosticar` já aponta o
  painel parado e a coleta com problema.
- **Só `waitForPort`:** aceitaria outro programa na porta.
