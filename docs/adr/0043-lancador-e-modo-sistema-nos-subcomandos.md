# ADR 0043 — Lançador do pacote e o modo sistema nos subcomandos

- **Status:** Aceita
- **Data:** 05/11/2026
- **Feature:** F9 (#92), etapa 3 de 12. Complementa a [ADR 0042](0042-modo-sistema-deb-e-executor-em-opt.md).

## Contexto

A ADR 0042 decidiu que o lançador do pacote liga o modo sistema e que o `.env` e o `data/` de cada
pessoa ficam nas pastas XDG. A etapa 2 pôs as pastas no `server/config.js`. Faltava o lançador e
faltava a CLI usar essas pastas: ela recebe a pasta do código (`root`) e montava o `.env` e o `data/`
dentro dela. No pacote, essa pasta é `/opt/server-dashboard/versoes/vX.Y.Z`, do executor e só leitura.

## Decisão

1. **Lançador `bin/dashboard`** (`sh` POSIX, ShellCheck limpo). Ele acha a pasta do pacote pelo
   caminho real dele mesmo (`readlink -f "$0"`), nunca pelo ambiente. Resolve o link `atual` 1 vez,
   para a execução inteira usar a mesma versão. Usa o Node de `<base>/node/bin/node` (o executor o
   baixa na etapa 7) e, sem ele, o Node 24 do sistema. Não baixa e não grava nada. Define
   `SERVER_DASHBOARD_MODO=sistema` e chama a mesma CLI de `server/cli/`.
2. **De qual pasta saem o `.env` e o `data/`:** `pastasDe(root)` no `server/config.js`. A pasta do
   código que roda (`ROOT`) segue o modo do lançador. Qualquer outra pasta (a de um teste, a da V1 a
   importar) é um clone, com o `.env` e o `data/` dentro dela. Os auxiliares `envDe`, `dataDe` e
   `backupsDe` trocam os `path.join(root, '.env')` e `path.join(root, 'data')` da CLI, da instalação
   e da atualização. No modo clone, o resultado é o mesmo de antes.
3. **Serviço de usuário no pacote:** a unidade roda o código pelo link `atual` (a versão nova vale no
   próximo reinício) e leva no `Environment=` o sinal do modo, o `XDG_CONFIG_HOME` e o
   `XDG_DATA_HOME` da instalação: o systemd de usuário não herda o ambiente do terminal. O
   `ReadWritePaths=` é o `data/` da pasta XDG. O atalho do menu abre pelo lançador.
4. **Comando e autocomplete:** no pacote, vêm do pacote (`/usr/bin/dashboard` e
   `/usr/share/bash-completion`). A instalação não cria o link pessoal da F4 nem o da F5, e as
   mensagens citam `dashboard`.
5. **O que recusa no pacote até a etapa que o traz**, com o motivo e o que fazer, sem mexer em nada:
   `atualizar` (etapas 4 e 8), `reconfigurar --pela-tela` (etapa 8), `desinstalar` e
   `instalar --importar-v1` (etapa 10). No painel, os botões Atualizar e Reconfigurar ficam com o
   bloqueio `outra-pasta`, porque rodariam o `git` e o `./dashboard` da pasta do código.
6. **Instalação no pacote:** pula a conferência da tag pelo `git` (o pacote e o executor conferem a
   assinatura, ADR 0042) e chama `prepararPastas()` antes de criar o `data/`.

## Alternativas consideradas

- **Passar as pastas em todo o caminho da CLI** (um objeto `pastas` no lugar de `root`): mais
  explícito, mas muda a assinatura de dezenas de funções e dos testes do modo clone. A regra do item
  2 dá o mesmo resultado com mudança pequena, e os testes injetam as pastas.
- **O lançador passa a pasta do pacote por variável de ambiente:** desnecessário. A pasta sai do
  layout `<base>/versoes/vX.Y.Z` (`caminhosDoPacote`), e o ambiente nunca escolhe qual código roda.
- **Baixar o Node no lançador:** recusado. O lançador roda como a pessoa e não pode gravar em `/opt`
  (ADR 0042, item 6).

## Consequências

- O modo clone continua igual: os testes de antes passam sem mudança, e um teste confere a CLI sem o
  sinal.
- No pacote, nada é gravado na pasta do código. O teste do lançador monta o layout do pacote numa
  pasta temporária e confere as pastas pessoais com 0700.
- Os comandos recusados voltam a funcionar nas etapas 4, 8 e 10, cada uma com os seus testes.
