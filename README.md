# Linux Server Dashboard

**Monitoramento em tempo real do seu servidor Linux, direto do navegador — sem instalar
nada no servidor, sem senha, sem agente.**

> **V2 em construção.** Este repositório é a reformulação completa do projeto, iniciada a
> partir da versão estável [`v1.0.0`](https://github.com/tsouza-thiago/linux-server-dashboard-v2/releases/tag/v1.0.0).
> Plano e decisões: [`docs/PLANO_V2.md`](docs/PLANO_V2.md) · [`docs/adr/`](docs/adr/README.md) ·
> mudanças: [`CHANGELOG.md`](CHANGELOG.md). Até a `2.0.0`, as instruções abaixo valem para a V1.

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
       Node.js, sem dependências (127.0.0.1:3000)
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
[storage/]    histórico append-only em data/history/ (72h brutas) + data/rollup/ (90 dias em baldes de 5 min)
      ↑
[index.js]  node:http (127.0.0.1:3000) → dashboard + API REST + SSE (tempo real)
      ↑
[Navegador]  8 telas (ES modules + uPlot), manchete de saúde, eventos, relatórios
```

O ciclo é simples e proposital:

1. **Coleta** — a cada 60 s o poller executa **um único comando SSH** no servidor, que
   lê dezenas de métricas do sistema (CPU, memória, discos, rede, temperatura, SMART,
   serviços, processos) e devolve tudo em uma resposta só.
2. **Parse** — a resposta é interpretada localmente e vira uma "amostra" JSON
   (uma linha = um minuto da vida do servidor).
3. **Persistência** — a amostra entra no histórico (3 dias, com escrita atômica).
4. **Entrega** — o servidor local (`node:http`) serve o dashboard e atualiza os gráficos em tempo real via
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

O painel tem **8 telas**, navegáveis pela coluna da esquerda ou pelas teclas `1` a `8`:

| Tela | O que mostra |
|------|--------------|
| **1 Visão geral** | Anel de saúde 0–100 com a frase "Servidor saudável" / "Atenção" / "Crítico" e por quê; disponibilidade de 90 dias e custo da coleta no servidor; 5 indicadores com mini-gráfico (processador, memória, disco mais cheio com previsão, temperatura, rede); telemetria em faixas com cursor sincronizado; resumo de discos, eventos e processos |
| **2 Recursos** | CPU empilhada (usuário, sistema, espera de disco), carga, memória (média, pico, tendência, swap), temperatura com o limite e os sensores, pressão do sistema (PSI) |
| **3 Armazenamento** | Espaço e inodes por ponto de montagem, **previsão de lotação** com as datas do alerta e de "cheio", atividade de cada disco (ocupação, leitura/gravação, latência) e saúde SMART |
| **4 Rede** | Download e upload agora com o pico do período, volume do dia, erros e descartes, tráfego no período, volume por dia (7 dias) e maiores picos |
| **5 Processos & serviços** | Cada serviço com o histórico de quedas, os processos que mais usam memória (busca e ordenação) e "para onde vai a memória" |
| **6 Eventos** | Disponibilidade de 90 dias dia a dia; linha do tempo única de alertas, quedas e anotações, agrupada por dia; filtros; reconhecer; anotar; notificações do navegador |
| **7 Relatórios** | Resumo de 7, 30, 90 dias ou de datas escolhidas, tabela por dia (fuso local) com disponibilidade e eventos; exportação CSV/JSON; impressão/PDF |
| **8 Ajuda** | O que fazer em cada alerta, como ler o painel, atalhos, configuração ativa (só leitura), acesso ao servidor (linha do sudoers para copiar), versões e sessão |

**Interações em todas as telas:**

- **Período**: botões `1h` · `6h` · `24h` · `72h` · `7d` · `30d` · `90d` no topo (fica na URL).
- **Gráficos**: arrastar = aproximar um trecho · roda do mouse = zoom · duplo clique = voltar.
  O cursor fica sincronizado entre os gráficos da tela.
- **Atalhos**: `1`–`8` telas · `C` coletar agora · `T` tema · `N` nova anotação · `/` buscar processo · `?` ajuda.
- **Tema**: escuro é o padrão; o botão da lua/sol (ou `T`) alterna para o claro (fica salvo).
- **Anotações**: em Eventos, marque manutenções ("troquei o cooler"); viram linhas tracejadas nos gráficos.
- **Coletar agora**: força uma coleta imediata, sem esperar o minuto (embaixo do menu, com a
  contagem para a próxima coleta).
- **Faixa de status** no topo: online / coletando / offline, host, sistema, uptime, idade da
  última coleta e quanto ela custou ao servidor (tempo do SSH e tamanho da resposta).
- **Celular**: o menu vira o botão ☰ no canto superior esquerdo.

---

## Pré-requisitos

1. **Linux nesta máquina** (Debian, Ubuntu, Mint ou Fedora; ADR 0013).
2. **git** — o único momento em que algo pede senha neste computador:
   ```bash
   sudo apt install git     # Debian/Ubuntu/Mint
   sudo dnf install git     # Fedora
   ```
3. **Servidor ligado e na rede**, com o `sshd` ativo, e um usuário dele que possa usar
   `sudo` (só para preparar o acesso, uma vez).

Não precisa instalar o Node.js: se o do sistema faltar ou for anterior ao 24, o
`./dashboard` baixa o Node 24 oficial para dentro da pasta (`.runtime/`) e confere a soma
SHA-256 antes de usar. Nada de `npm install`: uPlot e fontes já vêm no pacote, conferidos.

---

## Instalação (1 comando)

> Quer um passo a passo com calma? O [Tutorial passo a passo](TUTORIAL.md)
> cobre pré-requisitos, instalação e como iniciar, do zero.

```bash
git clone https://github.com/tsouza-thiago/linux-server-dashboard-v2.git && cd linux-server-dashboard-v2 && ./dashboard instalar
```

O `./dashboard instalar` confere a **assinatura da versão** (fixa na versão assinada mais
nova, ADR 0012), o Node 24, os arquivos do pacote e a porta, e abre o **assistente no
navegador** (`http://127.0.0.1:3000/configurar`, com código de uso único). São 6 passos:

1. **Boas-vindas** — o que será feito e o que nunca é feito (nada é instalado no servidor,
   nada de sudo nesta máquina, a senha não é guardada).
2. **Servidor** — endereço e o seu usuário administrador (com teste de alcance).
3. **Conectar** — você confere a **identidade do servidor** antes de digitar a senha; 1
   conexão só de leitura descobre discos, pastas, rede, serviços e o sudo.
4. **O que monitorar** — tudo já vem marcado como recomendado; ajuste pastas, SMART por
   disco, rede, serviços e limiares.
5. **Preparar o servidor** — *assistido* (mostra os comandos exatos e executa depois do seu
   "Confirmar") ou *à mão* (blocos com Copiar e Testar). Cria o usuário `dashmon`, sem senha,
   com uma chave que **só roda a coleta** e só a partir deste computador, e libera o `sudo`
   apenas para `smartctl -H` nos discos escolhidos (ADR 0008).
6. **Pronto** — primeira leitura real, "iniciar com o computador", atalho no menu e o painel
   aberto já logado.

Máquina sem tela ou acessada por SSH? `./dashboard instalar --terminal` faz os mesmos
passos no terminal. Para automatizar: `./dashboard instalar --sem-interface --ajuda`.

Vindo da V1? Veja [Atualizar da V1](#atualizar-da-v1).

---

## Comandos

| Comando | O que faz |
|---------|-----------|
| `./dashboard instalar` | primeira instalação (assistente no navegador) |
| `./dashboard abrir` | abre o painel no navegador, já logado (link de uso único) |
| `./dashboard iniciar` / `parar` / `status` | controle do painel (serviço de usuário ou segundo plano) |
| `./dashboard diagnosticar` | testa tudo e explica cada problema em português simples |
| `./dashboard reconfigurar` | reabre o assistente (trocar servidor, discos, serviços) |
| `./dashboard atualizar` | baixa a versão assinada mais nova, com backup de `data/` e volta atrás se falhar |
| `./dashboard desinstalar` | remove serviço, atalho e arquivos locais e oferece limpar o servidor |

Depois de instalado, o painel aparece no menu de aplicativos como **Server Dashboard** e
inicia com o computador (serviço systemd **de usuário**, com isolamento: só grava em
`data/`). Nenhum terminal precisa ficar aberto.

> **Nada se perde ao parar.** O histórico fica em `data/history/` e `data/rollup/`.
> Parar o painel **não afeta o servidor**.

---

## Configuração

O assistente preenche o `.env` (0600). Para mudar servidor, discos ou serviços, use
`./dashboard reconfigurar`: ele também atualiza a linha da chave restrita no servidor.

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `SSH_HOST` | `servidor` | Nome do servidor no `data/ssh/config` (ou um alias do `~/.ssh/config`, como na V1) |
| `SSH_CONFIG` | `data/ssh/config` | Configuração SSH própria do painel (`ssh -F`); vazio = usa o `~/.ssh/config` |
| `SSH_ACESSO` | `restrito` | `restrito` = a chave só roda a coleta; `direto` = o painel envia o comando (V1) |
| `POLL_INTERVAL` | `60000` | Intervalo entre coletas em ms. **Mínimo 10000** (protege o servidor) |
| `PORT` | `3000` | Porta do painel neste computador (só em 127.0.0.1) |
| `HISTORY_LIMIT` | `4320` | Amostras retidas (4320 = 3 dias a 1/min) |
| `HISTORY_FILE` | `data/history.json` | Histórico da V1 a migrar (1 vez, com backup; sempre dentro de `data/`) |
| `LOG_FILE` | `data/dashboard.log` | Log (sempre dentro de `data/`; gira em 5 MB) |
| `NET_IF` | *(vazio)* | Interface de rede (vazio = tela Rede oculta) |
| `DISK_MOUNTS` | `/` | Pastas (pontos de montagem) acompanhadas, separadas por espaço |
| `DISK_DEVS` | *(vazio)* | Discos para leitura/gravação (I/O) |
| `SMART_DEVS` | *(= DISK_DEVS)* | Discos com teste de saúde SMART (1x por hora); vazio = nenhum |
| `SERVICES` | *(vazio)* | Serviços systemd acompanhados |
| `DASH_TOKEN` | *(gerado)* | Token de acesso (o navegador pede 1x; `./dashboard abrir` entra sem ele) |
| `ALERT_*` | 90 / 90 / 60 / 5 / 2 | Limiares de disco %, RAM %, temperatura °C, histerese e quedas seguidas |

> **Segurança automática do `.env`:** valores que não são "palavras seguras"
> (letras, números, `_ . : / -`) são **ignorados**. Nada escrito no `.env` vira comando
> no servidor; tokens que começam com `-` também são ignorados.

---

## Abrir o painel

```bash
./dashboard abrir
```

Ou pelo atalho **Server Dashboard** no menu. O painel só existe **neste computador**
(`127.0.0.1`): ninguém mais na rede consegue abrir — isso é proposital.

> Entender cada tela e cada número? O [Tutorial passo a passo](TUTORIAL.md)
> tem um glossário para leigos e a seção "Como usar o dashboard".

---

## Atualizar da V1

A V1 e a V2 **nunca rodam juntas** (seriam 2 conexões por minuto ao servidor). Com a V2
clonada numa pasta nova:

```bash
./dashboard instalar --importar-v1 ~/linux-server-dashboard
```

Isso para a V1 (e tira o serviço dela do início automático), traz o `.env` e os dados
(histórico convertido com backup, alertas e anotações) e liga a V2 usando o mesmo acesso
SSH da V1. A pasta da V1 **não é alterada**: para voltar, `./dashboard parar` e, na pasta da
V1, `./start.sh --background` (o script de lá). Depois, `./dashboard reconfigurar` troca o acesso completo
da V1 pela chave restrita à coleta.

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
| `/` | GET | Dashboard web (8 telas, rota por hash com período) |
| `/api/config` | GET | Configuração ativa (só leitura, sem segredos) |
| `/api/status` | GET | Última amostra + meta (online, lastPollAt, nextPollAt, offlineSince) + alertas ativos |
| `/api/history` | GET | `?limit=N&from=&to=` → amostras no range (redução p/ máx 720 preservando picos); `formato=baldes` → mín/máx/média até 90 dias |
| `/api/alerts` | GET | `?status=&level=&limit=` → `{active, all}` com ciclo de vida |
| `/api/alerts/:id/ack` | POST | Reconhece um alerta |
| `/api/alerts/:id/resolve` | POST | Resolve um alerta |
| `/api/annotations` | GET/POST | Lista / cria anotações (`{ts, text, label}`) |
| `/api/annotations/:id` | DELETE | Remove uma anotação |
| `/api/export` | GET | `?format=csv\|json&from=&to=` → download do relatório |
| `/api/stream` | GET | SSE: `hello`, `sample`, `alerts`, `annotations`, `status` |
| `/api/poll` | POST | Dispara coleta imediata ("coletar agora") |

> Se `DASH_TOKEN` estiver definido no `.env` (o instalador gera um automático), toda a
> API/SSE exige login: o token é pedido uma vez numa tela de login e trocado por um
> cookie de sessão de 30 dias (scripts podem usar `Authorization: Bearer <token>`). O token
> nunca vai na URL. Mutações são protegidas por CSRF (cookie `dash_csrf`) e limitadas por IP.

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
- **Somente leitura.** O servidor executa apenas comandos de leitura (`cat` em `/proc` e
  `/sys`, `df`, `ps`, `systemctl is-active`, `smartctl -H`). Nada é instalado no servidor.
- **Chave restrita (ADR 0008).** O painel entra com um usuário próprio (`dashmon`, sem
  senha) cuja chave tem `restrict,from="<este computador>",command="<coleta>"` no
  `authorized_keys`: mesmo vazada, ela só roda a coleta, só a partir daqui, sem terminal
  nem encaminhamentos. O `sudo` dele vale só para `smartctl -H` em cada disco escolhido
  (sem curinga), validado com `visudo -c` antes de ativar. Tudo é exibido antes, feito
  depois do seu "Confirmar" e desfeito pelo `./dashboard desinstalar`.
- **Senha do servidor usada uma vez.** Na instalação, a senha do administrador fica só na
  memória do assistente (nunca em disco, log ou linha de comando) e é descartada no fim.
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
- **SSH isolado.** O painel usa só a própria configuração (`ssh -F data/ssh/config`) e o
  próprio `known_hosts`, com `StrictHostKeyChecking yes`: a identidade do servidor é a que
  você conferiu na instalação; se mudar, a coleta para e avisa. `BatchMode=yes` +
  `ConnectTimeout=10`. O seu `~/.ssh/config` não é tocado.
- **Versões assinadas (ADR 0012).** O instalador e o `./dashboard atualizar` só aceitam tags
  assinadas pela chave listada em `docs/allowed_signers`; a atualização confere a versão
  nova com a lista da versão já instalada. uPlot e fontes são conferidos por SHA-256 e o
  Node baixado também.
- **Token por padrão (`DASH_TOKEN`).** O instalador gera um token automático — a API/SSE
  passa a exigir login; o navegador pede o token uma única vez e o troca por um cookie
  de sessão (HttpOnly, 30 dias). O token nunca vai na URL.

> Se você fosse auditar: o único contato com o servidor é o comando de coleta montado em
> `server/collector/builder.js`, com valores já filtrados por `server/config.js`
> (`sanitizeToken()`), e é ele que fica gravado na linha restrita do `authorized_keys`.
> É só leitura, é só 1 por minuto, e é isso.

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
renderização de anotações e o toggle de tema claro/escuro. O parse do poller tem
isolamento de ambiente (`parseOutput(..., { svcOrder, devSet })`, mesmo padrão de
`buildCommand(overrides)`), de modo que o teste da amostra realista não depende
do `SERVICES`/`DISK_DEVS` do `.env` local.

---

## Estrutura do projeto

```
linux-server-dashboard/
├── AGENTS.md               ← regras e arquitetura do projeto
├── TUTORIAL.md             ← tutorial passo a passo para leigos
├── README.md               ← este arquivo
├── SECURITY.md             ← política e threat model de segurança
├── LICENSE                 ← MIT
├── dashboard               ← comando único: garante o Node 24 e chama a CLI (server/cli/)
├── package.json            (sem dependências; playwright-core só para testes e2e)
├── .env.example            (modelo de configuração, sem valores reais)
├── .gitignore              (exclui .env, data/, node_modules/)
├── data/                   (runtime: history/, rollup/, ssh/, alerts.json, annotations.json, log)
├── docs/                   (plano da V2, ADRs e allowed_signers das releases assinadas)
├── scripts/                (check, captura de amostra, Node do ./dashboard, askpass, e2e da instalação)
├── server/
│   ├── index.js            (rotas da API, loop de poll, export CSV)
│   ├── cli/                (subcomandos do ./dashboard: instalar, abrir, diagnosticar, atualizar…)
│   ├── setup/              (instalação: detecção, preparo do servidor, assistente web e TUI)
│   ├── http/               (servidor próprio: rotas, estáticos, sessão, SSE)
│   ├── config.js           (parser único do .env, validações, sanitização)
│   ├── security.js         (Host check, CSRF c/ cookie, headers, token timing-safe, rate limit)
│   ├── csv.js              (export CSV com escape anti-fórmula)
│   ├── poller.js           (comando SSH, parse com overrides p/ teste, taxas de rede/I/O, alertas)
│   ├── storage/            (histórico NDJSON bruto + agregados de 5 min + migração da V1)
│   └── stores.js           (JsonStore genérico: AlertsStore, AnnotationsStore)
├── test/                   (suíte de testes — node --test)
├── test-support/           (helpers de teste: VM p/ frontend, request HTTP)
└── public/
    ├── index.html          (casca das 8 telas, login e avisos)
    ├── configurar.html     (assistente de instalação, 6 passos)
    ├── css/                (design system V2: tokens, base, componentes, telas, impressão)
    ├── fonts/              (Geist e Geist Mono, OFL — sem CDN)
    ├── vendor/uplot/       (uPlot versionado com SHA-256)
    └── js/                 (ES modules: core/, charts/, views/ e main.js — sem build)
```

---

## Solução de problemas

Primeiro passo, sempre: `./dashboard diagnosticar`. Ele confere painel, permissões,
acesso ao servidor, chave restrita, SMART e última coleta, e diz o que fazer.

### O painel não abre no navegador
- `./dashboard status` mostra se está rodando; `./dashboard abrir` liga e abre já logado.
- "Host não permitido (403)"? Abra por `http://127.0.0.1:3000` (ou `localhost`) — outros
  endereços são bloqueados de propósito.

### "Servidor inacessível" (indicador offline)
1. O servidor está ligado e na mesma rede?
2. `./dashboard diagnosticar` testa a conexão e explica o motivo.
3. Quando voltar, o painel se recupera sozinho no próximo minuto (ou clique em **Coletar agora**).

### "A identidade do servidor mudou"
- Se você reinstalou o servidor, rode `./dashboard reconfigurar` e confira a identidade nova.
- Se não reinstalou, **pare**: pode ser outro aparelho no mesmo endereço.

### "SMART sem permissão" ou "linha da chave desatualizada"
- Um disco novo, outra pasta ou outro serviço mudou depois da instalação:
  `./dashboard reconfigurar` atualiza a linha da chave e a regra do sudo no servidor.

### Porta 3000 já em uso
- Outro programa usa a porta: mude `PORT` no `.env` (ex.: `PORT=3001`).

### Ver os logs
```bash
tail -f data/dashboard.log                  # o painel
journalctl --user -u server-dashboard       # o serviço de usuário
```

---

## FAQ

**Isso é invasivo?** Não. É leitura pura: o servidor só responde um comando por minuto
com métricas do sistema — nenhum arquivo é modificado.

**Afeta o desempenho do servidor?** Muito pouco. Um comando leve a cada 60 s é
irrelevante, até num servidor de 1 núcleo. Todo o trabalho pesado (parse, gráficos,
histórico) roda na sua máquina.

**Preciso de senha?** Só uma vez, na instalação, para preparar o servidor (nunca é
guardada). Depois o painel usa uma chave própria, restrita ao comando de coleta.

**Funciona em qualquer servidor Linux?** Sim, desde que tenha `sshd` ativo e os
comandos padrão (`df`, `ps`, `systemctl`; `smartctl` e `sudo` só para o teste de saúde
dos discos). O assistente descobre discos, rede e serviços sozinho.

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