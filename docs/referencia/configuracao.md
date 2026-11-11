# Configuração

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

O assistente grava o `.env` (0600). A coluna **Padrão** é o valor que o código usa quando a variável falta ou está
vazia. Valor fora da faixa volta ao padrão (os limiares avisam no log).

| Variável | Padrão | Faixa | Descrição |
|---|---|---|---|
| `SSH_HOST` | `seu-host` | alias ou `usuario@host` | Servidor. O assistente grava `servidor`, o alias do `data/ssh/config` |
| `SSH_CONFIG` | *(vazio)* | dentro de `data/` | Configuração SSH própria (`ssh -F`). Vazio = usa o `~/.ssh/config` (V1). O assistente grava `data/ssh/config` |
| `SSH_ACESSO` | `direto` | `restrito` ou `direto` | `restrito`: a chave só roda a coleta e o painel envia só o modo. `direto`: o painel envia o script inteiro (V1). O assistente grava `restrito` |
| `POLL_INTERVAL` | `60000` | `10000`–`3600000` | Intervalo entre coletas, em ms |
| `PORT` | `3000` | `1`–`65535` | Porta do painel (só em 127.0.0.1) |
| `HISTORY_LIMIT` | `4320` | `100`–`100000` | Amostras brutas em memória (4320 = 72 h a 1 por minuto) |
| `HISTORY_FILE` | `data/history.json` | dentro de `data/` | Histórico da V1 a migrar (1 vez, com backup). A pasta dele também é a de `history/` e `rollup/`; mantenha em `data/` |
| `LOG_FILE` | `data/dashboard.log` | dentro de `data/` | Log do painel (gira em 5 MB para `dashboard.log.1`) |
| `NET_IF` | *(vazio)* | 1 interface | Interface de rede. Vazio = sem a seção de rede |
| `DISK_MOUNTS` | `/` | pontos de montagem | Pastas acompanhadas, separadas por espaço |
| `DISK_DEVS` | *(vazio)* | discos | Discos com leitura e gravação (I/O), ex.: `sda sdb` |
| `SMART_DEVS` | *(= DISK_DEVS)* | discos | Discos com teste SMART (1 vez por hora). Ausente = os de `DISK_DEVS`; presente e vazio = nenhum |
| `SERVICES` | *(vazio)* | serviços systemd | Serviços acompanhados, separados por espaço |
| `DASH_TOKEN` | *(vazio)* | texto sem espaço | Token de acesso. A instalação gera um; vazio = sem login |
| `ALERT_DISK_PCT` | `90` | `50`–`99` | Alerta de disco (% usado) |
| `ALERT_RAM_PCT` | `90` | `50`–`99` | Alerta de RAM (% usada) |
| `ALERT_TEMP_C` | `60` | `30`–`110` | Alerta de temperatura da CPU (°C) |
| `ALERT_HYSTERESIS` | `5` | `0`–`20` | Quanto o valor precisa cair abaixo do limiar para o alerta limpar |
| `ALERT_OFFLINE_AFTER` | `2` | `1`–`10` | Coletas seguidas com falha antes de "servidor inacessível" |

Mudar alvos (pastas, discos, serviços) à mão quebra a chave restrita: o script no `authorized_keys` deixa de bater
(`hashMismatch`). Use `./dashboard reconfigurar`.

**Modo sistema e pacote `.deb`** (ADRs [0042](../adr/0042-modo-sistema-deb-e-executor-em-opt.md) a
[0050](../adr/0050-importar-desinstalar-e-purge-no-pacote.md), F9). Só as regras de trabalho; o resto está nas ADRs:

- **Modo sistema** (0042, 0043): o lançador `bin/dashboard` define `SERVER_DASHBOARD_MODO=sistema` (só o valor exato
  vale, nunca pelo `.env`). O `.env` fica em `~/.config/server-dashboard/` e o `data/` em
  `~/.local/share/server-dashboard/` (seguem `XDG_CONFIG_HOME` e `XDG_DATA_HOME`; valor relativo é ignorado), com
  0700/0600. Os caminhos de dados ficam presos nesse `data/`, nunca no código em `/opt`. Sem a variável, é o modo
  clone. A CLI acha as pastas por `pastasDe(root)` (`envDe`, `dataDe`, `backupsDe`). O lançador acha a pasta pelo
  caminho real, nunca pelo ambiente, e usa o Node de `<base>/node/bin/node` ou o Node 24 do sistema. No pacote, a
  instalação não cria o link nem o autocomplete pessoais.
- **Executor** (`libexec/atualizador`, 0044, 0045, 0047): o único que grava o código em `/opt`, como
  `_server-dashboard` (nunca root), com `env -i`. Só instala a versão que o `verificar` aceitou: tag assinada pelas
  chaves da versão `atual`, com o nome da tag igual ao da ref; `atualizar` não recebe parâmetro; `voltar` vale 1 vez,
  até 24 h depois. O Node novo vem antes: versão e SHA-256 saem do `scripts/node-runtime.sh` da versão nova, lido como
  texto e nunca executado; só `https`. As unidades (`pacote/systemd/`) são de uso único, com o subcomando fixo no
  `ExecStart=` e isoladas; só `verificar` e `atualizar` têm rede. `test/unit/unidades-systemd.test.js` exige cada
  diretiva e a nota do `systemd-analyze security`.
- **Polkit e grupos** (0046): a regra libera sem senha só `manage-units` com `start` em
  `server-dashboard-atualizar.service` e `server-dashboard-voltar.service`, para o grupo `server-dashboard` (criado
  vazio pelo `sysusers.d`, como o usuário `_server-dashboard`, sem login e fora do grupo).
  `test/unit/polkit-e-grupo.test.js` confere cada combinação.
- **Painel no pacote** (0048): lê `<base>/estado/disponivel` e o `novidades.md` de hora em hora, sem git nem rede.
  `dashboard atualizar` para o painel, copia o `data/`, pede
  `systemctl --no-ask-password start server-dashboard-atualizar.service` (nome fixo) e, se o painel novo não
  responder, pede `server-dashboard-voltar.service` e devolve os dados. `--pre` é recusado.
- **Pacote** (0049): `npm run empacotar-deb`; a mesma ref dá os mesmos bytes. O `apt purge` nunca toca nas pastas
  pessoais. O mantenedor assina o `dist/SHA256SUMS` (`ssh-keygen -Y sign -n server-dashboard`).
- **Do clone para o pacote** (0050): `dashboard instalar --importar-pasta <clone>` só vale no pacote (no clone e no
  `reconfigurar`, sai com código 2); recusa se a conta já tem `.env` ou histórico. O `desinstalar` do pacote nunca
  apaga o comando, o autocomplete, os blocos do login nem `/opt`.
