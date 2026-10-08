# Server Dashboard — referência técnica (agentes e desenvolvimento)

Painel de monitoramento, em tempo real, de um servidor Linux da rede local. Toda a carga
fica na máquina local; o servidor só responde **1 comando SSH por minuto**. Este requisito
é obrigatório: o hardware do servidor é muito limitado.

Este arquivo é a **referência técnica única** do projeto: regras, arquitetura,
configuração, coleta, formato da amostra, persistência, API e alertas. Os outros
documentos não repetem estes detalhes:

- [README.md](README.md): visão geral, instalação e comandos.
- [TUTORIAL.md](TUTORIAL.md): passo a passo para leigos.
- [SECURITY.md](SECURITY.md): modelo de ameaças.

O teste `test/unit/docs.test.js` confere esta documentação contra o código.

## Regras (obrigatórias)

- **1 único SSH por coleta**, com um comando combinado. Nada de conexões em paralelo
  contra o servidor.
- **Servidor somente leitura.** Nunca compilar, instalar pacotes ou rodar scripts pesados
  **no servidor**. Não há agente nem dependência no servidor.
- O servidor é modesto (1 núcleo, pouca RAM) e tem discos **SMR**: evitar escrita
  intensa ou aleatória nele.
- **Apenas comandos não interativos.** O painel conecta pelo alias `servidor` do
  `data/ssh/config`. Para inspeções à mão, use o seu alias do `~/.ssh/config`
  (ex.: `ssh meu-servidor '<comando>'` → `usuario@192.0.2.10:22`).
- **NUNCA** exibir, imprimir ou commitar o conteúdo de `.env`. O `.env` do servidor tem
  senhas. O painel não guarda senha: a coleta usa uma chave SSH. A senha do administrador
  serve só na instalação, fica na memória e é descartada.
- **Nunca commitar `data/`.** Ela tem hostnames, IPs e telemetria da rede interna.
- Dado dinâmico (temperatura, espaço, status) é sempre coletado ao vivo, nunca presumido.
  Dado ausente é `null`, nunca zero inventado.
- O painel escuta só em `127.0.0.1`.

### Regras de segurança (security by design)

- **Configuração centralizada** em `server/config.js`: parser único do `.env` (com override
  de `process.env`), validação de faixas (tabela [Configuração](#configuração)) e caminhos
  de dados forçados para dentro de `data/` (`clampPathToData`).
- **Anti-injeção**: `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS`, `SMART_DEVS` e `SERVICES` passam
  por `sanitizeToken()` (whitelist `[A-Za-z0-9_./:-]`, recusa token iniciado com `-`)
  **antes** de entrar no script de coleta (`server/collector/builder.js`). `SSH_HOST`
  passa por `sanitizeHost()`, e `runSSH()` recusa host iniciado com `-`.
- **Host check** (`server/security.js`): `Host` diferente de `localhost`, `127.0.0.1` ou
  `[::1]` recebe 403. Isto bloqueia DNS rebinding.
- **CSRF em 2 camadas**: mutações (POST/PUT/PATCH/DELETE) com `Origin` diferente do Host
  ou com `Sec-Fetch-Site: cross-site` recebem 403. Mutações com `Origin` também precisam
  do cookie `dash_csrf` (SameSite=Lax, HttpOnly), emitido nos GETs.
- **Cabeçalhos** em todas as respostas, inclusive 401/403/404: CSP sem `'unsafe-inline'`
  e sem `'unsafe-eval'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **Anti-XSS** (ADR 0010): a tela monta HTML só pelo template `html` de
  `public/js/core/html.js`, que escapa toda interpolação. HTML cru só por `raw()`
  explícito. Medidas vindas dos dados (largura de barra, cor) vão em `data-w`/`data-bg`/…
  e são aplicadas pelo CSSOM em `mount()`. Nunca `style="…"` no HTML.
- **Export seguro**: `server/csv.js` impede formula injection (`=+-@` → prefixo `'`) e
  saneia o nome do arquivo.
- **Permissões**: `data/` e `data/ssh/` com 0700; `.env`, chave e arquivos de dados com
  0600. A instalação grava assim (`server/setup/local.js`), a escrita também
  (`{ mode: 0o600 }`) e o `./dashboard diagnosticar` aponta o que estiver aberto.
- **Token e sessão** (ADR 0007): a instalação gera um `DASH_TOKEN`. Com ele, `/api/*` e
  `/api/stream` exigem sessão (cookie `dash_session`, HttpOnly + SameSite=Strict, 30 dias
  renovados com o uso) ou `Authorization: Bearer <token>`. O token é trocado 1 vez em
  `/api/login` (10 tentativas/min/IP). Em disco (`data/sessions.json`) fica só o SHA-256
  da sessão. `?token=` na URL **não** vale. Comparação com `crypto.timingSafeEqual`.
  `GET /entrar?codigo=` aceita o link de uso único do `./dashboard abrir` (só o hash em
  `data/entrar.json`, 2 min, vale 1 vez).
- **Limites**: `/api/poll` com piso de 5 s entre coletas manuais; mutações da API com 120
  por minuto por IP; corpo JSON com até 50 KB (413 acima); SSE com até 20 conexões (503
  acima); resposta do SSH com até 1 MB (`MAX_OUTPUT_BYTES`; acima disso a conexão é
  cortada).
- **Erros sem vazamento**: o error handler central devolve JSON sem stack trace.
- **HTTP próprio** (ADR 0003): `node:http` + `server/http/` (roteador, estáticos só de
  `public/` com lista de tipos, sem arquivo oculto, pasta ou traversal). Backend sem
  dependência de runtime. `test/integration/http-seguranca.test.js` é a caracterização
  caixa-preta e precisa continuar verde.
- **SSH isolado**: `BatchMode=yes` + `ConnectTimeout=10`. Com `SSH_CONFIG`, o painel usa só
  `ssh -F data/ssh/config`, com `known_hosts` próprio e `StrictHostKeyChecking yes`
  (nunca `no` nem `accept-new` depois da instalação).
- **Acesso restrito** (ADR 0008, `SSH_ACESSO=restrito`): usuário `dashmon` sem senha. A
  linha do `authorized_keys` é `restrict,from=,command="<coleta>"`, gerada e escapada em
  `server/setup/acesso.js` (conferida contra o `opt_dequote` do OpenSSH). O painel envia só
  a palavra do modo (`basico` ou `smart`); qualquer outro texto vira `basico`. Sudoers com
  um `smartctl -H /dev/X` por disco, nunca curinga, validado com `visudo -cf`.
- **Instalação** (`server/setup/`): toda entrada é validada em `acesso.js` antes de virar
  arquivo ou comando. A senha do administrador fica só em memória: o `ssh` a recebe pelo
  askpass (variável de ambiente só daquele processo), e o `sudo -S -k` pelo stdin. Ela
  nunca vai na linha de comando e é descartada no fim do passo 5. O assistente web só abre
  com código de uso único e tem as mesmas proteções do painel.
- **Versões assinadas** (ADR 0012): o instalador e o `./dashboard atualizar` só aceitam
  tags assinadas por uma chave de `docs/allowed_signers`.

## Desenvolvimento (obrigatório)

- **Plano e decisões:** `docs/PLANO_V2.md` (fases F0–F9, invariantes, bugs B1–B12) e
  `docs/adr/` (uma ADR por decisão; ADR aceita não é editada, é substituída por outra).
- **Antes de todo commit:** `npm run check` (sintaxe JS e shell, `.env`/`data/` fora do git,
  testes + cobertura, `npm audit`). Nenhum commit vermelho.
- **Documentação junto com o código:** mudou comando, opção, variável, rota ou arquivo?
  Atualize este arquivo (e o README/TUTORIAL, se a pessoa usuária vê a mudança).
  `test/unit/docs.test.js` falha se a documentação divergir do código.
- **Commits:** Conventional Commits em PT-BR (`feat(escopo):`, `fix:`, `test:`, `docs:`,
  `refactor:`, `style:`, `perf:`, `chore:`, `security:`), uma mudança lógica por commit.
- **CHANGELOG.md** atualizado no mesmo commit da mudança (Keep a Changelog).
- **Bugs conhecidos** ficam em `test/unit/bugs-v1.test.js` como `todo`; o commit que corrige
  remove o `todo` (o teste vira regressão).
- **Versões:** SemVer, uma pré-versão por fase, com tag assinada e release
  (procedimento na ADR 0012).
- **Node.js 24** é a versão mínima (ADR 0002).
- **Exemplos** usam só IPs de documentação (`192.0.2.x`, RFC 5737) e nomes genéricos.

## Arquitetura

```
[Servidor Linux]  ← 1 SSH/min (script único, LC_ALL=C, não interativo, somente leitura)
        ↑
[poller]  coleta → parse → taxas → alertas → amostra (schemaVersion 2)
        ↓
[storage]  data/history/ (72 h brutas, NDJSON) + data/rollup/ (90 dias em baldes de 5 min)
        ↓
[node:http 127.0.0.1:3000]  telas + API REST + SSE (tempo real)
        ↓
[Navegador]  8 telas (ES modules + uPlot, sem build), saúde, eventos, relatórios
```

Toda a interatividade (filtros, ordenação, zoom, previsão, agregações) roda no
navegador. O backend só coleta, persiste e serve. O limite de 1 SSH por minuto continua.

## Comandos

```bash
./dashboard instalar            # assistente no navegador (--terminal: TUI; --sem-interface: sem perguntas)
./dashboard instalar --importar-v1 <pasta>   # upgrade V1 → V2 (para a V1, traz .env e data/)
./dashboard abrir               # abre o painel já logado (link de uso único)
./dashboard iniciar             # serviço de usuário ou segundo plano
./dashboard parar               # para só o processo do painel desta pasta (PID conferido, B12)
./dashboard status              # rodando ou parado
./dashboard diagnosticar        # explica cada problema; usa a última amostra (sem SSH extra)
./dashboard reconfigurar        # reabre o assistente
./dashboard atualizar           # tag assinada mais nova, backup de data/, volta atrás se falhar
./dashboard desinstalar         # remove daqui e oferece limpar o servidor
./dashboard versao              # versão instalada
npm start                       # o painel em primeiro plano (node server/index.js)
npm run poll                    # 1 coleta, sem o servidor web (node server/poller.js --once)
npm test                        # suíte de testes (node --test)
npm run check                   # verificação completa, obrigatória antes de cada commit
npm run test:unit               # só testes unitários (test/unit)
npm run test:integration        # só integração (HTTP, shell, ssh falso, sshd real)
npm run test:e2e                # ponta a ponta no Chromium (playwright-core; pula sem navegador)
npm run capturar-amostra        # 1 coleta real → data/amostra-{bruta,anonima}.txt (fixtures)
npm run migrar-v1 -- --verificar  # resume o data/history.json da V1 sem gravar nada
npm run migrar-v1               # migra a V1 agora (o painel também migra sozinho ao iniciar)
scripts/e2e-instalacao/rodar.sh # instalação de ponta a ponta em contêineres Debian/Ubuntu
```

Opções do modo sem perguntas: `./dashboard instalar --sem-interface --ajuda`.

## Configuração

O assistente grava o `.env` (0600). A coluna **Padrão** é o valor que o código usa quando a
variável falta ou está vazia. Valor fora da faixa volta ao padrão (os limiares avisam no
log).

| Variável | Padrão | Faixa | Descrição |
|---|---|---|---|
| `SSH_HOST` | `seu-host` | alias ou `usuario@host` | Servidor. O assistente grava `servidor`, o alias do `data/ssh/config` |
| `SSH_CONFIG` | *(vazio)* | dentro de `data/` | Configuração SSH própria (`ssh -F`). Vazio = usa o `~/.ssh/config` (V1). O assistente grava `data/ssh/config` |
| `SSH_ACESSO` | `direto` | `restrito` ou `direto` | `restrito`: a chave só roda a coleta e o painel envia só o modo. `direto`: o painel envia o script inteiro (V1). O assistente grava `restrito` |
| `POLL_INTERVAL` | `60000` | `10000`–`3600000` | Intervalo entre coletas, em ms |
| `PORT` | `3000` | `1`–`65535` | Porta do painel (só em 127.0.0.1) |
| `HISTORY_LIMIT` | `4320` | `100`–`100000` | Amostras brutas em memória (4320 = 72 h a 1 por minuto) |
| `HISTORY_FILE` | `data/history.json` | dentro de `data/` | Histórico da V1 a migrar (1 vez, com backup) |
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

Mudar alvos (pastas, discos, serviços) à mão quebra a chave restrita: o script no
`authorized_keys` deixa de bater (`hashMismatch`). Use `./dashboard reconfigurar`.

## Comando SSH de coleta

O script é montado por `server/collector/builder.js`. É um único script POSIX `sh`,
somente leitura. Exemplo com `NET_IF=enpXsY`, `DISK_MOUNTS=/ /mnt/disco1`,
`DISK_DEVS=sda sdb` e `SERVICES=smbd nmbd`, no modo `smart`:

```sh
LC_ALL=C; export LC_ALL; M="${SSH_ORIGINAL_COMMAND:-smart}"; case "$M" in smart) ;; *) M=basico;; esac;
echo '===VER==='; echo '2 6443f6bd222e'; echo "$M";
echo '===HOST==='; cat /proc/sys/kernel/hostname;
echo '===OS==='; uname -r; grep -E '^(PRETTY_NAME|NAME)=' /etc/os-release 2>/dev/null;
echo '===CPU==='; getconf _NPROCESSORS_ONLN 2>/dev/null;
echo '===UPTIME==='; cat /proc/uptime;
echo '===LOAD==='; cat /proc/loadavg;
echo '===STAT==='; head -1 /proc/stat;
echo '===MEM==='; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree|Dirty|Writeback):' /proc/meminfo;
echo '===DF==='; df -B1 --output=source,target,size,used,avail,pcent,ipcent / /mnt/disco1 2>/dev/null;
echo '===NET==='; awk -F: -v i='enpXsY' '{n=$1; gsub(/[ \t]/,"",n)} n==i' /proc/net/dev;
echo '===IO==='; awk '$3=="sda"||$3=="sdb"' /proc/diskstats;
echo '===PSI==='; for f in cpu memory io; do printf '%s ' "$f"; grep -h . /proc/pressure/$f 2>/dev/null | tr '\n' ' '; echo; done;
echo '===TEMP==='; for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && printf '%s %s\n' "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"; done 2>/dev/null; true;
echo '===SMART==='; case "$M" in smart) for d in sda sdb; do
  if [ "$(id -u)" = 0 ]; then r=$(smartctl -H "/dev/$d" 2>&1); else r=$(sudo -n smartctl -H "/dev/$d" 2>&1); fi;
  case "$r" in *"result: PASSED"*|*"Health Status: OK"*) s=PASSED;; *"result: FAILED"*|*"Health Status: FAIL"*) s=FAILED;;
  *"smartctl: not found"*|*"smartctl: command not found"*) s=SEM_SMARTCTL;;
  *"sudo:"*|*ermission*|*"Operation not permitted"*) s=SEM_PERMISSAO;; *) s=DESCONHECIDO;; esac;
  printf '%s %s\n' "$d" "$s"; done;; *) echo pulado;; esac;
echo '===SERVICES==='; for s in smbd nmbd; do printf '%s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)"; done;
echo '===PS==='; ps -eo user:32,pid,pcpu,pmem,rss,etimes,args --sort=-rss 2>/dev/null | head -9;
echo '===FIM==='
```

- `LC_ALL=C` no início. As métricas vêm de `/proc` e `/sys`, imunes ao idioma.
- `ssh -o BatchMode=yes -o ConnectTimeout=10`: falha rápido se o servidor estiver fora.
- `NET`, `IO`, `SMART` e `SERVICES` só entram quando configurados. `===FIM===` marca a
  saída completa (`collector.complete`).
- `===VER===` traz a versão do coletor e um hash de 12 hex dos alvos. Hash diferente do
  esperado indica `authorized_keys` desatualizado (`hashMismatch`).
- **Modo** `basico` ou `smart`. O SMART roda **1 vez por hora**; nas outras coletas a
  seção imprime `pulado` e o último resultado é reaproveitado.
- **Comando forçado** (ADR 0008): o script vai para o `authorized_keys` do `dashmon` e o
  painel envia só a palavra do modo. Ela chega em `$SSH_ORIGINAL_COMMAND` e só passa pelo
  `case` da 1ª linha; nunca é executada nem ecoada. Exemplo das linhas no servidor:

  ```
  restrict,from="192.0.2.20",command="<script acima>" ssh-ed25519 AAAA… server-dashboard
  dashmon ALL=(root) NOPASSWD: /usr/sbin/smartctl -H /dev/sda, /usr/sbin/smartctl -H /dev/sdb
  ```

- SMART: root roda `smartctl -H` direto; outro usuário usa `sudo -n` (nunca pede senha).
  Estados: `PASSED`, `FAILED`, `SEM_PERMISSAO`, `SEM_SMARTCTL`, `DESCONHECIDO`.
- Temperatura: todas as `thermal_zone*`. Prioridade: `x86_pkg_temp` > `coretemp` >
  `k10temp` > `cpu-thermal`/`cpu_thermal`/`soc_thermal` > `acpitz` > maior valor.
- Falhas do SSH viram mensagens claras (`describeError()`): timeout, identidade do
  servidor, exit 255, resposta grande demais.

## Formato da amostra

`schemaVersion: 2`, gerada por `server/collector/parser.js`. Dado ausente é `null`, nunca
zero inventado. Taxas (`cpu`, `rxMbps`, `readMBps`, `utilPct`…) são `null` na 1ª coleta,
depois de um reboot ou com contador que voltou. Exemplo (listas encurtadas):

```json
{
  "schemaVersion": 2,
  "ts": "2026-10-07T13:51:00.000Z",
  "collector": { "version": 2, "hash": "73cebb436c7c", "mode": "smart", "complete": true,
                 "expectedVersion": 2, "durationMs": 901, "outputBytes": 6350 },
  "host": "servidor-exemplo",
  "os": { "kernel": "6.12.111+deb13-amd64", "name": "Debian GNU/Linux 13 (trixie)" },
  "cores": 1,
  "uptimeSec": 12937.03,
  "bootAt": "2026-10-07T10:15:22.970Z",
  "load": [0.08, 0.02, 0.01],
  "cpuTicks": { "user": 102345, "nice": 120, "system": 45678, "idle": 1234567,
                "iowait": 8901, "irq": 0, "softirq": 1234, "steal": 0, "total": 1392845 },
  "cpu": { "pct": 3.2, "user": 2.1, "system": 0.9, "iowait": 0.2, "steal": 0 },
  "ram": { "total": 840, "used": 406, "free": 120, "cache": 479, "avail": 434,
           "swapTotal": 885, "swapUsed": 24, "dirty": 0, "writeback": 0 },
  "disks": [
    { "mount": "/", "source": "/dev/sda2", "dev": "sda", "size": "145G", "used": "2.5G",
      "avail": "135G", "pct": 2, "sizeBytes": 155475050496, "usedBytes": 2626056192,
      "availBytes": 144876724224, "inodesPct": 3 }
  ],
  "missingMounts": [],
  "net": { "iface": "enp0s7", "rxBytes": 1752505, "rxErrors": 0, "rxDrops": 0,
           "txBytes": 771648, "txErrors": 0, "txDrops": 0, "rxMbps": 0.02, "txMbps": 0.01 },
  "io": [ { "dev": "sda", "readIos": 15783, "sectorsRead": 1156426, "readTicksMs": 136971,
            "writeIos": 3699, "sectorsWrite": 118552, "writeTicksMs": 19880,
            "ioTicksMs": 91540, "readMBps": 0.0, "writeMBps": 0.01, "utilPct": 0.4,
            "latencyMs": 6.1 } ],
  "psi": null,
  "temps": [ { "type": "acpitz", "c": 32 } ],
  "tempC": 32,
  "tempSensor": "acpitz",
  "smart": [ { "dev": "sda", "status": "PASSED" } ],
  "smartAt": "2026-10-07T13:51:00.000Z",
  "services": { "smbd": "active" },
  "topProcs": [ { "user": "root", "pid": 990, "cpu": 0.0, "mem": 11.4, "rssKB": 98520,
                  "etimesSec": 12880, "cmd": "/usr/bin/dockerd -H fd://" } ]
}
```

Amostras da V1 (sem `schemaVersion` e sem os campos novos) continuam válidas: o frontend
trata campos ausentes.

## Persistência

Tudo fica no disco local. Nada é gravado no servidor.

| Caminho | O que guarda |
|---|---|
| `data/history/AAAA-MM-DD.ndjson` | Amostras brutas, 1 linha por coleta, só acréscimo (fila assíncrona), 1 arquivo por dia (UTC). Retenção de 72 h; linha cortada por queda é ignorada. ~3,7 KB por coleta (~16 MB em 72 h) |
| `data/rollup/AAAA-MM-DD.ndjson` | Agregados de 5 min `{ t, n, m: { métrica: [mín, máx, média] } }` por 90 dias. Fechar de novo não duplica; o boot fecha os pendentes. ~1,2 KB a cada 5 min (~29 MB em 90 dias) |
| `data/alerts.json` | Alertas com ciclo de vida `new` → `ack` → `resolved` (até 500) |
| `data/annotations.json` | Anotações (texto, rótulo, instante) |
| `data/outages.ndjson` | Quedas do servidor (`off`/`on`), 90 dias, separadas dos alertas (B9) |
| `data/history.v1-migrado.json` | Backup do histórico da V1, feito pela migração (pode ser apagado) |
| `data/sessions.json` | SHA-256 das sessões do navegador |
| `data/entrar.json` | Hash do link de entrada de uso único (2 min) |
| `data/ssh/` | `config` e `known_hosts` próprios do painel (0700) |
| `data/dashboard.log` | Log (gira em 5 MB para `dashboard.log.1`) |
| `data/dashboard.pid`, `data/dashboard-erros.log` | Modo segundo plano (sem systemd): PID e erros de inicialização |
| `.runtime/node/` | Node 24 baixado pelo `./dashboard`, se o do sistema faltar |
| `.backups/` | Cópias de `data/` feitas pelo `atualizar` (as 3 mais novas, 0700) |

Fora da pasta do projeto: a chave `~/.ssh/dashboard_ed25519` (ou `dashboard_v2_ed25519`,
se a outra já existir com outro uso), o serviço
`~/.config/systemd/user/server-dashboard.service` e o atalho
`~/.local/share/applications/server-dashboard.desktop`.

Ao encerrar (SIGINT/SIGTERM), o painel espera gravar histórico, alertas e anotações
pendentes (B11).

## API

Todas as rotas passam por: Host check, CSRF (com cookie `dash_csrf`), cabeçalhos de
segurança, rate limit das mutações e error handler sem stack trace. Com `DASH_TOKEN`,
`/api/*` e `/api/stream` exigem sessão ou `Bearer <token>` (menos `/api/session`,
`/api/login` e `/api/logout`).

| Rota | Método | Descrição |
|---|---|---|
| `/` | GET | As 8 telas (rota por hash com período: `#/rede?p=24h`) |
| `/entrar` | GET | `?codigo=` → link de uso único do `./dashboard abrir`: cria a sessão e redireciona |
| `/api/session` | GET | `{authRequired, authenticated, expiresAt}` (sem exigir login) |
| `/api/login` | POST | `{token, remember?}` → cookie de sessão (30 dias; `remember: false` = só até fechar o navegador). 401 se errado; 10 tentativas/min/IP |
| `/api/logout` | POST | Encerra a sessão deste navegador |
| `/api/logout-all` | POST | Encerra todas as sessões (exige estar logado) |
| `/api/status` | GET | Última amostra + meta (online, lastPollAt, nextPollAt, offlineSince) + saúde + alertas ativos |
| `/api/history` | GET | `?limit=N&from=&to=` → amostras (reduzidas a até 720, com o pior caso de cada grupo). `&formato=baldes` → `{from, to, step, buckets}` com mín/máx/média, até 90 dias |
| `/api/config` | GET | Configuração ativa para a Ajuda: versões, alvos, modo de acesso, limiares (sem segredos) |
| `/api/outages` | GET | `?days=1..90` (padrão 30) → `{days, outages, uptime}` |
| `/api/alerts` | GET | `?status=&level=&limit=` → `{active, all}` |
| `/api/alerts/:id/ack` | POST | Reconhece o alerta |
| `/api/alerts/:id/resolve` | POST | Resolve o alerta |
| `/api/annotations` | GET / POST | Lista / cria anotação (`{ts, text, label}`) |
| `/api/annotations/:id` | DELETE | Remove a anotação |
| `/api/export` | GET | `?format=csv\|json&from=&to=` → download do relatório |
| `/api/stream` | GET | SSE: `hello`, `sample` (`id` = instante), `alerts`, `annotations`, `status`. `Last-Event-ID` recupera até 2000 amostras |
| `/api/poll` | POST | Coleta agora (piso de 5 s entre coletas manuais) |

Durante a instalação, o assistente (`server/setup/web.js`) roda num servidor temporário,
na mesma porta e com as mesmas proteções: `/configurar` (a página) e `/api/configurar/*`
(os passos). Ele só abre com o código de uso único mostrado no terminal (30 min, 20
tentativas).

## Alertas

Motor em `server/alerts/` (ADR 0006).

| Condição | Chave estável | Nível | Limiar |
|---|---|---|---|
| Disco usado ≥ limiar | `disk:<mount>:usage` | warning | `ALERT_DISK_PCT` |
| RAM usada ≥ limiar | `ram:usage` | warning | `ALERT_RAM_PCT` |
| Temperatura da CPU ≥ limiar | `temp:cpu` | warning | `ALERT_TEMP_C` |
| SMART `FAILED` (sem permissão ou sem smartctl é neutro) | `smart:<dev>` | critical | — |
| Serviço fora de `active`/`reloading`/`activating` (sem resposta é neutro) | `service:<nome>` | critical | — |
| Servidor inacessível depois de N falhas seguidas | `servidor-inacessivel` | critical | `ALERT_OFFLINE_AFTER` |

- **Chave estável**: a condição que continua atualiza o MESMO alerta (B3).
- **Histerese**: dispara no limiar e só limpa quando o valor cai `ALERT_HYSTERESIS` abaixo
  (disco e RAM em pontos de %, temperatura em °C).
- **Debounce do offline**: 1 falha isolada não alerta. A queda começa no instante da 1ª
  falha. Durante a queda, os outros alertas ficam como estão (nada foi medido).
- **Dado ausente** não cria nem resolve alerta.
- **Saúde 0–100** (`server/alerts/health.js`): começa em 100 e perde pontos por problema,
  com os mesmos limiares. 80–100 saudável, 50–79 atenção, 0–49 crítico. A tela só mostra o
  que vem em `/api/status` (`health`).

## Estrutura

```
linux-server-dashboard-v2/
├── AGENTS.md · README.md · TUTORIAL.md · SECURITY.md · CHANGELOG.md · LICENSE (MIT)
├── dashboard               comando único: garante o Node 24 (scripts/node-runtime.sh) e chama server/cli/
├── package.json            sem dependências de runtime; devDependency: playwright-core (e2e)
├── .env.example            modelo do .env (sem valores reais)
├── docs/                   PLANO_V2.md, adr/ e allowed_signers (chaves das releases)
├── scripts/                check.mjs, capturar-amostra.mjs, node-runtime.sh, askpass.sh, e2e-instalacao/
├── server/
│   ├── index.js            rotas, loop de coleta, export
│   ├── config.js           parser único do .env, faixas, sanitizeToken/sanitizeHost
│   ├── security.js         Host check, CSRF, cabeçalhos, token timing-safe, rate limit
│   ├── poller.js           fachada do coletor + alertas (CLI --once)
│   ├── csv.js · stores.js · logfile.js · version.js
│   ├── cli/                subcomandos do ./dashboard (index, servico, instalar, diagnosticar,
│   │                       atualizar, desinstalar, importar-v1, saida)
│   ├── setup/              instalação: acesso, deteccao, preparo, remoto, local, assinatura,
│   │                       instalacao, web (assistente), tui, sem-interface
│   ├── http/               router, static, session, sse, entrar (link de uso único)
│   ├── collector/          builder (script), parser (amostra v2), rates (taxas), index (1 SSH)
│   ├── storage/            ndjson (72 h), rollup (5 min/90 d), buckets, migrate-v1, outages, index
│   └── alerts/             rules, health, engine
├── public/
│   ├── index.html          casca das 8 telas, login e avisos
│   ├── configurar.html     assistente de instalação (js/configurar/, css/configurar.css)
│   ├── css/                tokens.css (escuro/claro), base, components, views, print
│   ├── fonts/              Geist + Geist Mono 1.7.2 (OFL, SHA-256 em vendor/vendor.json)
│   ├── vendor/             uPlot 1.6.32 (SHA-256 em vendor.json)
│   └── js/                 main.js, locale-guard.js, core/, charts/, views/ (as 8 telas)
├── test/                   unit/, integration/, e2e/ e fixtures/ (node --test)
└── test-support/           request.js (HTTP/SSE), sshd.js (sshd real), instalacao-fake.js
```

## Solução de problemas (para quem desenvolve)

- **Primeiro passo:** `./dashboard diagnosticar`. Ele explica o problema e diz como
  resolver.
- **Servidor fora:** a faixa do topo fica vermelha, o histórico é preservado e a coleta
  tenta de novo no próximo intervalo. Confira com `ping 192.0.2.10`.
- **Coleta lenta ou parada:** veja `data/dashboard.log` e
  `journalctl --user -u server-dashboard`. A faixa de status mostra o tempo e o tamanho de
  cada coleta.
- **Histórico vazio:** confira `data/history/` (arquivo `.ndjson` de hoje) e as permissões
  de `data/`. Veio da V1? `npm run migrar-v1 -- --verificar`.
- **Chave recusada, identidade do servidor mudou ou disco novo:** `./dashboard reconfigurar`.
- **403 "Host não permitido":** abra por `http://127.0.0.1:3000` ou `http://localhost:3000`.
