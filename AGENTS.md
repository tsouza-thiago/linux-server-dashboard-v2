# LINUX-SERVER-DASHBOARD — Monitoramento de servidor Linux

Dashboard de monitoramento ativo em tempo real de um servidor Linux
rodando na rede local. Toda a carga de coleta fica na máquina local; o servidor apenas
responde **1 comando SSH por minuto** — requisito obrigatório (hardware muito limitado).

## Regras (obrigatórias)

- Conectar sempre via alias SSH (ex.: `ssh meu-servidor`, definido em `~/.ssh/config` →
  `usuario@192.0.2.10:22`, chave Ed25519 `~/.ssh/sua_chave`)
- **NUNCA** exibir, imprimir ou commitar o conteúdo de `.env` (o `.env` do servidor contém
  senhas). Este projeto não precisa de senha: autenticação é por chave SSH
- Apenas comandos não-interativos: `ssh meu-servidor '<comando>'`
- **1 único SSH por poll** com comando combinado (sem paralelismo contra o servidor)
- Servidor modesto (1 núcleo, pouca RAM): nunca executar compilações, instalar pacotes ou
  scripts pesados **no servidor**. Monitoramento é somente leitura
- Discos **SMR**: evitar escrita intensa/aleatória no servidor
- Dados dinâmicos (temperatura, espaço, status) sempre coletados ao vivo, nunca presumidos
- Dashboard bind em `127.0.0.1` (somente máquina local)
- O servidor NÃO instala nada — zero dependências remotas

### Regras de segurança (security by design)

- **Config centralizado** em `server/config.js`: parser único do `.env` (com override de
  `process.env`), validação de intervalos (`POLL_INTERVAL >= 10000`, `PORT` 1–65535,
  `HISTORY_LIMIT` 100–100000) e caminhos de dados forcados para dentro de `data/`
- **Sanitização anti-injeção**: `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS` e `SERVICES` passam
  por `sanitizeToken()` (whitelist `[A-Za-z0-9_./:-]`, rejeita tokens iniciando com `-`)
  **antes** de entrar no comando SSH (`server/poller.js`)
- **Host check**: `server/security.js` rejeita (403) qualquer request cujo `Host` não seja
  `localhost`/`127.0.0.1`/`[::1]` — bloqueia DNS rebinding
- **CSRF**: POST/PUT/PATCH/DELETE rejeitam `Origin` ≠ Host validado e `Sec-Fetch-Site: cross-site`
- **Headers**: `X-Powered-By` desligado; CSP restritivo, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`
- **Anti-XSS** (ADR 0010): a tela monta HTML só pelo template `html` de
  `public/js/core/html.js`, que escapa toda interpolação; HTML cru só via `raw()` explícito.
  CSP sem `'unsafe-inline'` nem `'unsafe-eval'` (scripts e estilos só de `'self'`)
- **Export seguro**: `server/csv.js` previne formula-injection (`=+-@` → prefixo `'`) e
  saneia o nome do arquivo
- **Permissões**: `data/` (0700), `.env` e arquivos de dados (0600) — reforçadas em
  `install.sh`/`start.sh` e na escrita (`writeFileSync { mode: 0o600 }`)
- **Token por padrão + sessão por cookie** (ADR 0007): o `install.sh` gera um `DASH_TOKEN`
  automático se vazio; com ele, `/api/*` e `/api/stream` exigem sessão (cookie
  `dash_session`, HttpOnly + SameSite=Strict, 30 dias renovados com o uso) ou
  `Authorization: Bearer <token>` (scripts). O token é trocado 1x na tela de login
  (`/api/login`, 10 tentativas/min/IP); em disco (`data/sessions.json`, 0600) fica só o
  SHA-256 da sessão. `?token=` na URL **não** é aceito. Comparação com `crypto.timingSafeEqual`
- **Throttle**: `/api/poll` com piso de 5s entre coletas manuais; rate limit de
  mutações da API (120/min/IP)
- **CSRF em 2 camadas**: rejeita `Origin` ≠ Host e `Sec-Fetch-Site: cross-site`; além
  disso, mutações com `Origin` presente precisam carregar o cookie `dash_csrf`
  (SameSite=Lax, HttpOnly) emitido nos GETs
- **Erros sem vazamento**: error handler central devolve JSON sem stack trace
- **HTTP próprio** (ADR 0003): `node:http` + `server/http/` (roteador, corpo JSON ≤ 50 KB,
  estáticos só de `public/` com lista de tipos, sem oculto/pasta/traversal); cabeçalhos de
  segurança valem em **todas** as respostas, inclusive 401/403/404; backend sem
  dependência de runtime. `test/integration/http-seguranca.test.js` é a caracterização
  caixa-preta e precisa continuar verde
- **SSE**: no máximo 20 conexões simultâneas (503 acima); reconexão com `Last-Event-ID`
  recupera até 2000 amostras perdidas
- **SSH seguro**: `BatchMode=yes` + `ConnectTimeout=10`; `SSH_HOST` saneado via
  `sanitizeHost()` — apenas rejeita `-` inicial e vazio (whitelist de caracteres é
  exclusiva do `sanitizeToken`, acima); alias do instalador usa
  `StrictHostKeyChecking accept-new` (nunca `no`/`/dev/null`)
- **Instalador valida no shell**: `install-lib.sh` (funções puras, sourceada pelo
  `install.sh`) valida `user`/`host`/`alias`/`porta` antes de tocar em `~/.ssh/config`
  e `.env` — whitelist `[A-Za-z0-9._-]`, rejeita `-` inicial, espaço, `/` e quebra de
  linha (bloqueia injeção de diretiva); `ssh-copy-id` roda com `ConnectTimeout=10` e
  mostra a saída real em caso de falha

## Desenvolvimento da V2 (obrigatório)

A V2 está sendo construída neste repositório a partir da `v1.0.0`, seguindo o plano aprovado.

- **Plano e decisões:** `docs/PLANO_V2.md` (fases F0–F9, invariantes I1–I10, bugs B1–B12) e
  `docs/adr/` (uma ADR por decisão; ADR aceita não é editada, é substituída por outra).
- **Invariantes:** as regras acima continuam valendo integralmente; o plano (seção 1) diz como
  cada uma é garantida por teste.
- **Antes de todo commit:** `npm run check` (sintaxe JS/shell, `.env`/`data/` fora do git,
  testes + cobertura, `npm audit`). Nenhum commit vermelho.
- **Commits:** Conventional Commits em PT-BR (`feat(escopo):`, `fix:`, `test:`, `docs:`,
  `refactor:`, `style:`, `perf:`, `chore:`, `security:`), uma mudança lógica por commit.
- **CHANGELOG.md** atualizado no mesmo commit da mudança (Keep a Changelog).
- **Bugs conhecidos** ficam em `test/unit/bugs-v1.test.js` como `todo`; o commit que corrige
  remove o `todo` (o teste vira regressão).
- **Versões:** SemVer; uma pré-versão `2.0.0-alpha.N` por fase, com tag e release.
- **Node.js 24** é a versão-alvo (ADR 0002).
- **Exemplos** usam só IPs de documentação (`192.0.2.x`, RFC 5737) e nomes genéricos.

## Arquitetura

```
[Servidor Debian 13]  ← 1 SSH/min (comando único, LC_ALL=C, não-interativo)
        ↑
[Node.js local]  ── poller (intervalo 60s) → parse → histórico NDJSON (72h brutas + 90d agregados)
        ↓
[node:http local 127.0.0.1:3000] ── dashboard + /api/status + /api/history + /api/alerts +
                                   /api/annotations + /api/export + SSE
        ↓
[Browser: http://localhost:3000]  — 8 telas (ES modules, uPlot), manchete de saúde, eventos,
                                   relatórios, exportação CSV/JSON; zero dependências
```

> **Interatividade é 100% client-side** (filtros, ordenação, zoom, ETA, agregações). O
> backend só persiste alertas/anotações e serve histórico — o limite de 1 SSH/min continua.

## Comandos

```bash
./install.sh                    # assistente 1-comando: deps, .env+token, chave SSH, systemd
./install.sh --auto             # não-interativo: deps + .env + token (sem assistente SSH)
./install.sh --manual           # só deps + .env (SSH já configurado)
./install.sh --configure        # só o assistente SSH (trocar servidor)
./install.sh --test             # roda a suíte de testes
./install.sh --install-service  # cria/ativa serviço systemd de usuário
./install.sh --uninstall-service
./start.sh                      # inicia em primeiro plano
./start.sh --background         # inicia em segundo plano (PID em data/dashboard.pid)
./start.sh --status             # mostra se está rodando em segundo plano
./stop.sh                       # para com segurança (PID file → pgrep → lsof)
npm start                       # equivalente ao ./start.sh
npm test                        # suíte de testes (node --test, sem deps novas)
npm run check                   # verificação completa — obrigatória antes de cada commit
npm run test:unit               # só testes unitários (test/unit)
npm run test:integration        # só integração (test/integration: HTTP, shell, ssh falso)
npm run test:e2e                # ponta a ponta no Chromium (playwright-core; pula sem navegador)
npm run capturar-amostra        # 1 coleta real → data/amostra-{bruta,anonima}.txt (fixtures)
npm run migrar-v1 -- --verificar  # resume o data/history.json da V1 sem gravar nada
npm run migrar-v1               # migra a V1 agora (o painel também migra sozinho ao iniciar)
node server/poller.js --once    # teste rápido do poller sem o servidor web
```

## Quickstart

```bash
./install.sh     # config deps + .env + SSH (assistente)
./start.sh       # lê .env, carrega histórico, primeiro poll imediato, depois a cada 60s
```

- Logs em `data/dashboard.log` (também no console); modo `--background` usa `data/nohup.log`.
- Sistema de serviço (roda sempre): `./install.sh --install-service`.

## Configuração (variáveis de ambiente em `.env`)

| Variável        | Padrão    | Descrição                                        |
|-----------------|-----------|--------------------------------------------------|
| `SSH_HOST`      | `seu-host` | Alias SSH (do `~/.ssh/config`) ou `user@ip`   |
| `POLL_INTERVAL` | `60000`   | Intervalo de coleta em ms (mínimo 10000)         |
| `PORT`          | `3000`    | Porta do dashboard local                         |
| `HISTORY_LIMIT` | `4320`    | Amostras retidas (3 dias a 1/min; 4320 = 72h)    |
| `HISTORY_FILE`  | `data/history.json` | Histórico da **V1** a migrar (1 vez, com backup); a pasta dele é a pasta de dados |
| `LOG_FILE`      | `data/dashboard.log` | Arquivo de log (dentro de `data/`)        |
| `NET_IF`        | *(vazio)* | Interface de rede a monitorar (vazio = seção Rede omitida) |
| `DISK_MOUNTS`   | `/`       | Mount points monitorados, separados por espaço    |
| `DISK_DEVS`     | *(vazio)* | Dispositivos de bloco p/ IO/SMART (vazio = omitido) |
| `SERVICES`      | *(vazio)* | Serviços systemd monitorados, separados por espaço |
| `DASH_TOKEN`    | *(gerado no install)* | Token da API/SSE (`Bearer <token>`); instalador gera automático |
| `ALERT_DISK_PCT` | `90` | Alerta de disco (% usado, 50–99) |
| `ALERT_RAM_PCT` | `90` | Alerta de RAM (% usada, 50–99) |
| `ALERT_TEMP_C` | `60` | Alerta de temperatura da CPU (°C, 30–110) |
| `ALERT_HYSTERESIS` | `5` | Quanto o valor precisa cair abaixo do limiar para o alerta limpar (0–20) |
| `ALERT_OFFLINE_AFTER` | `2` | Falhas seguidas antes de "servidor inacessível" (1–10) |

> Todos os valores de `NET_IF`/`DISK_MOUNTS`/`DISK_DEVS`/`SERVICES` passam por
> `sanitizeToken()` (whitelist de caracteres) antes de entrarem no comando SSH;
> `SSH_HOST` passa por `sanitizeHost()`, que apenas rejeita `-` inicial e vazio.

## Comando SSH de coleta (1 por poll)

> O comando é montado por `server/collector/builder.js` a partir das variáveis acima: é um
> único script POSIX sh, somente leitura. Exemplo com `NET_IF=enpXsY`,
> `DISK_MOUNTS=/ /mnt/disco1`, `DISK_DEVS=sda sdb`, `SERVICES=smbd nmbd` (modo `smart`):

```sh
LC_ALL=C; export LC_ALL; M="${SSH_ORIGINAL_COMMAND:-smart}";
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
echo '===SMART==='; case "$M" in smart) for d in sda sdb; do <smartctl -H como root ou sudo -n>; <classifica>; printf '%s %s\n' "$d" "$s"; done;; *) echo pulado;; esac;
echo '===SERVICES==='; for s in smbd nmbd; do printf '%s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)"; done;
echo '===PS==='; ps -eo user:32,pid,pcpu,pmem,rss,etimes,args --sort=-rss 2>/dev/null | head -9;
echo '===FIM==='
```

- `LC_ALL=C` no início do script; as métricas vêm de `/proc` e `/sys` (imunes a locale)
- `ssh -o BatchMode=yes -o ConnectTimeout=10` — falha rápido se o servidor estiver off
- Seções `NET`/`IO`/`SMART`/`SERVICES` só entram quando configuradas; `===FIM===` indica
  saída completa (`collector.complete`)
- `===VER===` traz a versão do coletor e um hash de 12 hex da configuração: hash
  divergente sinaliza `authorized_keys` desatualizado (`hashMismatch`)
- **Modo**: `basico` (padrão) ou `smart`. O SMART roda **1x por hora**; nos demais polls a
  seção imprime `pulado` e o último resultado é reaproveitado. No comando forçado
  (`authorized_keys`, ADR 0008) o cliente envia só a palavra do modo, que chega como
  `$SSH_ORIGINAL_COMMAND` e é usada apenas num `case`, nunca executada
- SMART: root roda `smartctl -H` direto; usuário comum usa `sudo -n` (nunca pede senha).
  Estados: `PASSED`, `FAILED`, `SEM_PERMISSAO`, `SEM_SMARTCTL`, `DESCONHECIDO`
- Temperatura: todas as `thermal_zone*`; prioridade `x86_pkg_temp` > `coretemp` > `k10temp`
  > `cpu-thermal`/`cpu_thermal`/`soc_thermal` > `acpitz` > maior valor
- Falhas SSH viram mensagens amigáveis via `describeError()` (timeout, host key, exit 255)

## Formato da amostra (1 por poll)

> `schemaVersion: 2`, gerada por `server/collector/parser.js`. Dado ausente é `null`,
> nunca zero inventado (I5). Taxas (`cpu`, `rxMbps`, `readMBps`, `utilPct`...) são `null`
> no primeiro poll, após reboot ou com contador regredindo. Exemplo (listas encurtadas):

```json
{
  "schemaVersion": 2,
  "ts": "2026-10-07T13:51:00.000Z",
  "collector": { "version": 2, "hash": "73cebb436c7c", "mode": "smart", "complete": true,
                 "expectedVersion": 2 },
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

> Amostras V1 (sem `schemaVersion` e sem os campos novos) continuam válidas — o frontend
> trata campos ausentes.

## Persistência (data/)

- **`history/AAAA-MM-DD.ndjson`** — amostras brutas, 1 linha por poll, **append-only** em fila
  assíncrona (não bloqueia o poll), 1 arquivo por dia (UTC), 0600 (pasta 0700)
  - Retenção: 72 h contadas da amostra mais recente (e no máximo `HISTORY_LIMIT` em memória);
    dias fora da janela são apagados. Linha cortada por queda é ignorada na leitura
  - ~3,7 KB por poll (~16 MB nas 72 h) — antes a V1 reescrevia o histórico inteiro (B7)
- **`rollup/AAAA-MM-DD.ndjson`** — agregados de 5 min `{ t, n, m: { métrica: [mín, máx, média] } }`
  por 90 dias, calculados das brutas; fechar de novo não duplica e o boot fecha os pendentes
  - ~1,2 KB a cada 5 min (~29 MB em 90 dias com 4 mounts e 3 discos)
- **`history.v1-migrado.json`** — backup do `history.json` da V1, criado pela migração
  automática no 1º boot (idempotente; arquivo ilegível fica intacto). Pode ser apagado
- **`alerts.json`** — histórico de alertas com ciclo de vida: `new` → `ack` → `resolved`
  - Auto-resolve: quando a condição deixa de existir no poll seguinte, o alerta é resolvido
  - Reconhecer/resolver também via UI (painel de alertas); retenção máx 500
  - Cada condição tem **chave estável** (ver Alertas): valor novo atualiza o mesmo alerta;
    só regrava o arquivo em mudança de estado (valor novo: no máximo a cada 10 min)
- **`annotations.json`** — anotações do usuário na linha do tempo (texto + rótulo + timestamp)
- **`outages.ndjson`** — quedas do servidor (`off`/`on`, 2 linhas por queda, 90 dias), separadas
  dos alertas: o limite de 500 alertas não apaga mais o histórico de quedas (B9)
- Encerramento (SIGINT/SIGTERM) espera gravar histórico, alertas e anotações pendentes (B11)
- Tudo no SSD local; nada é gravado no servidor

## API

| Endpoint          | Método | Descrição                                             |
|-------------------|--------|-------------------------------------------------------|
| `/`               | GET    | Dashboard web (8 telas, rota por hash com período: `#/rede?p=24h`) |
| `/api/config`     | GET    | Configuração ativa para a Ajuda (versões, alvos, limiares) — sem segredos |
| `/api/status`     | GET    | Última amostra + meta (online, lastPollAt, nextPollAt, offlineSince) + alertas ativos |
| `/api/history`    | GET    | `?limit=N&from=&to=` → amostras no range (redução p/ máx 720 com pior caso por grupo) |
| `/api/history?formato=baldes` | GET | `&from=&to=&limit=` → `{from, to, step, buckets}` com mín/máx/média, até 90 dias (padrão 24 h) |
| `/api/alerts`     | GET    | `?status=&level=&limit=` → `{active, all}` com ciclo de vida |
| `/api/alerts/:id/ack`     | POST | Reconhece alerta                               |
| `/api/alerts/:id/resolve` | POST | Resolve alerta                                 |
| `/api/annotations`| GET/POST | Lista / cria anotações (`{ts, text, label}`)    |
| `/api/annotations/:id` | DELETE | Remove anotação                             |
| `/api/export`     | GET    | `?format=csv\|json&from=&to=` → download do relatório |
| `/api/stream`     | GET    | SSE: `hello`, `sample` (a cada poll, `id` = instante), `alerts`, `annotations`, `status`; `Last-Event-ID` → backfill |
| `/api/session`    | GET    | `{authRequired, authenticated}` (sem exigir login) |
| `/api/login`      | POST   | `{token}` → cookie de sessão; 401 se errado; 10 tentativas/min/IP |
| `/api/logout`     | POST   | Encerra a sessão deste navegador |
| `/api/logout-all` | POST   | Encerra todas as sessões (exige estar logado) |
| `/api/poll`       | POST   | Dispara coleta imediata ("coletar agora"), piso de 5s |
| `/api/outages`    | GET    | `?days=1..90` (padrão 30) → `{days, outages, uptime}`; uptime desde o início do monitoramento |

> Proteções aplicadas em todas as rotas: `Host` check, CSRF (c/ cookie `dash_csrf`),
> headers de segurança, rate limit de mutações, error handler sem stack trace.
> Com `DASH_TOKEN` (gerado no install): `/api/*` e `/api/stream` exigem sessão por cookie
> ou `Bearer <token>`, comparado com `crypto.timingSafeEqual`; `?token=` não vale.

## Alertas (motor em `server/alerts/`, ADR 0006)

| Condição | Chave estável | Nível | Limiar (`.env`) |
|---|---|---|---|
| Disco usado ≥ limiar | `disk:<mount>:usage` | warning | `ALERT_DISK_PCT` (90) |
| RAM usada ≥ limiar | `ram:usage` | warning | `ALERT_RAM_PCT` (90) |
| Temperatura CPU ≥ limiar | `temp:cpu` | warning | `ALERT_TEMP_C` (60) |
| SMART `FAILED` (sem permissão/sem smartctl é neutro) | `smart:<dev>` | critical | — |
| Serviço fora de `active`/`reloading`/`activating` (sem resposta é neutro) | `service:<nome>` | critical | — |
| Servidor inacessível após N falhas seguidas | `servidor-inacessivel` | critical | `ALERT_OFFLINE_AFTER` (2) |

- **Chave estável**: a condição que persiste atualiza mensagem e valor do MESMO alerta (B3)
- **Histerese**: dispara no limiar e só limpa quando cai `ALERT_HYSTERESIS` (5) abaixo
  (disco/RAM em pontos de %, temperatura em °C) — sem flapping
- **Debounce do offline**: 1 falha isolada não alerta nem muda o status; a queda começa no
  instante da 1ª falha. Durante a queda os outros alertas ficam como estão (nada foi medido)
- **Dado ausente** não resolve nem cria alerta (estado desconhecido)
- **Saúde (0–100)** em `server/alerts/health.js`, com os mesmos limiares (fonte única);
  a UI só exibe o que vem em `/api/status` (`health`)
- Limiar fora da faixa volta ao padrão com aviso no log (`config.js`, `alertThresholds`)

## Estrutura

```
linux-server-dashboard/
├── AGENTS.md               ← este arquivo
├── TUTORIAL.md             ← guia completo de uso (instalação, iniciar/parar, dashboard)
├── README.md               ← visão geral, instalação, segurança, FAQ
├── SECURITY.md             ← política + threat model de segurança
├── LICENSE                 ← MIT
├── install.sh              ← assistente 1-comando (deps, .env+token, chave SSH, systemd, menus)
├── install-lib.sh          ← funções puras de validação do instalador (segurança)
├── start.sh                ← inicia o serviço (primeiro plano, --background ou --status)
├── stop.sh                 ← para o serviço com segurança (PID file + fallbacks)
├── package.json            (sem dependências; devDependency: playwright-core p/ e2e; type: module)
├── .env                    (config local — NUNCA commitar)
├── .env.example            (modelo sem valores)
├── .gitignore              (exclui .env, data/, node_modules/)
├── data/                   (history/ + rollup/ + alerts.json + annotations.json + logs — runtime)
├── server/
│   ├── index.js            (rotas da API, loop de poll, export CSV)
│   ├── http/               (router.js, static.js, session.js: login por cookie, sse.js: SSE com backfill)
│   ├── config.js           (parser único do .env, validações, sanitizeToken/sanitizeHost)
│   ├── security.js         (Host check, CSRF c/ cookie, headers, token timing-safe, rate limit)
│   ├── csv.js              (export CSV com escape anti-fórmula)
│   ├── poller.js           (fachada do coletor + alertas; CLI --once)
│   ├── collector/          (builder.js: script; parser.js: amostra v2; rates.js: taxas; index.js: 1 SSH/poll)
│   ├── storage/            (ndjson.js: bruto 72 h; rollup.js: 5 min/90 d; buckets.js: agregação; migrate-v1.js; outages.js: quedas; index.js: History)
│   ├── alerts/             (rules.js: regras + chaves + histerese; health.js: saúde; engine.js: motor + debounce do offline)
│   └── stores.js           (JsonStore genérico: AlertsStore c/ ciclo de vida, AnnotationsStore)
├── CHANGELOG.md            ← histórico de mudanças (Keep a Changelog)
├── docs/                   (PLANO_V2.md + adr/ — plano e decisões da V2)
├── scripts/                (check.mjs, capturar-amostra.mjs)
├── test/                   (node --test: unit/, integration/ e e2e/ no Chromium)
├── test-support/           (helpers de teste: request HTTP e SSE)
└── public/
    ├── index.html          (casca: navegação das 8 telas, status, período, login, avisos)
    ├── style.css           (tokens claro/escuro + componentes; reorganizado em css/ na F6)
    ├── fonts/              (Inter + JetBrains Mono self-hosted, .woff2 — sem CDN)
    ├── vendor/             (uPlot 1.6.32 com SHA-256 em vendor.json — sem npm install)
    └── js/
        ├── main.js         (orquestração: estado, rotas, SSE, atalhos, login, avisos)
        ├── locale-guard.js (idioma inválido do navegador não derruba o uPlot)
        ├── core/           (html.js anti-XSS, format.js, router.js, store.js, api.js, sse.js, analysis.js)
        ├── charts/         (timeseries.js: uPlot com eixo de tempo real, zoom e cursor sincronizado)
        └── views/          (as 8 telas: render() monta, update() troca só os dados)
```

## Troubleshooting

- **Servidor off (offline):** banner de alerta, dot vermelho, histórico preservado,
  retry automático no próximo intervalo. Verificar: `ping 192.0.2.10`,
  `ssh seu-host 'uptime'`
- **Poll demorado/parado:** logs em `data/dashboard.log`; testar comando manual:
  `ssh seu-host 'LC_ALL=C free -m'`
- **Nenhum dado (histórico vazio):** confira `ls -la data/history/` (arquivos `.ndjson` de hoje) e
  as permissões de escrita na pasta `data/`; veio da V1? `npm run migrar-v1 -- --verificar`
- **Chave SSH quebrada:** `ssh seu-host 'echo ok'` deve responder `ok` sem pedir senha.
  Corrigir com `./install.sh --configure` ou `ssh-copy-id -i ~/.ssh/dashboard_ed25519.pub seu-host`
- **Host key não autorizada:** primeira conexão — `ssh seu-host 'echo ok'` + `yes`,
  ou rode `./install.sh` (aceita com `accept-new`)
- **403 "Host não permitido":** abra por `http://localhost:3000` ou `http://127.0.0.1:3000`
- Servidor não expõe nada novo — firewall/serviços do servidor permanecem intocados

## Segurança

- O dashboard bind em `127.0.0.1` e nunca deve ser exposto em rede aberta
- Nunca commite `.env` nem `data/` (contêm hostnames, IPs e telemetria da rede interna)
- Autenticação exclusivamente por chave SSH (nunca senha); rotacione a chave se o nome
  ou uso dela tiver vazado em qualquer repositório/histórico
- Monitore apenas o que for necessário: preencha `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS` e
  `SERVICES` com o mínimo necessário
- Respeite as proteções de `server/security.js` e `server/config.js` (Host check, CSRF,
  sanitização) ao alterar rotas ou configurações