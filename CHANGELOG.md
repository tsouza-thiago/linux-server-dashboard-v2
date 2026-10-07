# Changelog

Todas as mudanças relevantes deste projeto ficam registradas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto
usa [Versionamento Semântico](https://semver.org/lang/pt-BR/). A V2 é publicada em
pré-versões `2.0.0-alpha.N` (uma por fase do plano), depois `beta`, `rc` e `2.0.0`.

## [Não publicado]

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

[Não publicado]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v2.0.0-alpha.2...HEAD
[2.0.0-alpha.2]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v2.0.0-alpha.1...v2.0.0-alpha.2
[2.0.0-alpha.1]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v1.0.0...v2.0.0-alpha.1
[1.0.0]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/releases/tag/v1.0.0
