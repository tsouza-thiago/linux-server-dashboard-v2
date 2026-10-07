# Linux Server Dashboard — Plano da V2

> Status: **plano aprovado por completo em 07/10/2026** · F0 concluída (`2.0.0-alpha.1`) ·
> F1 concluída (`2.0.0-alpha.2`, validada no servidor real em 901 ms) · F2 concluída
> (`2.0.0-alpha.3`, migração validada com o `data/` real da V1) · F3 concluída (`2.0.0-alpha.4`) ·
> próxima: **F4** ·
> base: `v1.0.0` (= `tsouza-thiago/linux-server-dashboard` @ `11a3286`, 196 testes verdes)
>
> Referência visual: canvas "Dashboard V2 — direções de design" (privado, do mantenedor).

---

## 0. Decisões tomadas

| # | Tema | Decisão |
|---|---|---|
| D0 | Onde desenvolver | **Repositório novo** `tsouza-thiago/linux-server-dashboard-v2`, **público**, com **todo o histórico** da V1 copiado e tag `v1.0.0` no ponto de partida. O repositório original **não é tocado** |
| D1 | Design | **Aurora + Cockpit, escuro primeiro** (revisado; substitui o "limpo e arejado"): o tema escuro é o padrão e a referência de todas as decisões de cor; o claro é uma variante gerada dos mesmos tokens. Fontes Geist + Geist Mono servidas localmente; brilho só nas linhas de dados; status sempre com cor + ícone + texto; telemetria em faixas empilhadas com cursor sincronizado. Paleta de séries validada para daltonismo e contraste nos 2 temas; todo texto ≥ 4,5:1. Referência visual: canvas "Dashboard V2 — direções de design" (pranchetas V2 · Visão geral escuro/claro e V2 · Design system) |
| D2 | Gráficos | **uPlot** (1 dependência pequena no lugar de Chart.js + zoom + annotation) |
| D3 | HTTP | **Sem Express**: `node:http` nativo + roteador próprio pequeno → backend com zero dependências |
| D4 | Node.js | **Node 24+** |
| D5 | Retenção | **72 h brutas** (1/min) + **90 dias agregados** (min/máx/média a cada 5 min) |
| D6 | Cortes | Saem as views **Histórico**, **Análise** e **Anotações**. As anotações continuam existindo, só que na timeline de **Eventos** e nos gráficos. A view **Ajuda** e o **índice de saúde** **ficam**, redesenhados |
| D7 | Usuário SSH / SMART | **Usuário comum + sudo apenas para `smartctl -H`** (linha exata por disco no sudoers) |
| D8 | Chave SSH | **Restringida** no servidor com `restrict,command="…"` no `authorized_keys` |
| D9 | Versionar além do código | **Plano V2 + ADRs em `docs/`** e **tags + GitHub Releases**. Ficam de fora, por ora: CI (GitHub Actions) e hook pre-commit |
| D10 | Interface de instalação | **Assistente no navegador** (visual aprovado) + **TUI reserva** no terminal para máquinas sem tela, com os mesmos passos |
| D11 | Configuração do servidor | **As duas, à escolha**: *assistida* (padrão: mostra os comandos exatos, roda numa única conexão após "Confirmar", senha usada uma vez e nunca guardada) ou *guiada manual* (botão Copiar + botão Testar) |
| D12 | Sistemas locais | **Só Linux** na V2.0 (Debian, Ubuntu, Mint, Fedora) com início automático via systemd do usuário |
| D13 | Distribuição | **`git clone`, como hoje**, com tag assinada conferida pelo instalador e sem `npm install` para quem só usa |

---

## 1. Invariantes (não negociáveis — valem para TODA fase)

| # | Princípio (AGENTS.md) | Como a V2 garante |
|---|---|---|
| I1 | **1 único SSH por poll**, comando combinado, sem paralelismo | teste de contrato: runner chamado 1x por ciclo; lock de coleta; "coletar agora" com piso de 5 s; scripts sem SSH de teste redundante |
| I2 | Servidor **não instala nada**, somente leitura | o comando só lê `/proc`, `/sys`, `df`, `systemctl is-active`, `ps` e `sudo -n smartctl -H`; teste que proíbe operações de escrita no comando gerado. As únicas configurações no servidor (usuário `dashmon`, linha no `authorized_keys` e no sudoers) são feitas uma vez, **por você** (modo manual) ou **pelo assistente depois do seu "Confirmar"** (modo assistido), sempre com os comandos exibidos antes e reversíveis |
| I3 | Discos **SMR**: nada de escrita no servidor | SMART só **1x/hora** (dentro do mesmo comando), porque cada `sudo` grava 1 linha de log no servidor |
| I4 | `LC_ALL=C`, não-interativo, `BatchMode=yes`, `ConnectTimeout=10` | mantidos; a V2 lê `/proc` direto (imune a locale) |
| I5 | Dados **sempre ao vivo**, nunca presumidos | campo que falha no parse vira "sem dado", nunca 0 inventado (hoje `load`→`[0,0,0]` e rede→0) |
| I6 | Bind **127.0.0.1** | teste de integração no endereço de escuta |
| I7 | `.env` nunca exibido/commitado; auth por chave | `.gitignore` mantido; teste que falha se `.env` estiver rastreado |
| I8 | Sanitização anti-injeção antes do SSH | mantida + fuzz test |
| I9 | Host check, CSRF, CSP/headers, anti-XSS, CSV seguro, 0700/0600, token timing-safe, rate limit, erros sem stack | **testes de segurança da V1 portados primeiro** (caracterização) e só depois o código é reescrito |
| I10 | Interatividade 100% client-side | nenhuma ação de UI dispara SSH, exceto "coletar agora" |

---

## 2. Diagnóstico da V1

### 2.1 Fica (é o DNA do projeto)
Arquitetura 1 SSH → parse local → histórico local → SSE; `sanitizeToken`/`sanitizeHost`;
`clampPathToData`; Host check; CSP; CSV anti-fórmula; escrita atômica; permissões;
suíte `node:test` sem dependências; `install-lib.sh` testável; fontes self-hosted.

### 2.2 Bugs confirmados (reproduzidos com script no scratchpad)
| ID | Onde | Problema | Impacto |
|---|---|---|---|
| B1 | `poller.js` SMART | `printf '%s:'` sem `\n`; sem root o `smartctl` não imprime nada e a linha vira `sda:sdb:PASSED` | **alerta CRÍTICO falso** `SMART /dev/sda: sdb` |
| B2 | `poller.js` NET | `/proc/net/dev` usa `%6s:%8llu`: com ≥100 MB trafegados o nome cola no número e o parse exige `endsWith(':')`; `grep` casa substrings (`eth0` ⊂ `veth0`) | **Rede sempre 0** em servidor real |
| B3 | `stores.js` reconcile | chave do alerta = mensagem, que contém o valor (`Temperatura CPU 61.2°C`) | **1 alerta novo por poll** (4 polls → 4 alertas); enche o limite de 500 e expulsa os outages |
| B4 | `csv.js` | colunas de I/O: cabeçalho 3, linha 3×N discos | CSV desalinhado com ≥2 discos |
| B5 | `analysis.js` | resumo diário agrupado por dia **UTC** | no Brasil o dia "vira" às 21 h |
| B6 | `sections.js` smartOf | casa SMART com `mount.includes(dev)` | selo SMART por disco quase sempre "—" |
| B7 | `history.js` | reescreve ~6,8 MB de JSON a cada minuto | **~10 GB/dia** no SSD local (o README diz "60–200 escritas/dia") |
| B8 | `history.js` downsample | amostragem por passo descarta picos | gráficos de 24/72 h, máximos e ETA escondem picos |
| B9 | "Uptime 30 dias" | calculado a partir dos alertas (máx. 500, inflado por B3) | número não confiável |
| B10 | `charts.js` anotações | eixo X *category* (`HH:MM:SS`) × valor ISO | anotação fora do instante certo (confirmar no navegador na F0) |
| B11 | `index.js` shutdown | encerra sem `flush()` | última amostra pode se perder |
| B12 | `stop.sh` | fallback `lsof -i :PORT` / `pgrep -f` | pode matar processo alheio |

### 2.3 Dívidas
- Sem CPU% real (só load); CPU% de processo é a média desde que o processo nasceu.
- Temperatura fixa em `thermal_zone0`; `df` roda 2x; `df` em caminho que não é mount reporta o mount pai.
- Limiares duplicados (poller 90/90/60 × health score 75/80/70/1.5×) e não configuráveis; offline alerta na 1ª falha (flapping).
- Token na URL do SSE e pedido por `prompt()`; 401 no SSE em loop silencioso; sem backfill após reconexão.
- Todos os gráficos recalculam a cada amostra, inclusive os de views ocultas.
- CSS: 16 variáveis legadas com **0 usos**; 21 referências a `UI_DESIGN_SYSTEM.md`, que não existe.
- `engines: node >=18` (fora de suporte); `npm audit`: 1 crítica + 3 moderadas (transitivas do Express 4).
- Docs triplicadas (README 617 + TUTORIAL 509 + AGENTS 291 + Ajuda) e divergentes; `dashboard.log` sem rotação.
- Versão `1.0.0` fixa, sem tags e sem CHANGELOG, e um commit "`modified: .gitignore`".
- Histórico (já público) contém um IP da rede local e o e-mail pessoal do autor. Não será reescrito (D0 preserva o histórico), mas a V2 passa a usar só IPs de documentação (`192.0.2.x`, RFC 5737).

---

## 3. Escopo da V2

### Sai
Views Histórico, Análise e Anotações (o conteúdo é redistribuído); Express; Chart.js e
plugins; aliases CSS mortos; referências a docs inexistentes; `prompt()`; `df -h`
duplicado; `grep` em `/proc/net/dev`; dependência de `free`.

### Fica, com testes portados 1:1
Toda a segurança, o instalador com assistente, `start`/`stop`, systemd de usuário,
alertas com ciclo de vida, anotações, export CSV/JSON, temas claro/escuro, SSE, Ajuda e índice de saúde.

### Melhora
- **Alertas**: chave estável por condição (`disk:/mnt/x:usage`) com valor atualizado no mesmo alerta; histerese (dispara 90 / limpa 85); debounce do offline (padrão: 2 falhas seguidas); limiares no `.env` validados pelo `config.js`; **uma única fonte de regras**, usada pelo poller, pelo índice de saúde e pela UI.
- **Índice de saúde**: derivado das mesmas regras, vira a manchete da tela inicial ("Servidor saudável ✓" / "Atenção" / "Crítico") com o porquê em linguagem simples. O número 0–100 fica como detalhe.
- **Outages**: log próprio de transições online/offline, base de um uptime de 90 dias confiável.
- **Histórico**: append-only + agregação por balde (min/máx/média) no servidor.
- **Auth**: o token é trocado 1x por cookie de sessão HttpOnly + SameSite=Strict; acabam o `?token=` e o `prompt()`, e entra uma tela de login.
- **Config**: avisos claros no boot para valores rejeitados (hoje são descartados em silêncio).
- **Log** com rotação; shutdown com `flush()`; `stop.sh` só mata o PID que registrou, conferindo o comando; systemd com hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=data/`, `PrivateTmp`).

### Entra: métricas novas, todas leitura barata no MESMO comando
| Métrica | Fonte | Por quê |
|---|---|---|
| CPU % real (user/system/**iowait**/steal) | `/proc/stat` (delta) | iowait é o sintoma nº 1 de disco SMR sofrendo |
| % util e latência de disco | `/proc/diskstats` (já lido hoje) | disco saturado mesmo com MB/s baixo |
| Pressão PSI cpu/mem/io | `/proc/pressure/*` | melhor indicador de "engasgo" em 1 núcleo |
| Inodes | mesma chamada do `df` | disco "cheio" que ainda tem espaço livre |
| Todos os sensores | `/sys/class/thermal/thermal_zone*/{type,temp}` | escolher o sensor certo pelo nome |
| Device de cada mount | `df --output=source` | mount → disco → SMART (corrige B6) |
| RAM detalhada | `/proc/meminfo` | sem locale; Dirty/Writeback são úteis para SMR |
| Erros e descartes de rede | mesma linha do `/proc/net/dev` (já lida) | mostrados na tela Rede |
| Latência média de disco | campos de tempo do `/proc/diskstats` (já lido) | "38 ms" na tela Armazenamento |
| RSS e tempo de vida dos processos | `ps -eo …,rss,etimes` (mesmo `ps`, outras colunas) | tela Processos; saída menor que o `ps aux` atual |

### SSH endurecido (D7 + D8)
- O instalador **gera e mostra** dois textos para você colar no servidor, sem executar nada lá sozinho:
  1. a linha `restrict,command="<comando de coleta>" ssh-ed25519 AAAA… linux-server-dashboard` para o `authorized_keys`;
  2. a linha do sudoers com **cada disco listado explicitamente**: `usuario ALL=(root) NOPASSWD: /usr/sbin/smartctl -H /dev/sda, /usr/sbin/smartctl -H /dev/sdb`. Não pode ter curinga, porque no sudoers `*` também casa espaços e permitiria passar outras opções ao `smartctl`.
- O comando forçado imprime `===VER===<hash da config>`. Se o `.env` mudar (outro disco, outro serviço), o dashboard detecta a divergência e avisa: "atualize a linha do authorized_keys (`./install.sh --key-line`)".
- `sudo -n` sem permissão vira SMART "sem permissão", sem alerta.

### Telas (8)
1. **Visão geral**: manchete de saúde, 4–6 cartões grandes (processador, memória, disco mais cheio, temperatura, rede) com sparkline e frase simples ("enche em ~90 dias"), eventos recentes.
2. **Recursos**: CPU% com iowait, load, RAM/swap, PSI, temperatura, pressão de RAM.
3. **Armazenamento**: espaço, inodes, ETA, I/O, %util, SMART por disco.
4. **Rede**: throughput e totais.
5. **Processos & serviços**.
6. **Eventos**: timeline única de alertas + anotações + outages, com filtros, criação de anotação e uptime de 90 dias.
7. **Relatórios**: resumo diário (fuso local) e export CSV/JSON.
8. **Ajuda**: guia em linguagem simples, versão do app, configuração ativa (somente leitura, sem segredos) e link para o TUTORIAL.

### Design (D1 — aprovado em princípio)

**Identidade.** Aurora + Cockpit, escuro primeiro. "Ferramenta robusta" vem da faixa técnica
no topo, da telemetria em faixas com cursor sincronizado e dos números em mono. O "brilho"
vem do halo luminoso só nas linhas e nos indicadores de dado, nunca no fundo.

**Regras de uso**
1. O tema escuro é o padrão e a referência de todas as decisões; o claro é derivado dos mesmos tokens (nunca o contrário).
2. A cor segue a métrica, em todas as telas: CPU = ciano, RAM = violeta, I/O/disco = magenta, temperatura = azul.
3. As cores de status (saudável, atenção, grave, crítico) são reservadas e sempre vêm com ícone + texto.
4. Brilho: ligado no escuro, desligado no claro e quando o sistema pede "reduzir movimento/transparência".
5. Todo texto ≥ 4,5:1 nos dois temas; alvos de toque ≥ 44 px; anel de foco ciano visível.
6. Offline não apaga a tela: últimos valores em cinza, faixa crítica no topo, horário da última coleta boa e contagem para a nova tentativa.

**Tokens** (vão para `public/css/tokens.css`; valores medidos)

| Papel | Escuro (padrão) | Claro (variante) |
|---|---|---|
| Fundo / lateral / cartão | `#07090E` / `#0A0E15` / `#0F141D` | `#F3F5F8` / `#FFFFFF` / `#FFFFFF` |
| Elevado / trilho | `#151C28` / `#1D2635` | `#F1F3F7` / `#E5E9EF` |
| Texto principal / secundário / legenda | `#EDF1F7` 16,3:1 · `#A9B4C5` 8,8:1 · `#8390A4` 5,7:1 | `#0B0F17` 19,2:1 · `#475163` 8,0:1 · `#5B6576` 5,9:1 |
| Destaque (UI) | `#3EE0D0`, texto `#5EEBDD` 12,7:1 | `#0B8FA3`, texto `#087686` 5,3:1 |
| Séries 1–4 (ordem fixa) | `#0E9CB0` `#8064F0` `#D84B8A` `#3F86E8` | `#0B8FA3` `#6D4FE0` `#D23F7E` `#2F6FD6` |
| Status | ok `#34D399` · atenção `#F5B83D` · grave `#F97A4A` · crítico `#F0525C` | tinta ok `#0A6E3E` · atenção `#8A5A00` · crítico `#B42330` |

As séries passaram no validador de daltonismo e contraste nos dois temas (vizinhas: todas as
4; todas contra todas: as 3 primeiras).

**Tipografia.** Geist (texto) + Geist Mono (números e dados), licença OFL, `.woff2` em
`public/fonts/` (sem CDN). Escala: manchete 34 · título 28 · seção 16 · corpo 15/14 ·
legenda 12; números grandes 38 mono. Espaço 4/8/12/16/24/32; raios 8/12/18/22;
movimento 150–200 ms.

**Status das telas no canvas**

| Tela / estado | Status |
|---|---|
| Visão geral (escuro + claro) e design system | ✅ aprovados em princípio (07/10/2026) |
| Recursos, Armazenamento, Rede, Processos & serviços, Eventos, Relatórios, Ajuda | ✅ aprovadas (07/10/2026) |
| Estados: offline, carregando, primeiro uso, alerta crítico, aviso de configuração, confirmações | ✅ aprovados (07/10/2026) |
| Login (com estado de erro) e celular (390 px: visão geral, telemetria, menu) | ✅ aprovados (07/10/2026) |
| Componentes compartilhados: navegação e faixa de status (online / coletando / offline) | ✅ aprovados — base de todas as telas |

Todas as telas novas têm o Tweak **Tema** (escuro/claro) e usam os mesmos tokens.

**Comportamentos de interface definidos pelo desenho** (entram na F5/F6)
- Atalhos: `1`–`8` telas · `C` coletar · `T` tema · `N` nova anotação · `/` buscar · `?` ajuda.
- Gráficos: roda = zoom, arrastar = selecionar intervalo, duplo clique = voltar; cursor sincronizado entre faixas.
- Confirmações rápidas no canto inferior direito (4 s, com "Desfazer" quando fizer sentido).
- Offline: últimos valores em cinza + faixa crítica + motivo + contagem para nova tentativa.
- Carregamento com blocos no formato final; primeiro uso com checklist (CPU/rede só após 2 coletas; ETA após ~1 dia).
- Eventos: filtros por tipo e situação, "Reconhecer", "Remover" anotação, "ver no gráfico", paginação de antigos.
- Ajuda: configuração ativa só leitura, estado da chave restrita e do sudo, linha do sudoers pronta para copiar, versão, sessão (Sair / encerrar todas).

---|---|
| Visão geral (escuro + claro) | ✅ aprovada em princípio |
| Design system (fundação) | ✅ aprovado em princípio |
| Recursos, Armazenamento, Rede, Processos & serviços, Eventos, Relatórios, Ajuda | ⏳ a desenhar |
| Estados: offline, carregando, vazio (1º uso), erro, alerta crítico | ⏳ a desenhar (offline já esboçado no design system) |
| Login (token), celular (≤ 480 px), tablet | ⏳ a desenhar |

---

## 4. Arquitetura V2

```
[Servidor]  ← 1 SSH/poll (comando forçado no authorized_keys)
      ↑
server/collector/   probes/{host,cpu,mem,disk,net,io,temp,smart,services,procs,psi}.js
                    cada probe = { id, command(cfg), parse(lines, ctx) } + fixtures
                    builder.js · runner.js (spawn ssh) · rates.js (deltas)
server/alerts/      rules.js (declarativo, limiares do config) · engine.js · health.js
server/storage/     ndjson.js (append, 1 arquivo/dia) · rollup.js (5 min, 90 d)
                    outages.js · alerts.js · annotations.js · migrate-v1.js · meta.json
server/http/        server.js · router.js · static.js · sse.js
                    security/{host,csrf,headers,session,ratelimit}.js
server/config.js    parser único do .env + schema + validação + avisos
server/version.js   versão do app, do schema da amostra e do comando de coleta
      ↓
public/css/         tokens.css · base.css · components.css · views.css
public/js/          ES modules nativos, sem bundler e sem build:
                    core/{store,api,sse,router,html,format}.js · charts/ (uPlot) · views/ · components/
```

- **Escape automático**: um template `html\`…\`` escapa toda interpolação, e HTML cru só entra via `raw()`, explícito e auditável.
- Eixo de tempo real; buracos visíveis nos períodos offline; só a view ativa renderiza.
- Período na URL (`#/armazenamento?p=24h`); backfill após reconexão do SSE.
- Amostra com `schemaVersion: 2`; amostras v1 continuam legíveis.
- Armazenamento medido na F2 (amostra real: 4 mounts, 3 discos): 72 h brutas ≈ 16 MB (3,7 KB/min) + 90 d agregados ≈ 29 MB (1,2 KB a cada 5 min), em vez de reescrever ~6,8 MB/min.

---

## 5. Testes ("testar a cada alteração")

Sem CI e sem hook (D9), a disciplina fica no fluxo: **`npm run check` antes de todo
commit** (testes + cobertura + `npm audit` + `bash -n`), e nenhum commit vermelho.

1. **Caracterização**: testes da V1 que precisam continuar valendo (segurança, sanitização, API) são portados primeiro.
2. **Bugs**: um teste vermelho para cada B1–B12, antes da correção.
3. **Goldens do parser**: fixtures reais do Debian 12/13 (anonimizadas) por probe, incluindo contador colado, sem SMART, sem permissão, serviço inexistente, sensor ausente e saída truncada.
4. **Fuzz/propriedade** (sem libs): `sanitizeToken` e o parser "nunca lançam, nunca inventam valor".
5. **Contrato do comando**: sem caractere fora da whitelist, sem operações de escrita, tamanho máximo, hash estável.
6. **SSH falso**: binário `ssh` fake no `PATH` (timeout, exit 255, host key, saída parcial, hash divergente).
7. **HTTP**: porta efêmera, sessão/cookie, CSRF, SSE com backfill.
8. **Frontend**: módulos com DOM falso + **e2e e screenshots no Chromium** (Playwright como devDependency), nos 2 temas, desktop e mobile.
9. **Cobertura** nativa (`--experimental-test-coverage`), com piso subindo a cada fase.
10. **Soak**: 72 h contra o servidor real antes do release.

---

## 6. Versionamento ("absolutamente tudo")

| O quê | Como |
|---|---|
| Código | SemVer. `v1.0.0` = estado atual importado. Depois `v2.0.0-alpha.N` (1 por fase) → `beta.N` → `rc.N` → `v2.0.0`, cada uma com **GitHub Release** e notas do CHANGELOG |
| Commits | Conventional Commits em PT-BR (`feat(collector):`, `fix(alerts):`, `test:`, `docs:`, `refactor:`, `style:`, `perf:`, `chore:`, `security:`), 1 mudança lógica por commit, sempre verde |
| Mudanças | `CHANGELOG.md` (Keep a Changelog), atualizado no mesmo commit |
| Decisões | `docs/PLANO_V2.md` (este documento) + `docs/adr/NNNN-*.md`. ADRs iniciais: 0001 repo novo com histórico · 0002 Node 24 · 0003 HTTP sem Express · 0004 uPlot · 0005 NDJSON 72h/90d · 0006 motor de alertas · 0007 sessão por cookie · 0008 SSH restrito + sudo smartctl · 0009 design limpo e arejado · 0010 ES modules sem build |
| Versão em runtime | fonte única `package.json` → `/api/status`, Ajuda e log de boot |
| Dados | `schemaVersion` na amostra; `data/meta.json` + migrações numeradas e idempotentes com backup do v1 |
| Comando de coleta | `COLLECTOR_VERSION` + hash da config, gravados na amostra |
| `.env` | `.env.example` com seção "mudou na versão X"; o boot avisa sobre variáveis obsoletas/novas |
| Dependências | versões exatas (sem `^`), lockfile versionado |

---

## 7. Roadmap

**Antes do código (etapa atual, sem tocar em repositório):**

| Etapa | Entrega | Saída |
|---|---|---|
| **P1 — Design** ✅ em princípio | direções, escolha, Visão geral + design system | aprovado em 07/10/2026 |
| **P2 — Decisões** ✅ | rodada da seção 10 | todas aceitas em 07/10/2026 |
| **P3 — Telas e estados** ✅ | 7 telas + estados + login + celular + componentes | aprovadas em 07/10/2026 |
| **P3b — Instalação** ✅ | decisões D10–D13 + seção 11 + telas do assistente | aprovadas em 07/10/2026 |
| **P4 — Gate final** ✅ | checklist da seção 12 | "pode começar" em 07/10/2026 → F0 |

**Depois do sinal verde:** cada fase termina com testes verdes, CHANGELOG atualizado, tag + Release `alpha` e o dashboard **funcionando** (sem "big bang").

| Fase | Entrega | Critério de saída |
|---|---|---|
| **F0 — Base** ✅ | criar `linux-server-dashboard-v2` com histórico; tag `v1.0.0`; CHANGELOG; `docs/` + ADRs; `npm run check`; reorganizar `test/{unit,integration,e2e}`; testes de B1–B12 marcados como `todo` do `node:test` (reproduzem o bug sem deixar a suíte vermelha; o `todo` sai no commit que corrige); **você roda o comando de coleta 1x no servidor** para eu capturar fixtures | suíte organizada; bugs documentados por testes |
| **F1 — Coleta** ✅ | probes, builder, parser v2, taxas (CPU%, util, rede e SMART corrigidos), hash/versão | goldens verdes; `--once` funciona no servidor real |
| **F2 — Armazenamento** ✅ | NDJSON + rollups 90 d + migração v1 + `/api/history` com baldes | migração testada com `data/` real da V1 |
| **F3 — Alertas** ✅ | motor com chave estável, histerese e debounce; limiares no `.env`; outages; health derivado | B3/B9 resolvidos; testes de flapping |
| **F4 — HTTP** | `node:http`, sessão por cookie, SSE com backfill, segurança portada | testes de segurança V1 + novos verdes; `npm audit` limpo |
| **F5 — Fundação do front** | ES modules, store, router, `html` com escape, uPlot | e2e abre todas as views |
| **F6 — Design** | implementar em CSS/JS o design system **já aprovado no canvas** (tokens, componentes, estados, AA nos 2 temas, teclado, mobile, `prefers-reduced-motion`) + 8 telas | screenshots do Chromium comparados com as pranchetas aprovadas + **sua revisão visual** |
| **F7 — Instalação** | comando `dashboard`, assistente no navegador + TUI reserva, detecção automática, configuração do servidor assistida/manual, SSH isolado, tag assinada, atalho e systemd de usuário, atualizar/desinstalar, upgrade V1→V2 | instalação de ponta a ponta numa VM Debian e numa Ubuntu limpas (sem git? sem Node?) + upgrade testado numa cópia de `data/` da V1 |
| **F8 — Docs** | README enxuto, TUTORIAL, AGENTS e SECURITY (threat model com SSH restrito e sudo) → `beta` | docs batem com o código |
| **F9 — Release** | soak de 72 h → `rc` → `v2.0.0` | dentro do orçamento (tempo do comando no servidor, saída, RAM/CPU local) |

---

## 8. Fora de escopo
Multi-servidor, notificações externas (e-mail/Telegram), acesso remoto ao dashboard,
agente no servidor, banco de dados, framework de frontend, bundler/transpilador, CI e hook (D9, podem voltar depois).

## 9. Premissas — ✅ confirmadas (07/10/2026)
- Nome do repo: `linux-server-dashboard-v2`.
- Código, commits, docs e UI em PT-BR (como hoje).
- Limiares padrão iguais aos da V1 (disco 90%, RAM 90%, temp 60 °C), agora configuráveis.
- Offline só alerta após 2 falhas seguidas (≈2 min).
- Tema padrão é **sempre o escuro**, mesmo se o sistema operacional estiver no claro; o claro só aparece quando a pessoa escolhe (a escolha fica salva no navegador).
- SMART checado 1x/hora (não muda de minuto em minuto e evita log de sudo a cada poll).

---

## 10. Decisões da rodada P2 — ✅ todas aceitas (07/10/2026)

Todas as recomendações abaixo foram aceitas como estão e passam a valer como decisões.

### 10.1 Produto e experiência
| # | Decisão | Decisão |
|---|---|---|
| Q1 | Suporte a celular | **Consulta completa**: todas as telas legíveis no celular (menu vira gaveta, faixas de telemetria rolam), sem recursos de edição exclusivos de desktop |
| Q2 | Notificações | **Notificação do próprio navegador** (opt-in) para alertas críticos e para servidor offline. É local, sem serviço externo; e-mail/Telegram continuam fora de escopo |
| Q3 | Onde editar limiares e serviços | **Só no `.env`** (fonte única, validada pelo `config.js`); a UI mostra a configuração ativa em modo somente leitura e diz qual variável mudar. Editar pela UI exigiria a API gravar o `.env`, o que amplia a superfície de ataque |
| Q4 | Sessão de login | Token pedido **1x por navegador**, sessão por cookie válida por **30 dias** (renovada com o uso), com botão "Sair" e "encerrar todas as sessões" |
| Q5 | Relatórios | Manter CSV e JSON e adicionar uma **versão para impressão/PDF** do resumo diário (CSS de impressão, sem dependência nova) |
| Q6 | Idioma | **Só PT-BR**, mas com todos os textos da UI num único arquivo (`public/js/core/strings.js`), o que deixa a porta aberta para outro idioma sem refazer telas |
| Q7 | Marca | Nome exibido **"Server Dashboard"**, ícone de pulso atual em ciano; o repositório continua `linux-server-dashboard-v2` |

### 10.2 Servidor e segurança
| # | Decisão | Decisão |
|---|---|---|
| Q8 | Usuário dedicado no servidor | Nome **`dashmon`**, sem senha (só chave), shell `/bin/sh`; o TUTORIAL traz os 4 comandos para você criar, uma vez, à mão |
| Q9 | Teste de conexão no instalador | Com a chave restrita, o teste passa a ser "rodar a coleta uma vez" e conferir a saída; nenhuma conexão extra além disso |
| Q10 | Hash divergente (config ≠ `authorized_keys`) | O dashboard **continua coletando** o que o comando forçado entrega e mostra um aviso fixo até a linha ser atualizada (em vez de parar) |

### 10.3 Operação e migração
| # | Decisão | Decisão |
|---|---|---|
| Q11 | Transição V1 → V2 | **Nunca rodar as duas ao mesmo tempo** (seriam 2 SSH/min, quebrando o I1): no soak, a V1 é parada, a V2 importa `data/` da V1 (com backup) e a V1 fica pronta para voltar se algo falhar |
| Q12 | Fixtures reais (F0) | Você roda o comando de coleta 1x no servidor e me envia a saída; eu anonimizo (host, IPs, nomes de usuário) antes de versionar. Nada de saída real crua no repositório público |
| Q13 | Intervalo de coleta | Mantém **60 s** como padrão (mínimo 10 s); a V2 mede e mostra o custo real de cada coleta no servidor |

### 10.4 Engenharia e qualidade
| # | Decisão | Decisão |
|---|---|---|
| Q14 | Navegadores suportados | Chrome/Edge, Firefox e Safari, **2 últimas versões** (permite ES modules, `<dialog>`, CSS moderno sem polyfill) |
| Q15 | Playwright | Entra só como **devDependency** (testes e2e e screenshots); nada dele no runtime |
| Q16 | Piso de cobertura | Começa em **80%** no backend na F1 e sobe para **90%** até o `beta`; frontend medido pelos e2e |
| Q17 | Orçamento de desempenho | Comando no servidor **≤ 1,5 s** e **≤ 16 KB** de saída; página inicial **≤ 300 KB** transferidos; Node local **≤ 80 MB** de RAM |

---

## 11. Instalação V2 (P3b)

### Fluxo para um leigo
1. **Terminal, uma vez:** copiar e colar `git clone … && cd … && ./dashboard instalar`.
   O instalador confere a assinatura da versão, prepara tudo **sem sudo** e abre o navegador sozinho.
2. **Navegador — assistente em 6 passos** (servido em 127.0.0.1, protegido por código de uso único, desligado ao terminar):
   1. **Boas-vindas**: o que será feito, o que *não* será feito (nada instalado no servidor, nada de sudo nesta máquina).
   2. **Servidor**: endereço (IP ou nome) + usuário administrador; ajuda "como descubro o IP".
   3. **Conectar**: confirma a identidade do servidor (impressão digital da chave) e pede a senha **uma vez**.
   4. **O que monitorar**: discos, pastas, interface de rede e serviços **detectados automaticamente**, em caixinhas; limiares padrão já preenchidos. Vem antes do passo 5 porque a linha restrita da chave e a do sudo são geradas a partir destas escolhas.
   5. **Preparar o servidor**: escolha *assistida* (mostra os comandos exatos → "Confirmar") ou *manual* (Copiar/Testar, passo a passo).
   6. **Pronto**: teste de coleta real, atalho no menu de aplicativos, "iniciar com o computador" ligado, painel aberto já logado (link de uso único).
3. **Depois:** ícone "Server Dashboard" no menu; nenhum terminal precisa ficar aberto.

**TUI reserva** (`./dashboard instalar --terminal`): os mesmos 6 passos com menus e setas, feita sem dependências; e
`--sem-interface` com variáveis/flags para quem automatiza.

### Segurança da instalação
| Medida | Detalhe |
|---|---|
| Versão conferida | tags assinadas (`git verify-tag` com chave SSH do projeto em `allowed_signers` versionado); instalador recusa versão sem assinatura válida |
| Sem `npm install` para quem usa | uPlot e fontes ficam versionados no repositório com soma SHA-256; Playwright e afins só em `devDependencies` |
| Zero sudo local | tudo dentro da pasta do projeto — dados, configuração SSH e `known_hosts` em `data/` (0700), como manda a regra de caminhos do `config.js`; só a chave fica em `~/.ssh/dashboard_ed25519` (0600); serviço systemd **de usuário** com hardening |
| SSH isolado | arquivo de configuração e `known_hosts` **próprios** em `data/ssh/` (`ssh -F`); o `~/.ssh/config` do usuário não é tocado; troca de identidade do servidor gera alerta claro |
| Chave dedicada | Ed25519 nova, 0600, com `restrict,command="…"` e opção `from="<IP desta máquina>"` |
| Senha do servidor | digitada uma vez, repassada ao SSH só em memória (helper de askpass), nunca gravada nem em log; o mesmo vale para a senha do sudo no servidor |
| Assistente temporário | só existe até o fim da 1ª configuração; código de uso único; mesmas proteções do painel (Host check, CSRF, CSP) |
| Comandos no servidor | sempre exibidos antes; sudoers gravado em `/etc/sudoers.d/dashboard` e validado com `visudo -c` antes de ativar; tudo reversível por "Remover acesso do painel" |
| Detecção automática | 1 conexão de leitura durante a instalação (`lsblk`, `df`, `ip -o link`, `systemctl list-units`); não conta para o regime de 1 SSH/min, que vale para a coleta |

### Comando único `dashboard` (substitui install.sh / start.sh / stop.sh)
| Comando | O que faz |
|---|---|
| `dashboard instalar` | primeira instalação (abre o assistente) |
| `dashboard abrir` | abre o painel no navegador |
| `dashboard iniciar` / `parar` / `status` | controle do serviço |
| `dashboard diagnosticar` | testa Node, permissões, SSH, chave restrita, sudo e coleta; explica cada falha em português simples |
| `dashboard reconfigurar` | reabre o assistente (trocar servidor, discos, serviços) |
| `dashboard atualizar` | `git fetch` + tag assinada + backup de `data/` + migração + volta atrás sozinho se falhar |
| `dashboard desinstalar` | remove serviço, atalho e arquivos locais; oferece limpar o servidor (usuário, chave, sudoers) |

### Telas do assistente no canvas — ✅ aprovadas (07/10/2026)
| Prancheta | Conteúdo |
|---|---|
| Instalação · 1 comando no terminal | comando único com Copiar; saída do `./dashboard instalar` (assinatura, Node 24 conferido, `data/` 0700, código de uso único) e exemplo do `dashboard diagnosticar` com causa + solução |
| 1 Boas-vindas | o que fazemos / o que nunca fazemos / o que ter em mãos; verificações deste computador |
| 2 Servidor | endereço com teste de alcance, usuário administrador, porta em "avançado", ajuda para achar o IP |
| 3 Conectar | identidade do servidor em blocos para comparar + como conferir; senha usada uma vez; aceita chave já existente |
| 4 O que monitorar | discos/pastas com SMART por disco, rede (radio), serviços detectados, limiares, resumo com custo estimado |
| 5 Preparar o servidor (assistido) | 5 ações em linguagem simples, opção `from=` (só deste computador), comandos exatos visíveis; Tweak de estado revisar/executando/concluído |
| 5 Preparar o servidor (manual) | 4 blocos com Copiar + Testar, erro explicado quando falta algo, Continuar só após tudo conferido |
| 6 Pronto | primeira leitura real, preferências (iniciar com o computador, atalho, notificações), o que foi criado e como desfazer, token de reserva "mostrar uma vez" |
| TUI reserva | mesmo passo 4 em terminal, com teclas de navegação |
| Componente · Passos | indicador dos 6 passos (concluído / agora / a seguir) |

**Ajuste de ordem:** "O que monitorar" passou a ser o passo 4 e "Preparar o servidor" o passo 5, porque a linha
restrita da chave e a regra de sudo são geradas a partir das escolhas de monitoramento.

### Decisões da instalação — ✅ Q18–Q20 aceitas (07/10/2026)
| # | Questão | Decisão |
|---|---|---|
| Q18 | Node 24 com `git clone` | Se o Node do sistema faltar ou for antigo, o instalador **baixa o Node 24 oficial para dentro da pasta** (soma SHA-256 conferida), sem sudo |
| Q19 | `git` ausente (comum em desktop recém-instalado) | O README traz o comando de 1 linha para instalar o git da distro; o resto continua sem sudo |
| Q20 | Telas do assistente | Desenhar no canvas os 6 passos + versão TUI antes do gate final |

---

## 12. Gate de decisão final (P4)

O código só começa quando todos os itens estiverem marcados:

- [x] Seção 10 respondida (Q1–Q17) — todas as recomendações aceitas
- [x] Pranchetas aprovadas: 7 telas restantes, estados, login e celular (07/10/2026)
- [x] Instalação (seção 11): Q18–Q20 decididas (07/10/2026)
- [x] Telas do assistente de instalação aprovadas (07/10/2026)
- [x] Premissas da seção 9 confirmadas
- [x] Plano aprovado como "versão 1.0 do plano" (este arquivo e as ADRs em `docs/adr/`)
- [x] **"Pode começar"** dado em 07/10/2026
