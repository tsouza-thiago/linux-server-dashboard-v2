# Changelog

Todas as mudanças relevantes deste projeto ficam registradas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto
usa [Versionamento Semântico](https://semver.org/lang/pt-BR/). A V2 é publicada em
pré-versões `2.0.0-alpha.N` (uma por fase do plano), depois `beta`, `rc` e `2.0.0`.

## [Não publicado]

### Adicionado

- Ajuda do painel: modo de acesso (`SSH_ACESSO`) e discos com SMART (`SMART_DEVS`) na
  configuração ativa; `/api/config` passa a informar o modo de acesso.

### Alterado

- Ajuda do painel: a linha do sudoers usa os discos de `SMART_DEVS`; "para mudar, rode
  `./dashboard reconfigurar`" no lugar de editar o `.env`.

### Segurança

- A resposta do SSH tem limite de 1 MB (`MAX_OUTPUT_BYTES`). Um servidor comprometido que
  responde sem parar não enche mais a memória desta máquina: a conexão é cortada e a coleta
  falha com o motivo.

## [2.0.0-alpha.8] — 2026-10-08

Fase F7 do plano (instalação). Um comando no terminal abre um assistente de 6 passos no
navegador (ou no terminal) que prepara o servidor com um usuário próprio e uma chave
restrita à coleta. Instalação de ponta a ponta validada em contêineres Debian 12 e Ubuntu
24.04 limpos (sem Node), e upgrade da V1 com o `data/` gerado pela própria V1.

### Adicionado

- **`./dashboard`** (ADR 0011), comando único que substitui `install.sh`, `start.sh` e
  `stop.sh`: `instalar`, `abrir`, `iniciar`, `parar`, `status`, `diagnosticar`,
  `reconfigurar`, `atualizar`, `desinstalar`, `versao`. Sem Node 24 no sistema, baixa o
  Node 24.21.0 oficial para `.runtime/` com a soma SHA-256 fixada (Q18), sem sudo.
- **Assistente no navegador** (D10), fiel às pranchetas: boas-vindas, servidor (alcance da
  porta), conectar (identidade do servidor em blocos antes da senha), o que monitorar
  (detecção automática de pastas, discos, rede e serviços, SMART por disco, limiares e
  custo estimado), preparar o servidor (assistido com os comandos exatos ou à mão com
  Copiar/Testar) e pronto (primeira leitura, preferências e token de reserva mostrado uma
  vez). Servidor temporário em 127.0.0.1 com código de uso único e as proteções do painel.
- **TUI reserva** (`--terminal`) com os mesmos passos e **`--sem-interface`** para
  automatizar (exige `--identidade` e lê a senha só do stdin).
- **Acesso restrito** (ADR 0008): usuário `dashmon` sem senha; `authorized_keys` com
  `restrict,from=,command=` (escape conferido contra o OpenSSH); sudoers com um
  `smartctl -H` por disco, sem curinga, validado com `visudo -cf`. `SSH_ACESSO=restrito`
  faz o painel enviar só a palavra do modo.
- **SSH isolado**: `SSH_CONFIG=data/ssh/config` (`ssh -F`) com `known_hosts` próprio e
  `StrictHostKeyChecking yes`; o `~/.ssh/config` da pessoa não é tocado.
- `SMART_DEVS`: discos com teste de saúde separados dos discos de I/O (`DISK_DEVS`).
- Serviço systemd **de usuário** com hardening (refeito sem ele se o sistema não deixar),
  atalho "Server Dashboard" no menu e link de entrada de uso único (`/entrar`) para abrir o
  painel já logado.
- **Versões assinadas** (ADR 0012): tags conferidas com `docs/allowed_signers`; num clone do
  branch principal o instalador fixa na tag assinada mais nova; `atualizar` confere a
  versão nova com a lista da versão instalada, faz backup de `data/` e volta atrás sozinho
  se a nova não subir. Chave do mantenedor: `tsouza-thiago`
  (`SHA256:g4S28XtDHDCsoRtHVAQAl7RGh5+iB9uCR0dtHuwM2x8`).
- `diagnosticar` explica cada problema ("O que aconteceu / Como resolver") usando a última
  amostra gravada, sem SSH extra; `desinstalar` oferece limpar o servidor.
- **Upgrade V1 → V2**: `./dashboard instalar --importar-v1 <pasta>` para a V1, traz o `.env`
  saneado e os dados (histórico convertido com backup, alertas, anotações) e liga a V2; a
  pasta da V1 fica intacta.
- Log do painel com rotação (5 MB → `dashboard.log.1`).
- `scripts/e2e-instalacao/rodar.sh`: instalação de ponta a ponta em contêineres.

### Corrigido

- **B12**: `parar` só encerra o PID que o painel registrou, conferido em `/proc`; sem
  procurar pela porta ou pelo nome. Nenhum bug da V1 continua aberto.

### Alterado

- `engines.node` agora é `>=24` (ADR 0002).
- No comando forçado, o pedido do cliente só escolhe entre `smart` e `basico`; qualquer
  outro texto vira `basico` e nunca é ecoado.

### Removido

- `install.sh`, `install-lib.sh`, `start.sh` e `stop.sh` (a validação das entradas foi
  portada para `server/setup/acesso.js`, com os mesmos casos de teste).

## [2.0.0-alpha.7] — 2026-10-07

Fase F6 do plano (design). O design system aprovado no canvas (Aurora + Cockpit, escuro
primeiro) entra nas 8 telas, nos estados, no login e no celular. Contraste AA conferido
por teste nos dois temas; capturas do Chromium comparadas com as pranchetas. Falta a
revisão visual do mantenedor (critério de saída da F6).

### Adicionado

- Amostra registra o custo da coleta no servidor: `collector.durationMs` (tempo do SSH) e
  `collector.outputBytes` (tamanho da saída), mostrados na faixa de status.
- Histórico guarda a CPU separada em usuário e sistema (`cpuUser`, `cpuSystem`) para o
  gráfico empilhado de Recursos.
- `/api/session` informa quando a sessão expira (`expiresAt`); `/api/login` aceita
  `remember: false` ("Manter conectado" desmarcado: cookie some ao fechar o navegador).
- `/api/config` informa a retenção do histórico e a versão do Node.
- **Design system V2 (D1, Aurora + Cockpit, escuro primeiro)** implementado das pranchetas
  aprovadas: tokens em `public/css/tokens.css` (escuro padrão e claro com os mesmos nomes),
  `base.css`, `components.css`, `views.css` e `print.css`.
- Fontes Geist e Geist Mono 1.7.2 (OFL) servidas de `public/fonts/`, com SHA-256 em
  `public/vendor/vendor.json`.
- Navegação agrupada (Monitorar / Analisar) com contagem de alertas, "Próxima coleta" com
  contagem regressiva, faixa de status (online / coletando / offline / reconectando) com
  host, sistema, uptime, idade da coleta, custo do SSH e retenção.
- Visão geral: anel de saúde 0–100, frase em linguagem simples, disponibilidade de 90
  dias, eventos de 24 h e custo no servidor; 5 indicadores com mini-gráfico; telemetria em
  faixas com cursor, dica e zoom sincronizados; resumos de armazenamento, eventos e
  processos.
- Recursos: CPU empilhada (usuário, sistema, espera de disco), carga, memória com média,
  pico, tendência e swap, temperatura com o limite e os sensores, pressão (PSI) em faixas.
- Armazenamento: cartões por ponto de montagem, previsão de lotação com projeção e datas
  (alerta e cheio), atividade de cada disco em faixas e saúde SMART com o histórico.
- Rede: download e upload com o pico do período, volume do dia, erros e descartes,
  volume por dia (7 dias) e maiores picos.
- Processos & serviços: cartões dos serviços com histórico de quedas, tabela com busca e
  ordenação, "Para onde vai a memória".
- Eventos: disponibilidade de 90 dias por dia, filtros por tipo e situação, anotar na
  própria linha do tempo, agrupamento por dia, "ver no gráfico", notificações do navegador
  para alertas novos (com o painel em segundo plano).
- Relatórios: 7, 30, 90 dias ou datas escolhidas; resumo do período, tabela diária com
  disponibilidade e eventos, exportar CSV/JSON e imprimir (versão clara para PDF).
- Ajuda: o que fazer em cada alerta, como ler o painel, configuração ativa, estado da
  chave restrita e do sudo do SMART com a linha do sudoers pronta para copiar, versões e
  sessão.
- Estados: carregando (blocos no formato final), primeiro uso (checklist), alerta crítico
  (o que fazer + Reconhecer), aviso de configuração (comando do servidor desatualizado) e
  offline (últimos valores em cinza).
- Login em página própria, com "Manter conectado por 30 dias" e erro acessível.
- Celular (≤ 860 px): barra com menu, menu lateral deslizante, faixas de telemetria
  empilhadas, períodos em pílulas roláveis.
- Testes: contraste AA dos tokens nos dois temas (`design-tokens.test.js`), cálculos das
  telas (`front-telas.test.js`) e e2e no celular, no tema claro, offline e com "reduzir
  movimento".

### Alterado

- Tema claro: botão principal e amarelo de atenção um pouco mais escuros que na
  prancheta (`#0A8193` e `#B98009`) para passar no contraste AA.
- O alerta "servidor inacessível" e a queda registrada aparecem como um item só na linha
  do tempo.
- Previsão de disco que levaria mais de 10 anos para encher aparece como "estável".
- Taxa de rede exibida em "Mbps" (antes "Mb/s"), como nas pranchetas.
- Documentação (README, TUTORIAL, AGENTS, SECURITY, plano) descreve a tela nova.

### Removido

- `public/style.css` e as fontes Inter e JetBrains Mono (substituídas pelo design system
  V2 e pela Geist).

## [2.0.0-alpha.6] — 2026-10-07

Fase F5 do plano (fundação da tela nova). As 8 telas abrem no Chromium com dados, gráficos
e sem erro de JavaScript nem violação de CSP (teste e2e). O visual aprovado no canvas
entra na F6; por ora a tela usa o CSS atual.

### Adicionado

- Tela nova em ES modules nativos, sem build (ADR 0010): `public/js/core/` (template
  `html` com escape automático, formatação PT-BR, rotas com período na URL, estado
  central, API, SSE, cálculos), `charts/` e `views/`.
- 8 telas (D6): Visão geral (manchete de saúde em linguagem simples, cartões com
  mini-gráfico, eventos recentes), Recursos, Armazenamento (SMART por disco e previsão de
  disco cheio), Rede, Processos & serviços, Eventos (alertas, quedas e anotações numa
  linha do tempo, com "Desfazer" e uptime de 90 dias), Relatórios (resumo diário e
  exportação) e Ajuda (configuração ativa, atalhos, sessão).
- Gráficos com uPlot 1.6.32 versionado com SHA-256 (ADR 0004): eixo de tempo real, cursor
  sincronizado, arrastar/roda = zoom (mantido nas atualizações ao vivo), duplo clique volta.
- Atalhos `1`–`8`, `C`, `T`, `N`, `/` e `?`; avisos rápidos; faixa de servidor offline.
- `/api/config` (só leitura, sem segredos) e `server/version.js`.
- Testes ponta a ponta no Chromium (`npm run test:e2e`, `playwright-core` só em dev).

### Alterado

- O projeto fica **sem nenhuma dependência**: saem Chart.js e seus plugins.
- Telas Histórico, Análise e Anotações da V1 saem; o conteúdo foi para Eventos,
  Armazenamento e Relatórios.
- Períodos 7d, 30d e 90d (dos agregados de 5 min).
- CSP mais estrita: estilos só de `'self'`, sem `'unsafe-inline'`.

### Corrigido

- B5: o resumo diário agrupa pelo dia do fuso local, não UTC.
- B10: eixo de tempo real nos gráficos; anotações caem no instante certo.
- Logo após reiniciar o painel, a Visão geral não acusa mais "Servidor inacessível".
- Com `LANG=C`, alguns Chromium informam o idioma "en-US@posix", que impedia o uPlot de
  carregar (nenhum gráfico).
- Testes de API instáveis sob carga: a limpeza esperava gravações pendentes.

## [2.0.0-alpha.5] — 2026-10-07

Fase F4 do plano (HTTP). Backend sem dependência de runtime; segurança caracterizada pela
rede antes da troca e verde depois dela; `npm audit` limpo.

### Adicionado

- Servidor HTTP próprio em `server/http/` (ADR 0003): roteador, corpo JSON com limite de
  50 KB e estáticos só de `public/` com lista de tipos.
- Sessão por cookie (ADR 0007): tela de login no lugar do `prompt()`; o `DASH_TOKEN` é
  trocado 1x por um cookie HttpOnly + SameSite=Strict de 30 dias, renovado com o uso.
  Rotas `/api/session`, `/api/login`, `/api/logout` e `/api/logout-all`; "Sair" e
  "Encerrar todas as sessões" na Ajuda.
- SSE com backfill: amostras com `id`; na reconexão o painel reenvia o que a tela perdeu.
- Suíte de caracterização de segurança pela rede (`test/integration/http-seguranca.test.js`).

### Alterado

- Express removido (saem 68 pacotes); o backend não tem mais dependências de runtime.
- `?token=` na URL não é mais aceito: navegador usa a sessão; scripts usam
  `Authorization: Bearer`.
- Login limitado a 10 tentativas/min/IP; SSE limitado a 20 conexões simultâneas.

### Segurança

- Respostas 403 (Host não permitido, CSRF) passam a sair com os cabeçalhos de segurança.
- O token não fica mais guardado pelo JavaScript nem aparece em URLs ou logs; em disco
  fica só o SHA-256 da sessão.

## [2.0.0-alpha.4] — 2026-10-07

Fase F3 do plano (alertas). B3 e B9 corrigidos; testes de flapping cobrem a histerese.

### Adicionado

- Motor de alertas em `server/alerts/` (ADR 0006): regras declarativas com chave estável
  por condição (`disk:/mnt/x:usage`, `temp:cpu`, `service:smbd`...), histerese e debounce
  do offline.
- Limiares no `.env`: `ALERT_DISK_PCT`, `ALERT_RAM_PCT`, `ALERT_TEMP_C`,
  `ALERT_HYSTERESIS` e `ALERT_OFFLINE_AFTER`, validados (fora da faixa volta ao padrão com
  aviso no log).
- Registro de quedas próprio em `data/outages.ndjson` e `/api/outages?days=` com uptime
  calculado desde o início do monitoramento.
- `/api/status` traz `health` e os limiares ativos (`meta.thresholds`).

### Alterado

- "Servidor inacessível" só depois de 2 falhas seguidas (≈2 min); 1 falha isolada não
  alerta nem muda o status. A queda conta desde a 1ª falha.
- Índice de saúde, quedas e uptime calculados no servidor com os mesmos limiares dos
  alertas; antes a tela usava limiares próprios (75/80/70).
- Alerta aberto só regrava `alerts.json` quando muda de estado (valor novo: no máximo a
  cada 10 min, e sempre ao encerrar).

### Corrigido

- B3: a condição que persiste mantém UM alerta, com o valor atualizado (antes, 1 alerta
  novo por coleta).
- B9: as quedas não são mais apagadas pelo limite de 500 alertas; o uptime é confiável.

## [2.0.0-alpha.3] — 2026-10-07

Fase F2 do plano (armazenamento). Leitura validada com o `data/history.json` real da V1
(80 amostras, 0 inválidas).

### Adicionado

- Histórico em `server/storage/` (ADR 0005): amostras brutas append-only em
  `data/history/AAAA-MM-DD.ndjson` (72 h) e agregados de 5 min com mín/máx/média em
  `data/rollup/` (90 dias), atrás da mesma interface que o servidor já usava.
- `/api/history?formato=baldes&from=&to=&limit=`: série agregada de qualquer intervalo de
  até 90 dias, com 1 min de resolução dentro das 72 h brutas.
- Migração automática do `data/history.json` da V1 no 1º boot, com backup em
  `data/history.v1-migrado.json`; `npm run migrar-v1` (e `-- --verificar`, sem gravar nada).

### Alterado

- Cada poll grava ~3,7 KB no SSD local em vez de reescrever o histórico inteiro.
- Encerramento (SIGINT/SIGTERM) espera gravar histórico, alertas e anotações.
- `HISTORY_FILE` passa a indicar o histórico da V1 a migrar.

### Corrigido

- B4: export CSV com 1 par de colunas por dispositivo de I/O (cabeçalho e linhas alinhados).
- B7: gravar uma amostra não reescreve mais o histórico inteiro.
- B8: a redução de pontos para os gráficos preserva picos (pior caso de cada grupo).
- B11: o histórico pendente é gravado antes de o painel encerrar.
- `data/dashboard.log` nasce com permissão 0600 (antes ficava 0644 ao ser criado).

## [2.0.0-alpha.2] — 2026-10-07

Fase F1 do plano (coleta). Validada no servidor real: comando V2 completo em 901 ms.

### Adicionado

- Coletor V2 (`server/collector/`): script POSIX sh único e somente leitura, com
  marcador de completude `===FIM===`, versão e hash da configuração (`===VER===`) e modo
  `basico`/`smart` compatível com comando forçado no `authorized_keys` (ADR 0008).
- Amostra `schemaVersion: 2` com novas métricas: CPU % (user/system/iowait/steal), RAM
  `dirty`/`writeback`, inodes por disco e dispositivo de origem, erros/descartes de rede,
  utilização e latência de disco, PSI, todas as zonas térmicas e RSS/tempo dos processos.
- Testes: goldens do parser sobre a 1ª coleta V2 real (anonimizada) e sobre a amostra
  convertida da V1, casos-limite, fuzz com semente fixa e execução do script real em `sh`
  local (bash e dash).

### Alterado

- SMART roda 1x por hora; nos demais polls o último resultado é reaproveitado.
- Métricas lidas direto de `/proc` e `/sys` (sem `free`/`df -h`/`ps aux`).
- `server/poller.js` vira fachada do coletor, mantendo a API usada pelo servidor.
- Amostras ficam temporariamente maiores (novos campos) até a nova persistência da F2 (B7).

### Corrigido

- B1: SMART sem permissão não vira mais falso crítico; só `FAILED` alerta.
- B2: interface de rede filtrada pelo nome exato e contador colado ao nome lido corretamente.
- B6: o SMART de cada disco é encontrado pelo dispositivo de origem do mount.
- I5: dado ausente vira `null`; taxa de rede ausente não aparece como 0.

## [2.0.0-alpha.1] — 2026-10-07

Fase F0 do plano (base da V2). Nenhuma mudança de comportamento no painel.

### Adicionado
- Plano da V2 (`docs/PLANO_V2.md`) e registros de decisão `docs/adr/0001`–`0013`.
- Este changelog.
- `npm run check`: sintaxe JS e shell, `.env`/`data/` fora do git, testes com cobertura e
  `npm audit` — obrigatório antes de cada commit. `npm run test:unit` e `npm run test:integration`.
- `test/unit/bugs-v1.test.js`: 14 testes que reproduzem os bugs B1–B12 e a regra I5,
  marcados como `todo` até a fase que os corrige.
- `npm run capturar-amostra`: grava a saída bruta de 1 coleta real e uma cópia anonimizada
  (hostname, IPs, MACs e usuários trocados) em `data/`, para virar fixture dos testes da F1.

### Segurança
- Dependências transitivas do Express atualizadas (`npm audit fix`): `proxy-addr` 2.0.8,
  `qs` 6.16.0, `body-parser` 1.20.8, `express` 4.22.3 — zera os 4 alertas (1 crítico, 3 moderados).
  O Express sai de vez na F4 (ADR 0003).

### Alterado
- `AGENTS.md` com as regras de desenvolvimento da V2 e `README` com aviso de V2 em construção.
- Suíte reorganizada em `test/unit` (171) e `test/integration` (25).
- Exemplos e testes usam só IPs de documentação (RFC 5737).

## [1.0.0] — 2026-09-13

Última versão da V1, importada sem alterações como base da V2
(repositório de origem: `tsouza-thiago/linux-server-dashboard`).

### Funcionalidades
- Coleta por 1 comando SSH por minuto, somente leitura, sem instalar nada no servidor.
- Painel local (127.0.0.1) com 9 telas, temas claro/escuro, gráficos com zoom e anotações.
- Alertas com ciclo de vida (novo → reconhecido → resolvido) e auto-resolução.
- Exportação CSV (protegida contra fórmulas) e JSON.
- Instalador com assistente SSH, `DASH_TOKEN` automático e serviço systemd de usuário.
- Proteções: Host check, CSRF com cookie, CSP, rate limit, token timing-safe, sanitização
  anti-injeção do comando SSH, permissões 0700/0600, erros sem stack trace.

### Problemas conhecidos
Documentados no plano da V2 (seção 2.2, B1–B12), entre eles: alerta SMART falso sem root,
rede zerada com contadores grandes, alerta duplicado a cada coleta e reescrita completa do
histórico a cada minuto.

[Não publicado]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v2.0.0-alpha.6...HEAD
[2.0.0-alpha.6]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v2.0.0-alpha.5...v2.0.0-alpha.6
[2.0.0-alpha.5]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v2.0.0-alpha.4...v2.0.0-alpha.5
[2.0.0-alpha.4]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v2.0.0-alpha.3...v2.0.0-alpha.4
[2.0.0-alpha.3]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v2.0.0-alpha.2...v2.0.0-alpha.3
[2.0.0-alpha.2]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v2.0.0-alpha.1...v2.0.0-alpha.2
[2.0.0-alpha.1]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v1.0.0...v2.0.0-alpha.1
[1.0.0]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/releases/tag/v1.0.0
