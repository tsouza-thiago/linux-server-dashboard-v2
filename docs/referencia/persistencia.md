# Persistência

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

Tudo fica no disco local. Nada é gravado no servidor. Os caminhos abaixo são os do modo clone; no modo sistema, `.env`
e `data/` ficam nas pastas XDG (veja [Configuração](configuracao.md)).

| Caminho | O que guarda |
|---|---|
| `data/history/AAAA-MM-DD.ndjson` | Amostras brutas, 1 linha por coleta, só acréscimo (fila assíncrona), 1 arquivo por dia (UTC). Retenção de 72 h; linha cortada por queda é ignorada. ~3,7 KB por coleta (~16 MB em 72 h). Em memória, só a amostra mais recente guarda `topProcs` (as antigas ficam compactas, `compactSample`); o arquivo guarda tudo e é lido em blocos de 1 MB ao reiniciar |
| `data/rollup/AAAA-MM-DD.ndjson` | Agregados de 5 min `{ t, n, m: { métrica: [mín, máx, média] } }` por 90 dias. Quando só parte das `n` amostras tem a métrica, um 4º item diz quantas (`[mín, máx, média, c]`; média × c = soma). Fechar de novo não duplica; o boot fecha os pendentes. ~1,2 KB a cada 5 min (~29 MB em 90 dias) |
| `data/alerts.json`, `data/annotations.json` | Alertas com ciclo de vida `new` → `ack` → `resolved` (até 500); anotações (texto, rótulo, instante) |
| `data/outages.ndjson` | Quedas do servidor (`off`/`on`), 90 dias, separadas dos alertas (B9) |
| `data/history.v1-migrado.json` | Backup do histórico da V1, feito pela migração (pode ser apagado) |
| `data/sessions.json` | SHA-256 das sessões do navegador |
| `data/atualizacao.json` | Última procura de versão nova: quando, versão achada, novidades, erro e bloqueio (ADR 0030) |
| `data/entrar.json` | Hash do link de entrada de uso único (2 min no `./dashboard abrir`, 10 min no fim da instalação) |
| `data/reconfigurar.json`, `data/reconfigurar.log` | Hash do código do "Reconfigurar pela tela" (5 min, sai do disco ao ser lido) e a saída da última vez, sem segredos, com o motivo se o painel novo não subiu (ADR 0034 e 0035). A tela lê só as linhas de falha (ADR 0037) |
| `data/ssh/`, `data/dashboard.log` | `config` e `known_hosts` próprios do painel (0700); log (gira em 5 MB para `dashboard.log.1`) |
| `data/dashboard.pid`, `data/dashboard-erros.log` | Modo segundo plano (sem systemd): PID e erros de inicialização |
| `.runtime/node/`, `.backups/` | Node 24 baixado pelo `./dashboard`, se o do sistema faltar; cópias de `data/` feitas pelo `atualizar` (as 3 mais novas, 0700) |
| `.atualizacao/` | `ultima.log`, `estado.json`, `trava.pid` e `pre.json` (liberação do `--pre`, ADR 0032) da atualização pelo painel, escritos pelo executor; `painel/` (`pedido.json`, `espelho.git`) é a única subpasta com escrita do serviço (ADR 0051) (0700, fora do git). Fica fora de `data/` porque a volta atrás apaga `data/` (ADR 0031). No pacote, fica na pasta de dados XDG (ADR 0048) |

No navegador, o `localStorage` guarda só conveniências: o tema, a versão nova dispensada e as contagens de pastas,
discos, SMART e serviços para o esqueleto (`dash_formato`, ADR 0033), sem nomes.

Fora da pasta do projeto: a chave `~/.ssh/dashboard-<servidor>-<id>` (até a 2.1.0, `dashboard_ed25519` ou
`dashboard_v2_ed25519`), o serviço `~/.config/systemd/user/server-dashboard.service`, o atalho
`~/.local/share/applications/server-dashboard.desktop`, o comando `~/.local/bin/dashboard` e o autocomplete
`~/.local/share/bash-completion/completions/dashboard` (links; respeita `BASH_COMPLETION_USER_DIR` e `XDG_DATA_HOME`)
e, só com o sim, um bloco marcado (`# >>> server-dashboard >>>`) no arquivo de login do bash e outro no `~/.bashrc`
(só sem o pacote `bash-completion`), com a cópia `<arquivo>.dashboard-bak`.

Ao encerrar (SIGINT/SIGTERM), o painel espera gravar histórico, alertas e anotações pendentes (B11).
