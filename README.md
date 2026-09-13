# Linux Server Dashboard

**Monitoramento em tempo real do seu servidor Linux, direto do navegador — sem instalar
nada no servidor, sem senha, sem agente.**

Uma vez por minuto, este painel conecta no servidor por SSH (somente leitura), coleta
dezenas de métricas e as mostra em gráficos interativos. Feito para funcionar até em
hardware muito limitado (1 núcleo, pouca RAM) — por exemplo, uma máquina velha em casa.

> **Novo por aqui?** Comece pelo [**Tutorial passo a passo**](TUTORIAL.md) — um guia
> do zero, escrito para quem nunca usou a ferramenta: instalar, iniciar, parar e
> entender os números do painel, com comandos prontos para copiar e colar.

```
  ┌─────────────────────────────────────────────────────┐
  │        Linux Server Dashboard                       │
  │   CPU  RAM  Temp  Discos  Rede  SMART  Serviços     │
  │                                                     │
  │   ┌──────────┐  ┌──────────┐  ┌──────────┐         │
  │   │ Load     │  │ RAM      │  │ Temp CPU │         │
  │   │ 0.15     │  │ 900/2GB  │  │  29.0°C  │         │
  │   └──────────┘  └──────────┘  └──────────┘         │
  └─────────────────────────────────────────────────────┘
               ▲ gráficos em tempo real
               │
       [seu computador]
       Node.js + Express (127.0.0.1:3000)
               │
               │ 1 comando SSH por minuto (somente leitura)
               ▼
       ┌────────────────────┐
       │   Servidor Linux   │  ← nada é instalado nele
       └────────────────────┘
```

---

## Índice

**Guia rápido:** [Tutorial passo a passo](TUTORIAL.md) — para quem nunca usou a ferramenta.

1. [O que é? (para leigos)](#o-que-é-para-leigos)
2. [O que ele monitora](#o-que-ele-monitora)
3. [Como funciona por dentro](#como-funciona-por-dentro)
4. [Por que é eficiente](#por-que-é-eficiente)
5. [Funcionalidades do dashboard](#funcionalidades-do-dashboard)
6. [Pré-requisitos](#pré-requisitos)
7. [Instalação (fácil)](#instalação-fácil)
8. [Configuração](#configuração)
9. [Como usar](#como-usar)
10. [Rodar sempre em segundo plano (systemd)](#rodar-sempre-em-segundo-plano-systemd)
11. [Exemplo real do autor](#exemplo-real-do-autor)
12. [API](#api)
13. [Alertas](#alertas)
14. [Segurança](#segurança)
15. [Testes](#testes)
16. [Estrutura do projeto](#estrutura-do-projeto)
17. [Solução de problemas](#solução-de-problemas)
18. [FAQ](#faq)
19. [Licença](#licença)

---

## O que é? (para leigos)

Imagine que o seu servidor é uma casa e você quer saber o que acontece lá dentro sem
precisar entrar toda hora. Este programa é o "painel de controle" dessa casa: um
site que fica aberto no seu navegador e mostra, **a cada 60 segundos**, como o
servidor está passando:

- o **processador** está sobrecarregado ou tranquilo?
- a **memória** está perto de acabar?
- o **disco** está enchendo? Quando vai encher?
- está **quente** demais?
- os **serviços** importantes estão no ar?
- o **disco** está com sinais de falha?

Se algo estiver errado, o painel avisa — com alertas de cor amarela (atenção) ou
vermelha (urgente), e uma nota de saúde de 0 a 100 no canto da tela.

Tudo isso **sem instalar nada no servidor** e **sem precisar de senha**: a conversa
acontece por SSH, com chave criptográfica, e apenas **uma vez por minuto**.

---

## O que ele monitora

| Métrica | O que significa | Por que importa |
|---------|-----------------|-----------------|
| **Load (1/5/15)** | Carga do processador nas médias de 1, 5 e 15 min | Mostra se a CPU está saturada (neste projeto, 1 núcleo → 1,0 = 100%) |
| **Memória RAM / Swap** | Uso de memória e da "reserva" no disco | Swap subindo = falta RAM, sistema fica lento |
| **Temperatura CPU** | Calor do processador em °C | Acima de 60 °C é sinal de alerta (ventilação/poeira) |
| **Discos** | Espaço usado/livre por partição | Disco ≥ 90% = risco de lotação; o painel prevê o **ETA** (quando vai encher) |
| **SMART** | Autodiagnóstico de saúde dos discos | `PASSED` = saudável; diferente = risco de falha física (faça backup!) |
| **Rede** | Download/upload em **Mbps** | Tráfego em tempo real, detecta picos e vazamentos |
| **I/O dos discos** | Leitura/escrita em **MB/s** por disco | Identifica discos sobrecarregados |
| **Serviços** | smbd/nmbd (ou outros) ativos ou parados | Se caírem, os compartilhamentos de rede param |
| **Top processos** | Os que mais consomem memória | Acha o "vilão" quando a RAM sobe |
| **Uptime / boot** | Tempo ligado e hora do último boot | Contexto para interpretar as demais métricas |

---

## Como funciona por dentro

```
[Servidor Linux]  ← responde 1 comando SSH por minuto (LC_ALL=C, não-interativo)
      ↑
[poller.js]  coleta → parse → taxas de rede/I/O → alertas → amostra JSON
      ↑
[history.js]  histórico em memória (períodos de até 72h na UI) + persistência atômica em data/history.json
      ↑
[index.js]  Express (127.0.0.1:3000) → dashboard + API REST + SSE (tempo real)
      ↑
[Navegador]  sidebar multi-view, zoom nos gráficos, health score, alertas, anotações
```

O ciclo é simples e proposital:

1. **Coleta** — a cada 60 s o poller executa **um único comando SSH** no servidor, que
   lê dezenas de métricas do sistema (CPU, memória, discos, rede, temperatura, SMART,
   serviços, processos) e devolve tudo em uma resposta só.
2. **Parse** — a resposta é interpretada localmente e vira uma "amostra" JSON
   (uma linha = um minuto da vida do servidor).
3. **Persistência** — a amostra entra no histórico (3 dias, com escrita atômica).
4. **Entrega** — o Express serve o dashboard e atualiza os gráficos em tempo real via
   **SSE** (Server-Sent Events), sem o navegador precisar recarregar.

> **Toda a interatividade** (filtros, zoom, ordenação, ETA, agregações) acontece **no
> seu navegador**. O servidor continua respondendo apenas o seu 1 comando por minuto —
> nada mais.

---

## Por que é eficiente

- **Zero dependências no servidor** — nada é instalado, compilado ou configurado nele.
  O monitoramento é 100% leitura.
- **1 único SSH por minuto** — carga mínima, combinada em um só comando. Criado
  originalmente para um servidor de **1 núcleo e pouca RAM**.
- **Somente leitura** — o servidor não recebe comandos que alterem nada (sem agentes,
  sem scripts persistentes).
- **Sem senhas** — autenticação por **chave SSH** (Ed25519), nunca por senha.
- **Dashboard restrito ao seu computador** — bind em `127.0.0.1`; ninguém mais na rede
  consegue abrir o painel.
- **Histórico de 3 dias** — mesmo após reiniciar, os gráficos continuam de onde pararam
  (persistência em JSON com gravação atômica).
- **Tempo real sem carga extra** — atualizações por SSE; o navegador não fica
  recarregando a página.
- **Interatividade client-side** — zoom, pan, filtros e ordenação não incomodam o servidor.
- **Exportação** — relatórios CSV/JSON do período atual para abrir no Excel/LibreOffice.
- **Alertas com ciclo de vida** — `new → ack → resolved`, com auto-resolve quando a
  condição deixa de existir.

---

## Funcionalidades do dashboard

O painel tem **9 telas**, navegáveis pela coluna da esquerda:

| Tela | O que mostra |
|------|--------------|
| **Visão Geral** | Cartões de load, RAM, swap, temperatura, uptime + 4 gráficos (load, RAM, temp, discos) + rede + serviços |
| **Discos** | Cartão por disco com % usado, espaço livre e **previsão de lotação (ETA)**; gráfico por disco; selo SMART |
| **Rede** | Download/upload em Mbps, tráfego ao longo do tempo, I/O por disco (abas dinâmicas conforme `DISK_DEVS`) |
| **Processos** | Top 7 por consumo de memória, com busca e ordenação por qualquer coluna |
| **Alertas** | Ciclo de vida completo, filtros (ativos/todos/warning/critical), reconhecer e resolver |
| **Anotações** | Linha do tempo de eventos marcados por você (ex.: "troquei o cooler"), com formulário rápido e remoção |
| **Análise** | **Índice de saúde** com os descontos, pressão de RAM (6h), ETA de discos, resumo diário, **outages** e % de uptime (30 dias) |
| **Histórico** | Tabela com todas as amostras do período — "rolar o passado" com valores exatos |
| **Ajuda** | Guia rápido embutido no próprio painel |

**Interações em todas as telas:**

- **Período**: botões `1h` / `6h` / `24h` / `72h` no topo.
- **Tema**: botão no topo alterna entre **escuro e claro** (guarda a preferência).
- **Zoom**: roda do mouse sobre o gráfico. **Pan**: `Shift` + arrastar.
- **Detalhe**: clique num ponto do gráfico para abrir tudo daquela coleta.
- **Anotações**: marque eventos na linha do tempo (ex.: "troquei o cooler") para
  entender mudanças semanas depois.
- **Coletar agora**: botão que força uma coleta imediata, sem esperar o minuto.
- **Exportar**: baixa o período atual em CSV (abre direto no Excel).

---

## Pré-requisitos

1. **Node.js 18 ou mais novo** — o "motor" do programa.
   ```bash
   node --version   # deve mostrar v18.x ou superior
   ```
2. **Acesso SSH ao servidor por chave** — o instalador cria e configura isso para você.
3. **Servidor ligado e na rede** — o painel coleta dele, afinal.

> Não sabe configurar a chave SSH? Não precisa: o `./install.sh` faz tudo (gera a chave,
> copia para o servidor, cria o alias). O serviço `sshd` precisa estar ativo no servidor —
> nada além disso.

---

## Instalação (fácil)

> Quer um passo a passo com calma? O [Tutorial passo a passo](TUTORIAL.md)
> cobre pré-requisitos, instalação e como iniciar, do zero.

```bash
git clone https://github.com/seu-usuario/linux-server-dashboard.git
cd linux-server-dashboard
./install.sh
```

O `./install.sh` é um **assistente 1-comando** que:

1. Confere o Node.js (18+) e instala as dependências;
2. Cria o `.env` (se ainda não existir) com permissões restritas e **gera um `DASH_TOKEN`
   automático** para proteger a API (você pode trocá-lo depois);
3. **Testa a conexão SSH**;
4. Se não estiver configurada, abre o **assistente SSH interativo** — aceita um **alias
   já existente** no `~/.ssh/config` ou um `usuario@IP`/`IP` novo (com porta SSH opcional),
   mostra o plano antes de aplicar e gera/copia a chave Ed25519
   (`~/.ssh/dashboard_ed25519`) pedindo a **senha uma única vez**;
5. Restringe permissões de `data/` e `.env` (segurança);
6. Mostra o resumo com o token de acesso e um **menu de próximos passos** (iniciar em
   segundo plano, instalar como serviço systemd, ver o tutorial ou sair).

> Entrada inválida não quebra a instalação: o assistente pede de novo (Ctrl+C cancela).
> Toda entrada (usuário, host, alias, porta) é validada no shell antes de tocar no
> `~/.ssh/config` e no `.env` — veja `install-lib.sh`.

Opções do instalador:

| Comando | O que faz |
|---------|-----------|
| `./install.sh` | Assistente completo (recomendado) |
| `./install.sh --auto` | Não-interativo: dependências + `.env` + token (sem assistente SSH) |
| `./install.sh --manual` | Só dependências + `.env` (você já tem SSH configurado) |
| `./install.sh --configure` | Só o assistente SSH (trocar de servidor) |
| `./install.sh --test` | Roda a suíte de testes e sai |
| `./install.sh --install-service` | Cria o serviço systemd (roda sempre) |
| `./install.sh --uninstall-service` | Remove o serviço systemd |

**Teste rápido** (coleta única, sem abrir o navegador):

```bash
node server/poller.js --once
```

Deve imprimir um JSON com `"ok": true` e os dados do servidor. Se aparecer isso,
a comunicação está funcionando.

---

## Configuração

As variáveis ficam no arquivo `.env` (o instalador já cria e preenche o `SSH_HOST`):

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `SSH_HOST` | `seu-host` | Host/alias SSH do servidor (criado pelo instalador) |
| `POLL_INTERVAL` | `60000` | Intervalo entre coletas em ms. **Mínimo 10000** (protege o servidor) |
| `PORT` | `3000` | Porta do dashboard no seu computador |
| `HISTORY_LIMIT` | `4320` | Amostras retidas (4320 = 3 dias a 1/min) |
| `HISTORY_FILE` | `data/history.json` | Arquivo de persistência (sempre dentro de `data/`) |
| `LOG_FILE` | `data/dashboard.log` | Arquivo de log (sempre dentro de `data/`) |
| `NET_IF` | *(vazio)* | Interface de rede a monitorar (vazio = seção Rede omitida) |
| `DISK_MOUNTS` | `/` | Mount points monitorados, separados por espaço |
| `DISK_DEVS` | *(vazio)* | Dispositivos de bloco p/ IO/SMART (vazio = omitido) |
| `SERVICES` | *(vazio)* | Serviços systemd monitorados, separados por espaço |
| `DASH_TOKEN` | *(gerado no install)* | **Token** de acesso à API/SSE (veja [Segurança](#segurança)); o instalador gera um automático se vazio |

> **Segurança automática do `.env`:** valores que não são "palavras seguras"
> (letras, números, `_ . : / -`) são **ignorados** pelo programa. Assim, nada escrito
> no `.env` vira comando no servidor. Tokens que começam com `-` também são ignorados
> — inclusive o `SSH_HOST`, que passa por sanitização própria antes do SSH.

---

## Como usar

### Iniciar

```bash
./start.sh
```

Ou em segundo plano (libera o terminal):

```bash
./start.sh --background
```

Confira se está rodando em segundo plano (e em qual porta):

```bash
./start.sh --status
```

Ou, se você instalou o serviço systemd (`./install.sh --install-service`), o painel
já está rodando — para gerir:

```bash
systemctl --user status  linux-server-dashboard
systemctl --user restart linux-server-dashboard
```

### Abrir o painel

No navegador (Firefox, Chrome...), acesse:

```
http://localhost:3000
```

> O painel só é acessível **neste computador** (`127.0.0.1`). Ninguém mais na rede
> consegue abrir — isso é proposital.

> Entender cada tela e cada número? O [Tutorial passo a passo](TUTORIAL.md)
> tem um glossário para leigos e a seção "Como usar o dashboard".

### Verificar se está rodando

```bash
curl http://127.0.0.1:3000/api/status
```

Deve devolver um JSON com `"online":true`.

### Parar

```bash
./stop.sh        # forma fácil (encontra e encerra o processo)
# ou Ctrl+C no terminal do ./start.sh
```

> **Nada se perde ao parar.** O histórico fica salvo em `data/history.json` e os
> gráficos continuam de onde pararam. Parar o painel **não afeta o servidor**.

---

## Rodar sempre em segundo plano (systemd)

Para o painel iniciar sozinho no login (e ficar sempre de pé):

```bash
./install.sh --install-service
```

O serviço roda como **usuário** (sem `sudo`). Para ele continuar ativo mesmo sem
login gráfico:

```bash
loginctl enable-linger $USER
```

Remover:

```bash
./install.sh --uninstall-service
```

---

## Exemplo real do autor

Esta ferramenta nasceu para vigiar um servidor caseiro de hardware muito limitado —
a prova de que funciona até em máquinas de baixo custo:

- **Hardware**: 1 núcleo, pouca RAM, rede 100 Mbps
- **Sistema**: Debian (stable), kernel recente
- **Discos**: um disco de sistema + HDs SMR de alta capacidade (lentos para reescrever)
- **Serviços**: smbd/nmbd (compartilhamentos de rede SMB/CIFS)

Mesmo com 1 núcleo e menos de 1 GB de RAM, o servidor responde o comando de coleta em
~1 segundo, sem sentir. **O dashboard roda no seu computador, não no servidor.**

Se você tem um servidor (nuvem, VPS, máquina velha em casa, Raspberry Pi...), o
princípio é o mesmo: o monitoramento não pesa em quem é monitorado.

---

## API

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/` | GET | Dashboard web (sidebar multi-view, hash routing) |
| `/api/status` | GET | Última amostra + meta (online, lastPollAt, nextPollAt, offlineSince) + alertas ativos |
| `/api/history` | GET | `?limit=N&from=&to=` → amostras no range (downsample p/ máx 720) |
| `/api/alerts` | GET | `?status=&level=&limit=` → `{active, all}` com ciclo de vida |
| `/api/alerts/:id/ack` | POST | Reconhece um alerta |
| `/api/alerts/:id/resolve` | POST | Resolve um alerta |
| `/api/annotations` | GET/POST | Lista / cria anotações (`{ts, text, label}`) |
| `/api/annotations/:id` | DELETE | Remove uma anotação |
| `/api/export` | GET | `?format=csv\|json&from=&to=` → download do relatório |
| `/api/stream` | GET | SSE: `hello`, `sample`, `alerts`, `annotations`, `status` |
| `/api/poll` | POST | Dispara coleta imediata ("coletar agora") |

> Se `DASH_TOKEN` estiver definido no `.env` (o instalador gera um automático), toda a
> API/SSE exige `Authorization: Bearer <token>` (ou `?token=` na URL do SSE). O navegador
> pede o token uma vez e guarda na sessão. Mutações são protegidas por CSRF (cookie
> `dash_csrf`) e limitadas por IP.

---

## Alertas

| Condição | Nível | O que fazer |
|----------|-------|-------------|
| Disco ≥ 90% usado | ⚠️ warning | Liberar espaço; atenção especial à partição de sistema |
| RAM usada ≥ 90% | ⚠️ warning | Conferir a tela **Processos**; encerrar o que pesa |
| Temperatura CPU ≥ 60 °C | ⚠️ warning | Verificar ventilação, poeira nos coolers, posição do PC |
| SMART diferente de `PASSED` | 🔴 critical | **Backup imediato** — pode ser falha física |
| Serviço monitorado inativo | 🔴 critical | Reiniciar o serviço no servidor |
| SSH falhou (servidor inacessível) | 🔴 critical | Servidor desligado/fora da rede; o painel tenta sozinho a cada minuto |

**Regra de ouro:** warning = preste atenção, critical = aja.

Os alertas têm ciclo de vida: **novo → reconhecido (✓) → resolvido**. O painel
resolve sozinho quando a condição deixa de existir, ou você resolve manualmente.

---

## Segurança

Este projeto foi desenhado com **segurança by design**. Os principais pontos:

**No servidor monitorado**
- **Sem senhas.** A autenticação é por **chave SSH** (Ed25519). O `.env` não guarda
  senha nenhuma, e o `.env.example` só traz placeholders.
- **Somente leitura.** O servidor executa apenas comandos de leitura (`cat`, `df`,
  `free`, `ps`, `smartctl`...). Nada é instalado, alterado ou executado de forma
  persistente no servidor.
- **1 comando por minuto.** Contato mínimo, previsível e barato.
- **Sem agentes.** Não há daemon, serviço ou script rodando no servidor — não há
  superfície de ataque nova por lá.
- **Anti-injeção de config.** Os valores de `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS` e
  `SERVICES` são filtrados por uma **whitelist** de caracteres seguros antes de entrar
  no comando SSH. Nada vindo do `.env` consegue virar comando no servidor.
- **Host saneado.** O `SSH_HOST` passa por sanitização própria que rejeita valores que
  começam com `-` (tentativa de injetar opções do `ssh`), com fallback para o alias
  padrão.

**No seu computador**
- **Dashboard local.** Bind em `127.0.0.1` — o painel não fica exposto na rede.
- **Validação de `Host`.** O servidor rejeita (HTTP 403) qualquer requisição cujo
  cabeçalho `Host` não seja `localhost`/`127.0.0.1`/`[::1]`. Isso **bloqueia DNS
  rebinding** (truque em que um site malicioso "pega emprestado" o endereço local).
- **Proteção CSRF em duas camadas.** (1) Requisições que mudam estado com origem
  cruzada são rejeitadas por `Origin`/`Sec-Fetch-Site`; (2) o servidor emite um cookie
  `dash_csrf` (SameSite=Lax, HttpOnly) e exige que mutações com `Origin` presente
  carreguem esse cookie — bloqueando formulários e pedidos forjados que não têm o cookie.
- **Comparação de token sem vazamento de tempo.** O `DASH_TOKEN` é comparado com
  `crypto.timingSafeEqual` (resistente a ataques de timing).
- **Rate limit.** Mutações na API (`POST`/`DELETE`) são limitadas por IP (120/min) —
  dificulta força bruta e abuso.
- **Erros sem vazamento.** O servidor devolve erros em JSON **sem stack trace**
  (nenhum detalhe interno chega ao navegador).
- **Cabeçalhos de segurança.** CSP restritivo (`frame-ancestors 'none'`),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`
  e `Permissions-Policy` restritiva em todas as respostas.
- **Escape de HTML (anti-XSS).** Todo dado exibido no painel (alertas, montagens de
  disco, nomes de serviço, comandos de processo, SMART...) passa por escape antes de
  virar HTML.
- **Export seguro.** O CSV previne **formula injection** (Excel) e o nome do arquivo
  é saneado.
- **Permissões restritas.** `data/` é `700` e os arquivos de dados/`.env` são `600`.
- **Segredos fora do git.** `.env` e `data/` estão no `.gitignore`; o repositório
  público contém apenas código e modelos sem valores.
- **SSH não-interativo.** `BatchMode=yes` + `ConnectTimeout=10` — falha rápido se o
  servidor estiver fora, sem travar nem pedir interação. O instalador grava o alias
  com `StrictHostKeyChecking accept-new` (verificação de host key segura).
- **Token por padrão (`DASH_TOKEN`).** O instalador gera um token automático — a API/SSE
  passa a exigir `Authorization: Bearer <token>` (ou `?token=`), e o navegador pede o
  token uma única vez, guardando na sessão.

> Se você fosse auditar: o único contato com o servidor é o comando SSH construído em
> `server/poller.js` (`buildCommand()`), com valores já filtrados por
> `server/config.js` (`sanitizeToken()`). É só leitura, é só 1 por minuto, e é isso.

---

## Testes

O projeto tem uma suíte de testes (sem dependências novas, usa o runner nativo do Node):

```bash
npm test
```

Cobre: parse do poller, limiares de alertas, downsample do histórico, ciclo de vida
de alertas (incluindo dedupe do alerta offline), sanitização de configuração (incluindo
anti-injeção de `NET_IF` e do host SSH), validação de `Host`/CSRF/token (com cookie
`dash_csrf` e comparação a prova de timing), rate limit, error handler sem stack trace,
escrita atômica assíncrona do histórico, guards de renderização do frontend,
renderização de anotações e o toggle de tema claro/escuro.

---

## Estrutura do projeto

```
linux-server-dashboard/
├── AGENTS.md               ← regras e arquitetura do projeto
├── TUTORIAL.md             ← tutorial passo a passo para leigos
├── README.md               ← este arquivo
├── SECURITY.md             ← política e threat model de segurança
├── LICENSE                 ← MIT
├── install.sh              ← assistente 1-comando (deps, .env+token, SSH, systemd, menus)
├── install-lib.sh          ← validação pura das entradas do instalador (segurança)
├── start.sh                ← inicia o serviço (primeiro plano, --background ou --status)
├── stop.sh                 ← para o serviço com segurança (PID file)
├── package.json            (deps: express + chart.js + zoom/annotation plugins)
├── .env.example            (modelo de configuração, sem valores reais)
├── .gitignore              (exclui .env, data/, node_modules/)
├── data/                   (runtime: history.json, alerts.json, annotations.json, log)
├── server/
│   ├── index.js            (Express, SSE, API, loop de poll, export CSV)
│   ├── config.js           (parser único do .env, validações, sanitização)
│   ├── security.js         (Host check, CSRF c/ cookie, headers, token timing-safe, rate limit)
│   ├── csv.js              (export CSV com escape anti-fórmula)
│   ├── poller.js           (comando SSH, parse, taxas de rede/I/O, alertas)
│   ├── history.js          (buffer em memória + persistência JSON atômica assíncrona)
│   └── stores.js           (JsonStore genérico: AlertsStore, AnnotationsStore)
├── test/                   (suíte de testes — node --test)
├── test-support/           (helpers de teste: VM p/ frontend, request HTTP)
└── public/
    ├── index.html          (dashboard PT-BR, temas claro/escuro, sidebar multi-view)
    ├── style.css           (visual: paleta de console de operação, tipografia sans/mono, responsivo)
    ├── fonts/              (Inter + JetBrains Mono self-hosted, .woff2 — sem CDN)
    └── js/
        ├── main.js         (orquestração: SSE, refresh, ações, modais, token, tema)
        ├── router.js       (navegação por hash entre as views)
        ├── charts.js       (Chart.js + zoom/pan + anotações no timeline)
        ├── sections.js     (renderização das views, escape HTML, abas I/O dinâmicas)
        └── analysis.js     (health score, ETA de disco, pressão de RAM, outages)
```

---

## Solução de problemas

### O painel não abre no navegador
- O serviço está rodando? (o terminal está com `./start.sh` ativo?)
- Mudou a porta? Use a nova porta na URL (`PORT` no `.env`).
- Teste: `curl http://127.0.0.1:3000/api/status`
- "Host não permitido (403)"? Abra por `http://localhost:3000` ou `http://127.0.0.1:3000`
  — outros endereços são bloqueados de propósito.

### "Servidor inacessível" (indicador offline)
1. `ping -c 3 seu-host`
2. `ssh seu-host 'uptime'`
3. Se voltou, o painel se recupera sozinho no próximo minuto (ou clique em **Coletar agora**).

### "Chave do servidor não autorizada" no primeiro uso
- O `install.sh` resolve: ele aceita a chave do servidor na primeira conexão.
- Manualmente: `ssh seu-host 'echo ok'` e confirme com `yes` na pergunta de host key.

### Chave SSH pedindo senha
- A chave não está sendo usada. Confira `ls -la ~/.ssh/` e o seu `~/.ssh/config`.
- "Permission denied" = a chave pública não está autorizada no servidor. Reautorize:
  ```bash
  ssh-copy-id -i ~/.ssh/dashboard_ed25519.pub seu-host
  ```
  ou rode `./install.sh --configure`.

### Porta 3000 já em uso
```bash
lsof -i :3000                 # descobrir quem está usando
# opções: kill <PID> ou mudar PORT no .env
```

### Ver os logs
```bash
tail -f data/dashboard.log    # primeiro plano / systemd
tail -f data/nohup.log        # modo --background
```

---

## FAQ

**Isso é invasivo?** Não. É leitura pura: o servidor só responde um comando por minuto
com métricas do sistema — nenhum arquivo é modificado.

**Afeta o desempenho do servidor?** Muito pouco. Um comando leve a cada 60 s é
irrelevante, até num servidor de 1 núcleo. Todo o trabalho pesado (parse, gráficos,
histórico) roda na sua máquina.

**Preciso de senha?** Não. O acesso é por chave SSH. O `./install.sh` cria e copia a
chave para você (ele pede a senha do servidor uma única vez, só para copiar a chave).

**Funciona em qualquer servidor Linux?** Sim, desde que tenha `sshd` ativo e os
comandos padrão (`df`, `free`, `ps`, `systemctl`, `smartctl`*). O comando de coleta é
montado em `server/poller.js` — ajuste discos, interface de rede e serviços conforme
o seu ambiente.

**E se o servidor ficar off?** O painel mostra o alerta de inacessível, preserva o
histórico e continua tentando a cada minuto — recupera sozinho quando volta.

**Guarda muitos dados?** No servidor: nada (zero escrita). Na sua máquina: ~60–200
pequenas escritas por dia no SSD local (histórico de 3 dias).

**É seguro expor na internet?** Não é para isso. O dashboard bind em `127.0.0.1` é
deliberado — rode localmente e, se quiser acesso remoto, use uma VPN/túnel SSH.

---

## Licença

**MIT** — use, modifique e compartilhe livremente, com atribuição (veja `LICENSE`).

---

*Monitoramento somente leitura via SSH — 1 coleta/min — dashboard local em 127.0.0.1.
O servidor não instala nada.*