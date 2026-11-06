# ADR 0050 — Importar um clone, desinstalar e `apt purge` no pacote `.deb`

- **Status:** Aceita
- **Data:** 06/11/2026
- **Feature:** F9 (#92), etapa 10 de 12. Aplica os itens 11 e 12 da
  [ADR 0042](0042-modo-sistema-deb-e-executor-em-opt.md) e fecha as recusas da
  [ADR 0043](0043-lancador-e-modo-sistema-nos-subcomandos.md) (`desinstalar` e `--importar-v1`).

## Contexto

Até a etapa 9, o pacote instala, atualiza e volta atrás. Faltam 3 caminhos:

- quem já usa o painel por um `git clone` quer passar para o pacote sem perder a configuração, o
  acesso ao servidor e o histórico;
- `dashboard desinstalar` e `instalar --importar-v1` recusavam no pacote: os 2 gravavam e apagavam
  com os caminhos do clone;
- o `apt remove` deixa em `/opt/server-dashboard` o que o executor criou (`repo.git`, `versoes`,
  `estado`, `node`), e o usuário e os grupos de sistema ficam.

## Decisão

1. **`dashboard instalar --importar-pasta <clone>`** (`server/cli/importar-pasta.js`), só no pacote.
   No clone e no `reconfigurar`, recusa com código 2 antes de criar qualquer coisa: lá não há para
   onde importar.
   1. Confere que a pasta é um clone da V2 instalado: `package.json` 2.x do `linux-server-dashboard`,
      `server/index.js` e `.env`. A V1 continua pelo `--importar-v1`.
   2. Recusa se a conta já tem uma instalação do pacote (o `.env` ou um arquivo em `data/history/`).
      A importação nunca sobrescreve: a saída é `dashboard desinstalar --apagar-historico` antes.
   3. Para o painel do clone antes da cópia (I1: nunca os 2 juntos).
   4. Copia o `.env` e o `data/` para as pastas pessoais, com 0600 nos arquivos e 0700 nas pastas.
      Não segue links (um link poderia apontar para fora do clone) e não traz o PID nem os códigos de
      uso único (`entrar.json`, `reconfigurar.json`). No `.env`, `SSH_CONFIG`, `HISTORY_FILE` e
      `LOG_FILE` absolutos dentro do `data/` do clone viram relativos; fora dele, a linha sai. No
      `data/ssh/config`, só a linha `UserKnownHostsFile` troca. A chave fica no `~/.ssh`, e o ID da
      instalação não muda: a linha do `authorized_keys` no servidor continua valendo.
   5. Tira o `~/.local/bin/dashboard` e o autocomplete pessoal só se apontarem para o clone: eles
      viriam antes do `/usr/bin/dashboard` do pacote.
   6. Instala o serviço de usuário do pacote (troca a unidade do clone) ou liga em segundo plano e
      confere que o painel respondeu. A pasta do clone não muda: ela é a cópia de segurança.
2. **`--importar-v1` funciona no pacote:** os dados da V1 vão para o `data/` da pessoa (`dataDe`).
   Nada mais muda. Com isso, nenhum comando recusa no pacote, e a tabela de recusas da CLI sai.
3. **`dashboard desinstalar` no pacote** limpa o servidor como no clone e apaga só o que é da pessoa:
   o `.env`, `data/ssh`, as sessões, os códigos de uso único e a chave do painel; com o histórico,
   também `data/`, `.backups/` e `.atualizacao/`. As pastas pessoais vazias saem (`rmdir`, que nunca
   apaga conteúdo). Não mexe no comando, no autocomplete nem nos blocos do login, que são do pacote,
   e nunca em `/opt`: o código é de todas as contas da máquina. O fim mostra
   `sudo apt purge server-dashboard`.
4. **`prerm` na remoção** para o timer e também as 3 unidades do executor que estiverem rodando. O
   executor limpa a pasta temporária dele ao parar.
5. **`postrm` no `purge`:**
   1. apaga `repo.git`, `versoes`, `estado` e `node` de `/opt/server-dashboard` com
      `rm -rf --one-file-system` e nomes fixos, e a base com `rmdir`. A base é do root, então o
      executor não troca uma dessas pastas por um link;
   2. remove o usuário `_server-dashboard` e os grupos `_server-dashboard` e `server-dashboard` só se
      forem de sistema (UID ou GID abaixo de 1000). Uma conta de pessoa com o mesmo nome fica. Uma
      falha só avisa, com o comando para fazer à mão;
   3. nunca toca nas pastas pessoais. Ele avisa onde elas ficam.
6. **Ordem para quem tira o painel:** cada pessoa roda `dashboard desinstalar` (limpa o servidor e os
   dados), e depois o administrador roda `sudo apt purge server-dashboard`. Depois do `apt remove`, o
   comando `dashboard` some; os dados ficam, e o acesso no servidor continua até ser limpo à mão.

## Consequências

- O caminho do clone para o pacote é 1 comando, sem refazer o acesso ao servidor.
- `test/unit/pacote-debian.test.js` roda o `prerm` e o `postrm` com comandos falsos (`rm`, `rmdir`,
  `userdel`, `groupdel`, `getent`). `test/integration/cli-manutencao.test.js` cobre a importação, e
  `test/integration/lancador.test.js` cobre o `desinstalar` e as 2 importações pelo lançador.
- 5 mutações novas: purge na remoção comum, conta de pessoa apagada, arquivo importado aberto, link
  seguido e importação por cima de uma instalação.
- A etapa 11 (`scripts/e2e-instalacao/`) roda instalar, atualizar, voltar, desinstalar e purge num
  contêiner de verdade.
