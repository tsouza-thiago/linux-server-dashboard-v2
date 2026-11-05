# ADR 0048 — O painel usa o executor do pacote para trocar de versão

- **Status:** Aceita
- **Data:** 05/11/2026
- **Feature:** F9 (#92), etapa 8 de 12. Aplica o item 4 da
  [ADR 0042](0042-modo-sistema-deb-e-executor-em-opt.md), fecha o item 5 da
  [ADR 0043](0043-lancador-e-modo-sistema-nos-subcomandos.md) e os itens 4 e 9 da
  [ADR 0044](0044-executor-atualizador-do-pacote.md).

## Contexto

No pacote `.deb`, o código fica em `/opt`, só leitura para a pessoa. O executor (ADR 0044) troca a
versão, pedido pelas unidades do sistema (ADR 0045) e liberado pelo polkit para o grupo
`server-dashboard` (ADR 0046). Até esta etapa, o painel não usava nada disso: o `dashboard atualizar`
e o `reconfigurar --pela-tela` recusavam no pacote, e os botões Atualizar e Reconfigurar ficavam com o
bloqueio `outra-pasta`. A ADR 0042 fixou o fluxo; faltavam os detalhes abaixo.

## Decisão

1. **Procura sem git** (`server/atualizacao/pacote.js`): no pacote, o painel lê
   `<base>/estado/disponivel` e `novidades.md`, gravados pelo `verificar` do executor, no lugar do
   `git fetch` da ADR 0030. Sem processo à parte e sem rede. A versão só vale no formato de
   `RELEASE_TAG` e mais nova que a instalada; o resto (assinatura, nome gravado na tag) o executor já
   conferiu. A hora mostrada é a do executor, e `erro=falhou` vira `sem-acesso`. Como o timer roda 1
   vez por dia com até 6 h de atraso, o painel relê o `estado/` de hora em hora.
2. **Troca pelo `dashboard atualizar`** (`trocarNoPacote`, `server/cli/atualizar.js`): o mesmo comando
   e o mesmo registro da F7 (trava, fases, tela de progresso), com outro miolo. Na ordem da ADR 0042:
   para o painel, copia o `data/` da pessoa para `.backups/`, pede
   `systemctl --no-ask-password start server-dashboard-atualizar.service` e confere o link
   `versoes/atual`. A versão do link liga o painel (`atualizar --pos-atualizacao` pelo lançador, que
   resolve o link de novo) e confere a saúde. Se falhar, pede `server-dashboard-voltar.service`,
   confere o link e devolve os dados da cópia. O código de saída do `systemctl` não basta: vale o link,
   que é o que o lançador e o serviço seguem.
3. **Comando fixo (I11):** só os 2 nomes de unidade, em constante, em lista, sem shell e sem
   parâmetro (`iniciarUnidade` recusa outro nome). `--no-ask-password`: sem terminal, um pedido que o
   polkit não libera falha logo, e a mensagem manda conferir o grupo e entrar de novo na sessão.
4. **Log junto:** antes de cada pedido, o painel guarda o tamanho do `estado/registro.log`; depois,
   copia para o log da troca as linhas novas, com o prefixo `executor:` (até 64 KB; se o log girou,
   lê do começo).
5. **Falha do `voltar`:** o código fica na versão nova, os dados ficam como estão e a mensagem diz
   onde está a cópia. Restaurar dados velhos sob o código novo poderia estragá-los.
6. **Registro da F7 fora de `/opt`:** `.atualizacao/` fica na pasta de dados da instalação
   (`pastasDe(root).dados`): a do projeto no clone, a XDG no pacote.
7. **Disparo pela tela:** o executor da F7 roda o lançador do pacote (`<base>/bin/dashboard`) no lugar
   do `./dashboard`. O `systemd-run --user` não herda o ambiente do painel: o pedido leva o
   `XDG_CONFIG_HOME` e o `XDG_DATA_HOME` da instalação em `--setenv`, como a unidade do serviço
   (ADR 0043). São valores da configuração, nunca da tela.
8. **Bloqueios no pacote:** `outra-pasta` só sem o `.env` da pessoa ou com o serviço de outra pasta.
   Não há `arquivos-alterados` (sem git) nem `sem-assinatura` no Reconfigurar: quem conferiu a
   assinatura foi o pacote ou o executor (ADR 0042). O `reconfigurar --pela-tela` deixa de recusar.
9. **`--pre` no pacote:** recusado, com o motivo. A unidade não recebe parâmetro, e liberar uma
   pré-versão pediria um arquivo que a pessoa grava e o executor lê, a pasta compartilhada que a
   ADR 0042 descartou. Pré-versão continua só para quem já está numa (ADR 0044, item 4).
10. **Node do serviço:** no pacote, a unidade de usuário usa o link `<base>/node/bin/node`. O
    `process.execPath` é o caminho real, numa pasta do Node que o executor apaga depois de 2 trocas
    (ADR 0047), e o serviço deixaria de subir.

## Alternativas consideradas

- **Pedir a unidade com o painel no ar e só depois parar e copiar:** o painel ficaria fora do ar
  menos tempo quando o executor baixa o Node. Descartado: a ADR 0042 fixou a cópia antes do pedido, e
  a tela já espera até 3 min pelo painel.
- **Um caminho novo, sem o `dashboard atualizar`:** duplicaria a trava, o registro e a tela de
  progresso da F7. O mesmo comando com outro miolo mantém um só fluxo e os mesmos testes da tela.
- **Ler o `estado/` a cada pedido da tela:** simples, mas leria o disco a cada `/api/atualizacao`. A
  agenda de hora em hora e o "Procurar agora" bastam.

## Consequências

- `dashboard atualizar` e o `reconfigurar --pela-tela` funcionam no pacote; continuam recusados o
  `desinstalar` e o `--importar-v1` (etapa 10). A tela não muda.
- Testado sem systemd, polkit ou rede (`test/integration/atualizacao-pacote.test.js`): pacote falso
  numa pasta temporária, `systemctl` e versão nova injetados. A instalação real do pacote é testada na
  etapa 11.
- Mutações novas quebram o nome fixo da unidade, a conferência do link depois da troca, a volta
  atrás e a recusa do `--pre`.
