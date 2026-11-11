# API

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

Todas as rotas passam por: Host check, CSRF (com cookie `dash_csrf`), cabeçalhos de segurança, rate limit das mutações
e error handler sem stack trace. Com `DASH_TOKEN`, `/api/*` e `/api/stream` exigem sessão ou `Bearer <token>` (menos
`/api/session`, `/api/login` e `/api/logout`).

| Rota | Método | Descrição |
|---|---|---|
| `/` | GET | As 8 telas (rota por hash com período: `#/rede?p=24h`) |
| `/entrar` | GET | `?codigo=` → link de uso único do `./dashboard abrir`: cria a sessão e redireciona |
| `/api/session` | GET | `{authRequired, authenticated, expiresAt}` (sem exigir login) |
| `/api/login` | POST | `{token, remember?}` → cookie de sessão (30 dias; `remember: false` = só até fechar o navegador). 401 se errado; 10 tentativas/min/IP |
| `/api/logout` | POST | Encerra a sessão deste navegador |
| `/api/logout-all` | POST | Encerra todas as sessões (exige estar logado) |
| `/api/status` | GET | Última amostra + meta (online, lastPollAt, nextPollAt, offlineSince) + saúde + alertas ativos |
| `/api/history` | GET | `?limit=N&from=&to=` → amostras (reduzidas a `limit`: padrão 720, máximo 2000, com o pior caso de cada grupo; `topProcs` só na mais recente). `&formato=baldes` → `{from, to, step, buckets}` com mín/máx/média, até 90 dias |
| `/api/config` | GET | Configuração ativa para a Ajuda: versões, alvos, modo de acesso, limiares (sem segredos) |
| `/api/atualizacao` | GET | `{instalada, nova, novidades, exigeReconfigurar, verificadoEm, erro, modo, bloqueio, reconfiguracao}`. `reconfiguracao` é `null` ou `{em, motivos}`: o instante do `data/reconfigurar.log` e só as linhas de falha dele, até 5 (ADR 0037). `novidades` é `{secoes: [{versao, data, texto}], cortado, exigeReconfigurar}`; o `exigeReconfigurar` de fora só vale no acesso restrito; `erro` é `sem-acesso` ou `falhou`; `modo` é `systemd`, `segundo-plano` ou `null`; `bloqueio` é `sem-login`, `rodando`, `sem-git`, `arquivos-alterados` ou `outra-pasta` |
| `/api/atualizacao/verificar` | POST | Procura versão nova agora e devolve o mesmo estado. No máximo 1 por minuto (429 acima) |
| `/api/atualizacao/iniciar` | POST | `{versao}` igual à versão nova detectada → 202 `{alvo}`; senão, com `bloqueio` ou sem executor (testes e painel de teste), 409. Se o executor não subir, 503 (I11) |
| `/api/atualizacao/registro` | GET | `?desde=<byte>` → `{texto, proximo, fase, alvo, de, inicio, fim, resultado, rodando}`: o pedaço novo do log, em linhas inteiras, até 64 KB. `fase`: `iniciando`, `procurando`, `trocando`, `ligando`, `voltando` ou `fim`; `resultado`: `atualizado`, `ja-na-mais-nova`, `voltou`, `falhou` ou `interrompida` |
| `/api/reconfigurar/iniciar` | POST | Nada do pedido é lido → 202 `{codigo}`, o código do assistente, só nesta resposta (ADR 0036). Sem executor (testes e painel de teste sem `--reconfigurar`), 409. `bloqueio` no 409: `sem-login`, `rodando`, `outra-pasta` ou `sem-assinatura`. Se o executor não subir, 503, sem código no disco (I11) |
| `/api/outages` | GET | `?days=1..90` (padrão 30) → `{days, outages, monitored, uptime}`. `monitored` são os intervalos `{from, to}` em que o painel estava medindo; `uptime` conta só esse tempo (ADR 0018) |
| `/api/alerts` | GET | `?status=&level=&limit=` → `{active, all}` |
| `/api/alerts/:id/ack` | POST | Reconhece o alerta |
| `/api/alerts/:id/resolve` | POST | Resolve o alerta |
| `/api/annotations` | GET / POST | Lista / cria anotação (`{ts, text, label}`) |
| `/api/annotations/:id` | DELETE | Remove a anotação |
| `/api/export` | GET | `?format=csv\|json&from=&to=` → download do relatório |
| `/api/stream` | GET | SSE: `hello`, `sample` (`id` = instante), `alerts`, `annotations`, `status`, `atualizacao`. `Last-Event-ID` recupera até 2000 amostras |
| `/api/poll` | POST | Coleta agora (piso de 5 s entre coletas manuais) |

Durante a instalação, o assistente (`server/setup/web.js`) roda num servidor temporário, na mesma porta e com as
mesmas proteções: `/configurar` (a página) e `/api/configurar/*` (os passos). Ele só abre com o código de uso único
mostrado no terminal (30 min, 20 tentativas). Aberto pela tela (`--pela-tela`), ele aceita o código que o painel
entregou ao navegador, `/api/configurar/estado` traz `pelaTela: true` e `POST /api/configurar/cancelar` devolve o
painel.
