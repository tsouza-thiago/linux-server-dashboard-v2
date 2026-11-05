# ADR 0044 — Executor `atualizador` do pacote

- **Status:** Aceita
- **Data:** 05/11/2026
- **Feature:** F9 (#92), etapa 4 de 12. Complementa a [ADR 0042](0042-modo-sistema-deb-e-executor-em-opt.md).

## Contexto

A ADR 0042 decidiu que um usuário de sistema sem privilégio (`_server-dashboard`) grava as versões
do painel em `/opt/server-dashboard`, com 3 operações: `verificar`, `atualizar` e `voltar`. Ela não
fixou o formato do estado, como trocar os links sem risco, nem o que fazer com o ambiente de quem
chama. Esta ADR fixa esses detalhes.

## Decisão

1. **Arquivo:** `libexec/atualizador`, em `sh` POSIX (ShellCheck limpo), com 1 argumento só:
   `verificar`, `atualizar` ou `voltar`. Outro texto ou mais argumentos: código 2. Como root, recusa:
   o pacote o roda como `_server-dashboard` (unidades da etapa 5).
2. **Pasta base** pelo caminho real do próprio arquivo (`readlink -f "$0"`, como o lançador). Antes
   de tudo, o executor se roda de novo com `env -i`: só `PATH=/usr/sbin:/usr/bin:/sbin:/bin`,
   `LC_ALL=C` e `HOME=/nonexistent`. Nenhuma variável de quem chamou (`GIT_DIR`, `GIT_CONFIG_*`,
   `GIT_SSH`…) muda o resultado. O git roda sem a configuração do sistema e da pessoa, sem hooks e só
   com os protocolos `https` e `file`.
3. **Chaves:** as de `versoes/<atual>/docs/allowed_signers`; sem elas, as de partida em
   `share/allowed_signers`. A versão nova nunca se autoaprova.
4. **Tag aceita:** nome no padrão de versão (o mesmo `RELEASE_TAG` de `server/setup/assinatura.js`),
   objeto do tipo tag, assinatura válida pelo `git verify-tag` com as chaves acima e o nome gravado
   **dentro** da tag igual ao nome da ref. Assim, uma tag velha assinada publicada com outro nome
   (para forçar uma versão com falha conhecida) é recusada. Pré-versão só para quem já está numa (a
   liberação do `--pre` fica para a etapa 8).
5. **`verificar`:** busca só as tags (`refs/tags/*:refs/tags/*`, sem forçar: uma tag já conhecida
   nunca muda) e, da mais nova para a mais antiga, para na 1ª aceita acima da versão atual (como o
   `newestSignedTag`). Grava `estado/disponivel` e o CHANGELOG da tag em `estado/novidades.md` (até
   256 KB, só texto). Sem o `repo.git`, cria um, com a origem fixa do GitHub.
6. **Formato de `estado/`** (0644, `chave=valor`, sem segredo, gravado por cópia e rename):
   - `disponivel`: `versao`, `objeto` (o hash da tag conferida), `verificado` (segundos Unix) e
     `erro` (`falhou` quando o `git fetch` falha);
   - `troca`: `em`, `de` e `para` da última troca; depois de um `voltar`, só `voltou`;
   - `registro.log` (gira em 256 KB) e `trava/` (1 operação por vez; trava de processo morto sai).
7. **`atualizar`:** instala só a versão de `estado/disponivel`, e só se a tag ainda tiver o mesmo
   `objeto` e a assinatura conferir de novo. Extrai com `git archive | tar -x` em `versoes/vX.Y.Z.tmp`
   (a falha do `git archive` fica num arquivo-marca, porque o `sh` não tem `pipefail`), exige
   `server/cli/index.js` e renomeia para `versoes/vX.Y.Z`. Os links são relativos e trocados por
   `ln -sfn` num nome ao lado e `mv -fT` por cima (rename atômico; o `-T` é do GNU, presente no
   Debian e no Ubuntu). Primeiro o `anterior`, depois o `atual`: uma queda no meio deixa o `atual`
   intacto. No disco ficam só a versão atual e a anterior.
8. **`voltar`:** só se o `estado/troca` disser que a última troca levou ao `atual` de hoje, o link
   `anterior` apontar para o `de` dela e não tiverem passado 24 h. Troca o `atual`, tira o
   `anterior` e marca a troca como desfeita: um 2º `voltar` é recusado.
9. **`dashboard atualizar`** continua recusado no pacote até a etapa 8, que liga o painel ao
   executor pelas unidades (etapa 5) e pelo polkit (etapa 6). O download do Node (etapa 7) entra no
   `atualizar`, antes do rename da versão nova (ponto marcado no código).

## Consequências

- O executor é testado numa pasta temporária, com uma origem local e tags assinadas por uma chave de
  teste (`test/integration/atualizador.test.js`). 4 mutações em `scripts/mutacao-seguranca.mjs`
  quebram a conferência do nome da tag, a 2ª conferência da assinatura, o prazo de 24 h e a limpeza
  do ambiente.
- O painel (etapa 8) lê `estado/` sem rodar o git.
- O `verifyTag` do modo clone ainda não confere o nome gravado dentro da tag. Fica como melhoria à
  parte.
