# Política de Segurança

## Reportar uma vulnerabilidade

Este projeto monitora servidores pessoais em redes locais. Uma issue pública pode revelar
detalhes da infraestrutura de quem usa. Por isso, **não abra issue pública** para
vulnerabilidade. Reporte em particular:

- pelo GitHub, em **Security → Report a vulnerability** (se estiver disponível); ou
- por e-mail ao mantenedor (o endereço está no perfil do GitHub do repositório).

Inclua: o passo a passo para reproduzir, o impacto estimado e a versão afetada
(`./dashboard versao`).

---

## Escopo

**O que o painel protege:**
- o servidor monitorado (o painel só lê; a chave do painel só roda a coleta);
- a telemetria e o acesso ao painel nesta máquina (contra sites e outros usuários locais);
- a senha do administrador do servidor, usada uma vez na instalação;
- a integridade do código instalado e atualizado.

**O que fica fora do escopo:**
- alguém com acesso de root (ou à sua conta) nesta máquina: essa pessoa já lê tudo o
  que você lê;
- alguém com root no servidor: essa pessoa já controla o servidor. O painel só garante
  que uma resposta maliciosa do servidor não vira execução nem estouro de memória aqui
  (ameaça 13);
- expor o painel na rede ou na internet: o painel escuta só em `127.0.0.1`, de propósito.
  Para acesso remoto, use VPN ou túnel SSH.

---

## Modelo de ameaças

### 1. Injeção de comando pela configuração
- **Ameaça:** um valor malicioso no `.env` (`NET_IF`, `DISK_MOUNTS`, `DISK_DEVS`,
  `SMART_DEVS`, `SERVICES`, `SSH_HOST`) vira um comando a mais no servidor ou uma opção a
  mais no `ssh`.
- **Mitigação:** `server/config.js` filtra cada valor por uma **whitelist**
  (`A-Za-z0-9_.:/-`) e recusa o que começa com `-`. `sanitizeHost` recusa host iniciado com
  `-`, e `runSSH()` repete a checagem. O script de coleta (`server/collector/builder.js`)
  só recebe valores já filtrados. Na instalação, cada entrada passa por
  `server/setup/acesso.js` antes de virar arquivo ou comando.
- **Verificado por:** `test/unit/config.test.js`, `test/unit/security-fixes.test.js`,
  `test/unit/collector-builder.test.js` e `test/unit/setup-nucleo.test.js`.

### 2. Chave do painel vazada (ADR 0008)
- **Ameaça:** alguém copia a chave do painel (`~/.ssh/dashboard_ed25519`) e tenta usar o
  servidor.
- **Mitigação:** a chave pertence ao usuário `dashmon` (sem senha e sem poderes). A linha
  dela no `authorized_keys` é `restrict,from="<IP deste computador>",command="<coleta>"`:
  sem terminal, sem encaminhamentos, só a coleta e só a partir desta máquina. O texto que o
  cliente envia só escolhe entre `basico` e `smart`; qualquer outro texto vira `basico` e
  nunca é executado nem ecoado. O escape da linha segue o `opt_dequote` do OpenSSH.
- **Verificado por:** `test/integration/ssh-restrito.test.js` (sshd de verdade).

### 3. Escalada pelo sudo do SMART
- **Ameaça:** usar a regra de `sudo` do `dashmon` para rodar outra coisa como root.
- **Mitigação:** o sudoers (`/etc/sudoers.d/dashboard`) libera só `smartctl -H /dev/X`,
  uma entrada por disco escolhido, com o caminho absoluto do `smartctl`. Nunca há curinga:
  no sudoers, `*` também casaria espaços e outras opções. A regra passa por `visudo -cf`
  antes de entrar em uso. A coleta usa `sudo -n` (nunca pede senha).
- **Verificado por:** `test/unit/setup-nucleo.test.js` e
  `test/integration/ssh-restrito.test.js`.

### 4. Identidade do servidor falsa (ataque no meio do SSH)
- **Ameaça:** outro aparelho se passa pelo servidor e recebe a senha do administrador ou
  devolve dados falsos.
- **Mitigação:** na instalação, a identidade do servidor (SHA-256, em blocos) aparece
  **antes** da senha, com o comando para conferir no próprio servidor
  (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Só depois de "Este é o meu
  servidor" ela vai para o `known_hosts` próprio do painel (`data/ssh/`). Daí em diante, o
  painel usa `ssh -F data/ssh/config` com `StrictHostKeyChecking yes` e o
  `HostKeyAlgorithms` do tipo conferido. Identidade diferente para a coleta e mostra um
  aviso claro. O modo `--sem-interface` exige a impressão digital (`--identidade`).
- **Verificado por:** `test/unit/setup-nucleo.test.js` e
  `test/integration/ssh-restrito.test.js`.

### 5. Senha do administrador vazada na instalação
- **Ameaça:** a senha usada para preparar o servidor fica em disco, em log, no `ps` ou no
  histórico do shell.
- **Mitigação:** a senha fica só na memória do assistente, do passo 3 ao fim do passo 5.
  O `ssh` a recebe pelo `scripts/askpass.sh`, que a lê de uma variável de ambiente só
  daquele processo. No servidor, ela entra como variável do `sh` (script pelo stdin) e vai
  ao `sudo -S -k` pelo stdin. Ela é conferida antes: senha errada não faz o `sudo` ler o
  script. Ela nunca vai na linha de comando e é descartada no fim.
- **Verificado por:** `test/unit/setup-nucleo.test.js`,
  `test/unit/setup-instalacao.test.js` e `test/integration/cli-instalar.test.js`.

### 6. Assistente de instalação aberto por outro programa
- **Ameaça:** um site ou outro usuário local usa o assistente (servidor temporário) para
  ler dados ou mandar comandos ao servidor.
- **Mitigação:** o assistente escuta só em `127.0.0.1`, tem as mesmas proteções do painel
  (Host check, CSRF, cabeçalhos) e só abre com o **código de uso único** mostrado no
  terminal (30 min, 20 tentativas). O código vira um cookie HttpOnly + SameSite=Strict.
- **Verificado por:** `test/integration/assistente-http.test.js`.

### 7. Versão adulterada (ADR 0012)
- **Ameaça:** instalar ou atualizar para um código diferente do publicado.
- **Mitigação:** as versões são tags assinadas (SSH), conferidas com
  `docs/allowed_signers`. O `gpg.ssh.program` é fixado: nada da configuração do git da
  pessoa muda o resultado. No `./dashboard atualizar`, a versão nova é conferida com a
  lista de chaves da versão **já instalada** (copiada antes do checkout). uPlot, fontes e o
  Node baixado são conferidos por SHA-256.
- **Verificado por:** `test/integration/assinatura.test.js`,
  `test/integration/cli-manutencao.test.js`, `test/integration/dashboard-cli.test.js` e
  `test/unit/vendor.test.js`.

### 8. DNS rebinding
- **Ameaça:** um site faz o navegador acessar `127.0.0.1:3000` como se fosse outro domínio
  e lê a telemetria pela API ou pelo SSE.
- **Mitigação:** toda requisição passa pela validação do cabeçalho `Host`. Só
  `localhost`, `127.0.0.1` e `[::1]` (com qualquer porta) passam; o resto recebe 403
  (`hostCheck` em `server/security.js`).
- **Verificado por:** `test/unit/security.test.js` e
  `test/integration/http-seguranca.test.js`.

### 9. CSRF (requisições de outra origem)
- **Ameaça:** um site dispara POSTs (coletar agora, reconhecer alertas, criar anotações)
  com o navegador já logado no painel.
- **Mitigação em 2 camadas:**
  1. Mutações com `Origin` diferente do `Host` ou com `Sec-Fetch-Site: cross-site`
     recebem 403 (`csrfCheck`).
  2. Mutações com `Origin` também precisam do cookie `dash_csrf` (SameSite=Lax, HttpOnly),
     emitido nos GETs. Um site de outra origem não consegue forjar esse cookie.
- **Verificado por:** `test/unit/security-ext.test.js`,
  `test/integration/http-seguranca.test.js` e `test/integration/api-ext.test.js`.

### 10. XSS (conteúdo mostrado na tela)
- **Ameaça:** dados do servidor (pontos de montagem, serviços, comandos de processo,
  mensagens) ou anotações com HTML ou JavaScript.
- **Mitigação:** a tela só monta HTML pelo template `html` (`public/js/core/html.js`), que
  escapa toda interpolação. HTML cru só por `raw()` explícito. A CSP não permite script nem
  estilo inline nem `eval`.
- **Verificado por:** `test/unit/front-core.test.js` e `test/e2e/telas.test.js` (uma
  anotação com `<img onerror=…>` aparece como texto).

### 11. Acesso ao painel sem credencial
- **Ameaça:** outro usuário desta máquina (ou um programa local) lê a API do painel.
- **Mitigação:** a instalação gera um `DASH_TOKEN`. Com ele, a API e o SSE exigem sessão
  (cookie `dash_session`, HttpOnly + SameSite=Strict, 30 dias renovados com o uso) ou
  `Authorization: Bearer <token>`. O token nunca vai na URL e o JavaScript não o guarda.
  Em disco fica só o SHA-256 da sessão. O login aceita 10 tentativas por minuto por IP.
  O link do `./dashboard abrir` (`/entrar`) vale 1 vez, por 2 minutos. A comparação usa
  `crypto.timingSafeEqual`. A Ajuda tem "Sair" e "Encerrar todas as sessões".
- **Verificado por:** `test/integration/api-sessao.test.js` e
  `test/unit/http-session.test.js`.

### 12. Leitura de arquivos locais por outro usuário
- **Ameaça:** outro usuário desta máquina lê `.env`, a chave do painel ou `data/`
  (hostnames, IPs, telemetria), ou o painel grava fora de `data/`.
- **Mitigação:** `data/` e `data/ssh/` com 0700; `.env`, chave e arquivos de dados com
  0600, mesmo com `umask` aberta. `HISTORY_FILE`, `LOG_FILE` e `SSH_CONFIG` são forçados
  para dentro de `data/` (`clampPathToData`). O serviço de usuário roda com isolamento do
  systemd (`NoNewPrivileges`, `ProtectSystem=strict`, só grava em `data/`). O
  `./dashboard diagnosticar` aponta arquivo aberto demais e o `chmod` exato.
- **Verificado por:** `test/unit/security-fixes.test.js`, `test/unit/config.test.js`,
  `test/unit/setup-nucleo.test.js` e `test/integration/cli-manutencao.test.js`.

### 13. Resposta maliciosa do servidor
- **Ameaça:** um servidor comprometido devolve uma saída montada para quebrar o parser,
  injetar conteúdo na tela ou encher a memória desta máquina.
- **Mitigação:** a saída é só lida, nunca executada. O parser tolera qualquer texto
  (campo ausente vira `null`) e a tela escapa tudo (ameaça 10). A resposta do SSH tem limite
  de 1 MB: acima disso, a conexão é cortada e a coleta falha com o motivo.
- **Verificado por:** `test/unit/collector-fuzz.test.js` e
  `test/integration/collector-local.test.js`.

### 14. Abuso dos endpoints
- **Ameaça:** excesso de "coletar agora" sobrecarrega o servidor, ou requisições grandes
  sobrecarregam esta máquina.
- **Mitigação:** `/api/poll` fica bloqueado durante uma coleta e tem piso de 5 s entre
  coletas manuais. O corpo JSON tem até 50 KB (413 acima, também sem `Content-Length`).
  As mutações têm limite de 120 por minuto por IP (`makeRateLimit`). O SSE aceita até 20
  conexões.
- **Verificado por:** `test/integration/api-ext.test.js`,
  `test/integration/http-seguranca.test.js` e `test/integration/api-sse.test.js`.

### 15. Formula injection no export (CSV)
- **Ameaça:** células que começam com `=`, `+`, `-` ou `@` viram fórmula no Excel.
- **Mitigação:** `server/csv.js` põe `'` antes desses valores (`csvEscape`). O nome do
  arquivo exportado também é saneado.
- **Verificado por:** `test/unit/csv.test.js` e `test/unit/csv-ext.test.js`.

### 16. Detalhes internos em mensagens de erro
- **Ameaça:** um erro com stack trace revela caminhos e versões do ambiente.
- **Mitigação:** o error handler central devolve JSON **sem stack trace** (só `error`,
  `errorCode` e `status`). Erro interno vira `500` genérico.
- **Verificado por:** `test/integration/api-ext.test.js`.

---

## Princípios

- **Servidor somente leitura**, sem agente: o servidor só lê `/proc` e `/sys` e roda `df`,
  `ps`, `systemctl is-active` e `smartctl -H`. Nada é instalado nele.
- **1 comando SSH por minuto**, com chave Ed25519 restrita à coleta. `BatchMode=yes` e
  `ConnectTimeout=10`.
- **A senha do servidor serve só na instalação** e nunca é guardada.
- **Painel só em `127.0.0.1`**, com Host check, CSRF, rate limit, CSP e escape de HTML.
- **Sem segredos no repositório:** `.env` e `data/` estão no `.gitignore`.
- **Sem CDN:** uPlot e as fontes Geist vêm no pacote, conferidos por SHA-256
  (`public/vendor/vendor.json`), coerente com a CSP `'self'`.

---

## Higiene recomendada

- Nunca commite `.env` nem `data/`.
- Monitore só o necessário: no assistente, marque só as pastas, discos e serviços que você
  quer acompanhar.
- Na instalação, confira a identidade do servidor no próprio servidor:
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
- Abra o painel por `./dashboard abrir`, `http://127.0.0.1:3000` ou
  `http://localhost:3000`.
- Para trocar o `DASH_TOKEN`: gere um novo com `openssl rand -hex 16`, troque no `.env` e
  rode `./dashboard parar` e `./dashboard iniciar`.

---

## Trocar a chave do painel (se ela vazou)

1. Apague a chave local: `~/.ssh/dashboard_ed25519` e o `.pub` (ou a
   `dashboard_v2_ed25519`, se for ela que aparece em `data/ssh/config`).
2. Rode `./dashboard reconfigurar`. Ele cria uma chave nova, e o passo "Preparar o
   servidor" troca a linha do `authorized_keys` do `dashmon`. A chave antiga deixa de valer.
3. Rode `./dashboard diagnosticar`. O resultado deve ser "nenhum aviso, nenhum erro".

Instalações vindas da V1 usam a chave da V1, com acesso completo ao servidor, até o
primeiro `./dashboard reconfigurar`. Depois dele, remova a linha antiga da V1 do
`authorized_keys` do usuário que ela usava no servidor.
