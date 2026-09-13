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
- **Mitigação:** todo dado exibido no painel passa por escape (`Dash.fmt.esc`) antes de
  virar HTML. Anotações são desenhadas em canvas (Chart.js) e limitadas em tamanho.

### 5. Formula injection no export (CSV/Excel)
- **Ameaça:** células começando com `=`, `+`, `-` ou `@` virarem fórmula no Excel.
- **Mitigação:** `server/csv.js` prefixa `'` nesses valores (`csvEscape`).
  O nome do arquivo exportado também é saneado.
- **Verificado por:** testes em `test/csv.test.js`.

### 6. Exposição local de telemetria (permissões)
- **Ameaça:** outro usuário local lê `.env` e `data/` (hostnames, IPs, telemetria).
- **Mitigação:** `data/` é criada com `0700`; `.env` e os arquivos de dados são gravados
  com `0600`. `install.sh`/`start.sh` reforçam as permissões a cada execução.

### 7. Escrita fora da pasta de dados
- **Ameaça:** `HISTORY_FILE`/`LOG_FILE` apontando para fora do projeto (ex.: sobrescrever
  arquivos do sistema).
- **Mitigação:** `server/config.js` (`clampPathToData`) força esses caminhos para dentro
  de `data/`.

### 8. Verificação de host key (MITM no SSH)
- **Ameaça:** aceitar qualquer host key (sem checagem) permite ataque do meio no SSH.
- **Mitigação:** o `install.sh` grava o alias com `StrictHostKeyChecking accept-new`
  (aceita só a primeira vez, depois valida). O poller usa `BatchMode=yes`. Nada de
  `StrictHostKeyChecking no` nem `UserKnownHostsFile /dev/null`.

### 9. Acesso à API sem credencial (camada extra)
- **Ameaça (avançada):** se por algum motivo o painel for exposto, acesso aberto.
- **Mitigação:** o instalador gera um `DASH_TOKEN` automático (configurável no `.env`).
  Quando definido, toda a API/SSE exige `Authorization: Bearer <token>` (ou `?token=`
  na URL do SSE). O navegador pede o token uma vez e guarda na sessão. A comparação usa
  `crypto.timingSafeEqual` (imune a ataques de timing). A segurança-base continua sendo
  o bind em `127.0.0.1` + as proteções acima.

### 10. Abuso de endpoints
- **Ameaça:** spam de "coletar agora" sobrecarregando o servidor.
- **Mitigação:** `/api/poll` é bloqueado enquanto houver coleta em andamento e tem piso
  de 5 s entre coletas manuais; `express.json` tem limite de 50 KB; e todas as mutações
  da API são **limitadas por IP** (rate limit de 120/min) via `makeRateLimit`.

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
- **Fontes self-hosted** — Inter + JetBrains Mono servidos de `public/fonts/` (`.woff2`),
  sem carregar nada de CDN externo (coerente com `font-src 'self'` do CSP).

---

## Higiene operacional recomendada

- Nunca commite `.env` nem `data/` (contêm hostnames, IPs e telemetria da rede interna).
- Monitore apenas o necessário: preencha `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS` e `SERVICES`
  com o mínimo exigido pelo seu ambiente.
- Abra o painel sempre por `http://localhost:3000` ou `http://127.0.0.1:3000`.
- Não torne o dashboard acessível fora da máquina local; para acesso remoto use VPN/túnel SSH.
- Não use `StrictHostKeyChecking no` no `~/.ssh/config` (desativa a verificação de
  identidade do servidor). Prefira `accept-new`.
- Se qualquer nome/uso de chave SSH tiver vazado em repositório ou histórico público,
  **rotacione a chave** imediatamente (veja abaixo).
- O `DASH_TOKEN` já vem gerado pelo instalador. Se quiser trocá-lo, edite o `.env` e
  gere um novo com `openssl rand -hex 16`.

---

## Rotação de chave SSH (recomendado se houve vazamento)

Se o nome ou o uso de uma chave apareceu em histórico público de git, trate a chave
como comprometida e rotacione:

1. Na **máquina local**, gere um novo par de chaves:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/dashboard_ed25519 -C "usuario@maquina" -N ""
   ```
   (ou use um nome novo; depois ajuste o `~/.ssh/config`.)
2. Copie a chave pública para o servidor (executado da máquina local, uma única vez):
   ```bash
   ssh-copy-id -i ~/.ssh/dashboard_ed25519.pub seu-host
   ```
   (ou acrescente a linha em `~/.ssh/authorized_keys` no servidor manualmente.)
3. Confirme que o `~/.ssh/config` aponta para a chave nova
   (`IdentityFile ~/.ssh/dashboard_ed25519`) com `StrictHostKeyChecking accept-new`.
4. Teste: `ssh seu-host 'echo ok'` deve responder `ok` sem senha.
5. **Remova a chave antiga** da máquina local e do `authorized_keys` do servidor,
   depois descarte-a.
6. Atualize o `SSH_HOST`/configs do projeto se o alias mudou.

> Regra do projeto: o `~/.ssh/config` usa o mesmo alias em `SSH_HOST` do `.env`.
> O `install.sh` (`--configure`) refaz esse fluxo para você.