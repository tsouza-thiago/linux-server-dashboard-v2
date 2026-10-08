# Política de Segurança

## Reportando vulnerabilidades

Este projeto é usado para monitorar um servidor pessoal em uma rede local. Se você
encontrar uma vulnerabilidade, **não abra uma issue pública** (o problema pode revelar
detalhes da infraestrutura). Reporte de forma privada:

- Abra uma issue no GitHub marcada como **private/security** (se disponível), ou
- Envie um e-mail ao mantenedor (verificado pelo perfil GitHub do repositório).

Sempre inclua: o passo a passo para reproduzir, o impacto estimado e a versão afetada.

---

## Modelo de ameaças (threat model)

Este painel roda na **máquina local** e conversa com o servidor por SSH. As ameaças
relevantes e suas mitigações:

### 1. Injeção de comando via configuração
- **Ameaça:** um valor malicioso em `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS` ou `SERVICES`
  virar um comando a mais na conexão SSH e executar no servidor.
- **Mitigação:** `server/config.js` filtra cada token por uma **whitelist** de
  caracteres seguros (`A-Za-z0-9_.:/-`), rejeita tokens que começam com `-` e ignora o
  restante. O `SSH_HOST` passa por sanitização própria (`sanitizeHost`) que rejeita
  valores iniciados com `-` (injeção de opção do `ssh`). O comando SSH (montado em
  `server/poller.js`) só usa valores já filtrados, e `runSSH()` recusa hosts com `-`
  como salvaguarda extra.
- **Verificado por:** testes em `test/config.test.js` e `test/security-fixes.test.js`.

### 2. DNS rebinding
- **Ameaça:** um site malicioso faz o navegador acessar `127.0.0.1:3000` como se fosse
  outro domínio, lendo a telemetria (hostnames, IPs, status) via API/SSE.
- **Mitigação:** todo request passa por validação do cabeçalho `Host`. Somente
  `localhost`, `127.0.0.1`, `[::1]` (com qualquer porta) são aceitos; qualquer outro
  host recebe HTTP 403. Implementado em `server/security.js` (`hostCheck`).
- **Nota de uso:** abra o painel por `http://localhost:3000` ou `http://127.0.0.1:3000`.

### 3. CSRF (requisições de origem cruzada)
- **Ameaça:** um site malicioso dispara POSTs (`/api/poll`, reconhecer/resolver alertas,
  criar anotações) usando o navegador já autenticado no painel.
- **Mitigação em duas camadas:**
  1. Mutações (POST/PUT/PATCH/DELETE) rejeitam origem cruzada: `Origin` diferente do
     `Host` validado, ou `Sec-Fetch-Site: cross-site`, recebem HTTP 403 (`csrfCheck`).
  2. O servidor emite um cookie `dash_csrf` (SameSite=Lax, HttpOnly, Path=/) nos GETs e
     exige que toda mutação **com `Origin` presente** carregue esse cookie. Como o cookie
     é HttpOnly e o valor tem tamanho mínimo, um site cruzado não consegue forjá-lo.
- **Verificado por:** testes em `test/security-ext.test.js`, `test/security-fixes.test.js`
  e `test/api-ext.test.js`.

### 4. XSS (conteúdo renderizado)
- **Ameaça:** dados vindos do servidor (montagens de disco, nomes de serviço, comandos
  de processo, status SMART, mensagens de alerta) com HTML/JavaScript malicioso.
- **Mitigação:** a tela só monta HTML pelo template `html` (`public/js/core/html.js`), que
  escapa toda interpolação; HTML cru só via `raw()` explícito (fácil de auditar). A CSP não
  permite script nem estilo inline (`'unsafe-inline'`) nem `eval`. Anotações são texto
  limitado em tamanho e aparecem como linhas no canvas do gráfico (uPlot). O teste e2e
  confirma que uma anotação com `<img onerror=…>` aparece como texto.

### 5. Formula injection no export (CSV/Excel)
- **Ameaça:** células começando com `=`, `+`, `-` ou `@` virarem fórmula no Excel.
- **Mitigação:** `server/csv.js` prefixa `'` nesses valores (`csvEscape`).
  O nome do arquivo exportado também é saneado.
- **Verificado por:** testes em `test/csv.test.js`.

### 6. Exposição local de telemetria (permissões)
- **Ameaça:** outro usuário local lê `.env` e `data/` (hostnames, IPs, telemetria).
- **Mitigação:** `data/` é criada com `0700`; `.env` e os arquivos de dados são gravados
  com `0600`, assim como `data/ssh/` (0700) e a chave do painel (0600). O
  `./dashboard diagnosticar` aponta qualquer arquivo aberto demais e o `chmod` exato.

### 7. Escrita fora da pasta de dados
- **Ameaça:** `HISTORY_FILE`/`LOG_FILE` apontando para fora do projeto (ex.: sobrescrever
  arquivos do sistema).
- **Mitigação:** `server/config.js` (`clampPathToData`) força esses caminhos para dentro
  de `data/`.

### 8. Verificação de host key (MITM no SSH)
- **Ameaça:** aceitar qualquer host key (sem checagem) permite ataque do meio no SSH.
- **Mitigação:** na instalação, a identidade do servidor (SHA-256, em blocos) é mostrada
  **antes** da senha, com o comando para conferir no próprio servidor; só depois do "Este
  é o meu servidor" ela vai para o `known_hosts` próprio do painel (`data/ssh/`). Daí em
  diante, `ssh -F data/ssh/config` com `StrictHostKeyChecking yes` e o `HostKeyAlgorithms`
  do tipo conferido: identidade diferente = coleta parada e aviso claro. O modo
  `--sem-interface` exige a impressão digital (`--identidade`). Nada de
  `StrictHostKeyChecking no` nem `UserKnownHostsFile /dev/null`.

### 8b. Chave do painel vazada (ADR 0008)
- **Ameaça:** alguém copia `~/.ssh/dashboard_ed25519` e tenta usar o servidor.
- **Mitigação:** a chave pertence ao usuário `dashmon` (sem senha, sem poderes) e o
  `authorized_keys` dela é `restrict,from="<IP deste computador>",command="<coleta>"`: sem
  terminal, sem encaminhamentos, só a coleta e só a partir daqui. O que o cliente pede só
  escolhe entre `basico` e `smart` (outro texto vira `basico`, nunca é executado). O
  `sudo` do `dashmon` vale apenas para `smartctl -H /dev/X`, um por disco (no sudoers, `*`
  também casaria espaços e outras opções), validado com `visudo -cf` antes de ativar.
- **Verificado por:** `test/integration/ssh-restrito.test.js` (sshd de verdade).

### 8c. Senha do administrador na instalação
- **Ameaça:** a senha usada para preparar o servidor vazar em disco, log ou `ps`.
- **Mitigação:** fica só na memória do assistente, do passo 3 ao fim do passo 5. O `ssh`
  a pede ao `scripts/askpass.sh`, que a lê de uma variável de ambiente só daquele processo;
  no servidor ela entra como variável do `sh` (script pelo stdin) e vai ao `sudo -S -k`
  pelo stdin, depois de conferida sozinha (senha errada não faz o sudo ler o script).
  Nunca vai na linha de comando. O assistente web só abre com código de uso único
  (cookie HttpOnly + SameSite=Strict) e tem as mesmas proteções do painel.

### 8d. Versão adulterada (ADR 0012)
- **Ameaça:** instalar ou atualizar para um código que não é o publicado.
- **Mitigação:** releases são tags assinadas (SSH) conferidas com `docs/allowed_signers`
  (`gpg.ssh.program` fixado, nada da configuração do git da pessoa muda o resultado). No
  `./dashboard atualizar`, a versão nova é conferida com a lista de chaves da versão **já
  instalada** (copiada antes do checkout). uPlot, fontes e o Node baixado são conferidos
  por SHA-256.

### 9. Acesso à API sem credencial (camada extra)
- **Ameaça (avançada):** se por algum motivo o painel for exposto, acesso aberto.
- **Mitigação:** a instalação gera um `DASH_TOKEN` automático (configurável no `.env`).
  Quando definido, toda a API/SSE exige uma sessão (cookie `dash_session` HttpOnly +
  SameSite=Strict, 30 dias renovados com o uso, obtido 1x na tela de login) ou
  `Authorization: Bearer <token>` para scripts. O token **nunca** vai na URL (`?token=`
  não é aceito) nem fica guardado pelo JavaScript; em disco só o SHA-256 da sessão.
  Login limitado a 10 tentativas/min/IP; "Sair" e "Encerrar todas as sessões" na Ajuda.
  A comparação usa `crypto.timingSafeEqual` (imune a ataques de timing). A segurança-base
  continua sendo o bind em `127.0.0.1` + as proteções acima.

### 10. Abuso de endpoints
- **Ameaça:** spam de "coletar agora" sobrecarregando o servidor.
- **Mitigação:** `/api/poll` é bloqueado enquanto houver coleta em andamento e tem piso
  de 5 s entre coletas manuais; o corpo JSON tem limite de 50 KB (413 acima, também sem
  `Content-Length`); todas as mutações da API são **limitadas por IP** (120/min) via
  `makeRateLimit`; o SSE aceita no máximo 20 conexões simultâneas.

### 11. Vazamento de detalhes internos em erros
- **Ameaça:** erros com stack trace revelando caminhos/versões do ambiente.
- **Mitigação:** error handler central devolve **JSON sem stack trace** (apenas
  `error`/`errorCode`/`status`); erros internos viram `500` genérico sem vazamento.
- **Verificado por:** `test/api-ext.test.js`.

---

## Princípios de segurança do projeto

Desenhado para não tocar em nada além de leitura no servidor monitorado:

- **Autenticação por chave SSH** (Ed25519) — nunca senha. `BatchMode=yes` + `ConnectTimeout=10`.
- **1 único comando SSH por minuto** — o servidor não instala nem executa nada além
  do comando de coleta (somente leitura: `df`, `free`, `ps`, `systemctl is-active`, `smartctl`...).
- **Comando de coleta blindado** — valores de configuração passam por whitelist
  (anti-injeção) antes de entrarem no comando; `SSH_HOST` é saneado e recusado se
  começar com `-`.
- **Dashboard bind em `127.0.0.1`** — nunca exposto em rede aberta.
- **Validação de `Host` + CSRF (c/ cookie) + rate limit + CSP + escape de HTML** — contra
  rebinding, requisições cruzadas, força bruta, XSS e injeção em relatórios.
- **Token por padrão** — `DASH_TOKEN` gerado no install, comparado com `timingSafeEqual`.
- **Sem segredos no repositório** — `.env` e `data/` estão no `.gitignore`; o repositório
  contém apenas código e modelos com placeholders.
- **Permissões restritas** — `data/` (0700) e arquivos sensíveis (0600).
- **Zero agentes no servidor** — não há daemon, serviço ou script persistente instalado nele.
- **Fontes self-hosted** — Geist + Geist Mono servidas de `public/fonts/` (`.woff2`, SHA-256 em `public/vendor/vendor.json`),
  sem carregar nada de CDN externo (coerente com `font-src 'self'` do CSP).

---

## Higiene operacional recomendada

- Nunca commite `.env` nem `data/` (contêm hostnames, IPs e telemetria da rede interna).
- Monitore apenas o necessário: preencha `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS` e `SERVICES`
  com o mínimo exigido pelo seu ambiente.
- Abra o painel sempre por `http://localhost:3000` ou `http://127.0.0.1:3000`.
- Não torne o dashboard acessível fora da máquina local; para acesso remoto use VPN/túnel SSH.
- Ao instalar, confira a identidade do servidor com
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` no próprio servidor.
- Se qualquer nome/uso de chave SSH tiver vazado em repositório ou histórico público,
  **rotacione a chave** imediatamente (veja abaixo).
- O `DASH_TOKEN` já vem gerado pela instalação. Se quiser trocá-lo, edite o `.env` e
  gere um novo com `openssl rand -hex 16`.

---

## Rotação de chave SSH (recomendado se houve vazamento)

Se a chave do painel pode ter vazado:

1. Apague a chave local (`~/.ssh/dashboard_ed25519` e o `.pub`, ou a
   `dashboard_v2_ed25519`, se for ela que aparece em `data/ssh/config`).
2. Rode `./dashboard reconfigurar`: uma chave nova é criada e o passo "Preparar o
   servidor" troca a linha do `authorized_keys` do `dashmon` (a antiga deixa de valer).
3. `./dashboard diagnosticar` deve terminar sem erros.

Instalações vindas da V1 usam a chave da V1, com acesso completo ao servidor, até o
primeiro `./dashboard reconfigurar`. Depois dele, remova a linha antiga da V1 do
`authorized_keys` do usuário que ela usava no servidor.
