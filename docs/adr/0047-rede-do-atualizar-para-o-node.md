# ADR 0047 — Node baixado pelo executor e rede do `atualizar`

- **Status:** Aceita
- **Data:** 05/11/2026
- **Feature:** F9 (#92), etapa 7 de 12. Aplica o item 6 da
  [ADR 0042](0042-modo-sistema-deb-e-executor-em-opt.md) e muda, só para a unidade `atualizar`, os
  itens 5, 6 e 9 da [ADR 0045](0045-unidades-systemd-do-executor.md).

## Contexto

A ADR 0042 (item 6) decidiu que o executor baixa o Node para `/opt/server-dashboard/node/`, com a
soma SHA-256 fixada no `scripts/node-runtime.sh` da versão, que veio numa tag assinada. A ADR 0045
deixou a unidade `atualizar` sem rede e com nota até 0,5 no `systemd-analyze security`, e disse que a
etapa 7 daria a ela a rede que o download pedisse. Subir a nota pede uma ADR nova (item 9).

## Decisão

1. **Quando:** no `atualizar`, depois de extrair a versão nova em `versoes/vX.Y.Z.tmp` e antes de ela
   entrar em `versoes/`. Uma falha no Node não troca nenhum link e não deixa a versão nova no disco.
2. **De onde vêm os dados:** `NODE_VERSION`, `NODE_SHA256_<arquitetura>` e o endereço padrão do
   `NODE_DIST` saem do `scripts/node-runtime.sh` **da versão nova**, lido como texto (o executor nunca
   executa esse arquivo). Cada valor precisa casar com um formato fixo: versão `N.N.N` com principal
   24 ou mais, soma de 64 hex e endereço `https://` (ou `file://`, que os testes usam e que não sai da
   máquina). Nada vem do ambiente, do `estado/` ou da versão atual.
3. **Arquitetura:** `x64` ou `arm64`, pelo `uname -m`, como o `node_arch` do clone. Outra arquitetura
   recusa a troca.
4. **Download:** `curl` (só `https` e `file`, redirecionamento só para `https`, até 200 MB) ou `wget`
   (só `https`). O pacote vai para uma pasta temporária em `node/`. Soma diferente, download cortado
   ou pacote sem `bin/node`: a pasta sai e nada muda.
5. **Troca atômica:** o Node conferido vai para `node/node-vN-linux-A/` com a marca `.soma`, e o link
   `node/bin` troca por rename, como os links de `versoes/`. O lançador segue usando
   `<base>/node/bin/node`. O Node novo vale antes do código novo: os 2 são da mesma versão principal,
   e o Node novo roda o código anterior se a troca parar no meio.
6. **Sem baixar de novo:** com a pasta do Node certo e a marca `.soma` igual à soma da tag, o
   download não acontece. Ficam no disco só o Node em uso e o anterior.
7. **Volta atrás:** o `voltar` não troca o Node (a unidade dele não grava em `node/`). O Node que fica
   é da mesma versão principal e roda a versão anterior.
8. **Unidade `atualizar`:** `ReadWritePaths=` com `versoes`, `estado` e `node`;
   `RestrictAddressFamilies=AF_INET AF_INET6`, sem `PrivateNetwork=` e sem `IPAddressDeny=`, como o
   `verificar`; `After=`/`Wants=network-online.target`; `TimeoutStartSec=20min`, para uma conexão
   lenta. O `voltar` continua sem rede.
9. **Nota máxima** do `systemd-analyze security` do `atualizar`: 1,5, a mesma do `verificar`. Medida
   no systemd 259: 1,1 (era 0,2 sem rede). O `voltar` continua com 0,5.

## Consequências

- A rede do `atualizar` só serve ao download do Node. A segurança vem da soma da tag assinada: um
  espelho ou uma rede hostil pode só fazer a troca falhar, nunca instalar outro Node.
- `test/integration/atualizador.test.js` usa um pacote falso do Node numa pasta local (`file://`) e
  cobre soma certa, soma errada, download cortado, pacote ausente, Node já presente e versão que não
  fixa o Node direito.
- 2 mutações novas em `scripts/mutacao-seguranca.mjs`: sem conferir a soma e soma lida da versão
  atual em vez da versão nova.
- O pacote (etapa 9) cria a pasta `node/` do `_server-dashboard` e depende de `curl` ou `wget`.
