# Política de Segurança

## Reportar uma vulnerabilidade

Este projeto monitora servidores pessoais em redes locais. Uma issue pública pode revelar
detalhes da infraestrutura de quem usa. Por isso, **não abra issue pública** para
vulnerabilidade. Reporte em particular:

- pelo reporte privado do GitHub, em **Security → Report a vulnerability**
  ([abrir um reporte](https://github.com/tsouza-thiago/linux-server-dashboard-v2/security/advisories/new));
  é o caminho preferido (ADR 0016); ou
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
- **Ameaça:** alguém copia a chave do painel (`~/.ssh/dashboard-<servidor>-<id>`) e tenta
  usar o servidor.
- **Mitigação:** a chave pertence ao usuário `dashmon` (sem senha e sem poderes). A linha
  dela no `authorized_keys` é `restrict,from="<IP deste computador>",command="<coleta>"`:
  sem terminal, sem encaminhamentos e só a coleta. Por padrão, só a partir desta máquina
  (o `from=` pode ser desligado no assistente ou com `--sem-origem`). O texto que o
  cliente envia só escolhe entre `basico` e `smart`; qualquer outro texto vira `basico` e
  nunca é executado nem ecoado. O escape da linha segue o `opt_dequote` do OpenSSH.
- **Verificado por:** `test/integration/ssh-restrito.test.js` (sshd de verdade).

### 3. Escalada pelo sudo do SMART
- **Ameaça:** usar a regra de `sudo` do `dashmon` para rodar outra coisa como root.
- **Mitigação:** o sudoers (`/etc/sudoers.d/dashboard-<computador>-<id>`, um arquivo por
  instalação, ADR 0020) libera só `smartctl -H /dev/X`,
  uma entrada por disco escolhido, com o caminho absoluto do `smartctl`. Nunca há curinga:
  no sudoers, `*` também casaria espaços e outras opções. A regra passa por `visudo -cf`
  antes de entrar em uso. A coleta usa `sudo -n` (nunca pede senha). O nome do computador
  entra no nome do arquivo só depois de `machineLabel()` (`[a-z0-9-]`, sem ponto, que o
  `#includedir` ignoraria), e o nome inteiro é conferido de novo antes de virar comando.
- **Verificado por:** `test/unit/setup-nucleo.test.js`,
  `test/unit/preparo-varios-computadores.test.js` e
  `test/integration/ssh-restrito.test.js`.

### 3a. Um computador derruba o acesso do outro (ADR 0020)
- **Ameaça:** com vários computadores no mesmo servidor, a instalação, a reconfiguração ou a
  desinstalação de um apaga a linha do `authorized_keys`, a regra de sudo ou o usuário
  `dashmon` de que os outros dependem (#60).
- **Mitigação:** cada instalação tem um ID tirado da sua chave pública e só troca a linha e
  o sudoers desse ID; a linha sai pela mesma chave ou pelo mesmo ID no fim do comentário,
  nunca por um trecho no meio. O `dashmon` só sai quando não sobra nenhuma linha. Sem o
  `.pub` da chave, o `desinstalar` não mexe no servidor.
- **Verificado por:** `test/unit/preparo-varios-computadores.test.js` (os scripts rodam de
  verdade num servidor simulado), `test/integration/ssh-restrito.test.js` (dois computadores
  coletam do mesmo sshd) e `test/integration/cli-manutencao.test.js`.

### 3b. Servidor que só aceita chave (ADR 0021)
- **Ameaça:** para entrar num servidor endurecido, o painel lê o `~/.ssh/config` inteiro
  (`ProxyCommand`, `Match exec`, outro `known_hosts`), recebe a passphrase da chave da pessoa
  ou oferece todas as chaves do agente ao servidor (banimento por `MaxAuthTries`/fail2ban).
- **Mitigação:** o apelido é lido com `ssh -G` (não conecta) e só os valores dele vão para a
  conexão, com `-F /dev/null`, `IdentitiesOnly=yes`, o `IdentityAgent` do apelido e o
  `known_hosts` do painel. `ProxyJump` e `ProxyCommand` são recusados; caminho com `%` ou `$`
  também. A passphrase fica no ssh-agent: o painel só compara o `ssh-add -L` com o `.pub`. A
  senha do sudo é separada e vai só pelo stdin do `sudo -S -k`. A conferência do sshd só lê
  (`sshd -T`) e nunca altera o `sshd_config`.
- **Verificado por:** `test/unit/setup-chave-ssh.test.js` (`ssh -G` e agente falsos, sudo com
  senha separada, ProxyJump recusado) e `test/integration/ssh-chave.test.js` (sshd real só
  com chave, `MaxAuthTries 1`, chave com passphrase no ssh-agent).

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
  terminal, com prazo e número de tentativas limitados (valores no AGENTS, "Regras de
  segurança"). O código tem 6 caracteres de um alfabeto de 25, sorteados sem viés
  (`crypto.randomInt`), e vira um cookie HttpOnly + SameSite=Strict.
- **Verificado por:** `test/integration/assistente-http.test.js` e
  `test/seguranca/superficie-ataque.test.js`.

### 7. Versão adulterada (ADR 0012)
- **Ameaça:** instalar ou atualizar para um código diferente do publicado.
- **Mitigação:** as versões são tags assinadas (SSH), conferidas com
  `docs/allowed_signers`. O `gpg.ssh.program` é fixado: nada da configuração do git da
  pessoa muda o resultado. No `./dashboard atualizar`, a versão nova é conferida com a
  lista de chaves da versão **já instalada** (copiada antes do checkout). uPlot, fontes e o
  Node baixado são conferidos por SHA-256. A Wiki só é editada por colaboradores, para que
  ninguém publique nela um comando de instalação com o endereço de outro repositório
  (ADR 0017).
- **Verificado por:** `test/integration/assinatura.test.js`,
  `test/integration/cli-manutencao.test.js`, `test/integration/dashboard-cli.test.js` e
  `test/unit/vendor.test.js`.

### 8. DNS rebinding
- **Ameaça:** um site faz o navegador acessar `127.0.0.1:3000` como se fosse outro domínio
  e lê a telemetria pela API ou pelo SSE.
- **Mitigação:** toda requisição passa pela validação do cabeçalho `Host`. Só
  `localhost`, `127.0.0.1` e `[::1]` (com qualquer porta) passam; o resto recebe 403
  (`hostCheck` em `server/security.js`).
- **Verificado por:** `test/unit/security.test.js`,
  `test/integration/http-seguranca.test.js` e `test/seguranca/superficie-ataque.test.js`
  (toda rota, com 5 nomes de Host hostis).

### 9. CSRF (requisições de outra origem)
- **Ameaça:** um site dispara POSTs (coletar agora, reconhecer alertas, criar anotações)
  com o navegador já logado no painel.
- **Mitigação em 2 camadas:**
  1. Mutações com `Origin` diferente do `Host` ou com `Sec-Fetch-Site: cross-site`
     recebem 403 (`csrfCheck`).
  2. Mutações com `Origin` também precisam do cookie `dash_csrf` (SameSite=Lax, HttpOnly),
     emitido nos GETs. Um site de outra origem não consegue forjar esse cookie.
- **Verificado por:** `test/unit/security-ext.test.js`,
  `test/integration/http-seguranca.test.js`, `test/integration/api-ext.test.js` e
  `test/seguranca/superficie-ataque.test.js` (toda mutação de toda rota).

### 10. XSS (conteúdo mostrado na tela)
- **Ameaça:** dados do servidor (pontos de montagem, serviços, comandos de processo,
  mensagens) ou anotações com HTML ou JavaScript.
- **Mitigação:** a tela só monta HTML pelo template `html` (`public/js/core/html.js`), que
  escapa toda interpolação. HTML cru só por `raw()` explícito. A CSP não permite script nem
  estilo inline nem `eval`.
- **Verificado por:** `test/unit/front-core.test.js`, `test/e2e/telas.test.js` (uma
  anotação com `<img onerror=…>` aparece como texto), `test/seguranca/payloads-owasp.test.js`
  (13 payloads de XSS) e `test/seguranca/invariantes-estaticas.test.js` (nada de
  `innerHTML` fora do template, nem `style="…"`).

### 11. Acesso ao painel sem credencial
- **Ameaça:** outro usuário desta máquina (ou um programa local) lê a API do painel.
- **Mitigação:** a instalação gera um `DASH_TOKEN`. Com ele, a API e o SSE exigem sessão
  (cookie `dash_session`, HttpOnly + SameSite=Strict, com prazo renovado com o uso) ou
  `Authorization: Bearer <token>`. O token nunca vai na URL e o JavaScript não o guarda.
  Em disco fica só o SHA-256 da sessão. O login tem limite de tentativas por minuto, e o
  link do `./dashboard abrir` (`/entrar`) vale uma vez só, por pouco tempo (valores no
  AGENTS, "Regras de segurança"). A comparação usa `crypto.timingSafeEqual`. A Ajuda tem "Sair" e "Encerrar todas as sessões". As
  respostas da API e do assistente vão com `Cache-Control: no-store` e não ficam no cache
  de disco do navegador.
- **Verificado por:** `test/integration/api-sessao.test.js`,
  `test/unit/http-session.test.js` e `test/seguranca/superficie-ataque.test.js`.

### 12. Leitura de arquivos locais por outro usuário
- **Ameaça:** outro usuário desta máquina lê `.env`, a chave do painel ou `data/`
  (hostnames, IPs, telemetria), ou o painel grava fora de `data/`.
- **Mitigação:** `data/` e `data/ssh/` com 0700; `.env`, chave e arquivos de dados com
  0600, mesmo com `umask` aberta. `HISTORY_FILE`, `LOG_FILE` e `SSH_CONFIG` são forçados
  para dentro de `data/` (`clampPathToData`). Quando o systemd da máquina permite, o
  serviço de usuário roda isolado (`NoNewPrivileges`, `ProtectSystem=strict`, só grava em
  `data/`); se não permitir, a instalação avisa e segue sem o isolamento. O
  `./dashboard diagnosticar` aponta arquivo aberto demais e o `chmod` exato.
- **Verificado por:** `test/unit/security-fixes.test.js`, `test/unit/config.test.js`,
  `test/unit/setup-nucleo.test.js`, `test/integration/cli-manutencao.test.js` e
  `test/seguranca/invariantes-estaticas.test.js` (toda escrita do painel com 0600).

### 13. Resposta maliciosa do servidor
- **Ameaça:** um servidor comprometido devolve uma saída montada para quebrar o parser,
  injetar conteúdo na tela ou encher a memória desta máquina.
- **Mitigação:** a saída é só lida, nunca executada. O parser tolera qualquer texto
  (campo ausente vira `null`) e a tela escapa tudo (ameaça 10). A resposta do SSH tem limite
  de 1 MB: acima disso, a conexão é cortada e a coleta falha com o motivo.
- **Verificado por:** `test/unit/collector-fuzz.test.js`,
  `test/integration/collector-local.test.js` e `test/seguranca/payloads-owasp.test.js`
  (1 MB de saída hostil lido em tempo limitado).

### 14. Abuso dos endpoints
- **Ameaça:** excesso de "coletar agora" sobrecarrega o servidor, ou requisições grandes
  sobrecarregam esta máquina.
- **Mitigação:** `/api/poll` fica bloqueado durante uma coleta e tem um intervalo mínimo
  entre coletas manuais. O corpo JSON tem tamanho máximo (413 acima, também sem
  `Content-Length`), as mutações têm limite por minuto por IP (`makeRateLimit`) e o SSE tem
  número máximo de conexões. Os valores ficam no AGENTS ("Regras de segurança").
- **Verificado por:** `test/integration/api-ext.test.js`,
  `test/integration/http-seguranca.test.js`, `test/integration/api-sse.test.js` e
  `test/seguranca/payloads-owasp.test.js`.

### 15. Formula injection no export (CSV)
- **Ameaça:** células que começam com `=`, `+`, `-`, `@`, TAB ou CR viram fórmula no Excel
  e no LibreOffice. O `host` e o `kernel` vêm do servidor monitorado (ameaça 13).
- **Mitigação:** `server/csv.js` põe `'` antes desses valores e coloca entre aspas a célula
  com vírgula, aspas ou quebra de linha (`csvEscape`). O nome do arquivo exportado também
  é saneado.
- **Verificado por:** `test/unit/csv.test.js`, `test/unit/csv-ext.test.js` e
  `test/seguranca/payloads-owasp.test.js`.

### 16. Detalhes internos em mensagens de erro
- **Ameaça:** um erro com stack trace revela caminhos e versões do ambiente.
- **Mitigação:** o error handler central devolve só `{ "error": "<mensagem curta>" }`,
  **sem stack trace**, caminho ou nome de biblioteca. Erro interno vira `500` genérico.
- **Verificado por:** `test/integration/api-ext.test.js` e
  `test/seguranca/superficie-ataque.test.js` (toda resposta de toda rota, inclusive os
  erros).

### 17. Prototype pollution pelo JSON ou pela query
- **Ameaça:** um corpo `{"__proto__": {…}}` ou uma query `?__proto__[x]=1` altera o
  protótipo de todos os objetos do processo e muda o comportamento do painel.
- **Mitigação:** o leitor do corpo JSON (`server/http/router.js`) descarta as chaves
  `__proto__`, `constructor` e `prototype`; a query é lida num objeto sem protótipo
  (`Object.create(null)`) e também recusa esses três nomes.
- **Verificado por:** `test/seguranca/payloads-owasp.test.js` e
  `test/seguranca/invariantes-estaticas.test.js`.

### 18. Negação de serviço por regex ou entrada patológica (ReDoS)
- **Ameaça:** um texto montado para causar backtracking em uma regex (Host, Origin,
  cookies, código do assistente, validadores da instalação, saída do servidor) trava o
  painel.
- **Mitigação:** as regex que tocam entrada externa são ancoradas e lineares; `new RegExp`
  só com texto fixo ou escapado; corpo JSON com tamanho máximo; JSON profundo ou quebrado
  vira 4xx.
- **Verificado por:** `test/seguranca/payloads-owasp.test.js` (100 mil caracteres hostis
  contra cada regex, com teto de tempo) e `test/seguranca/invariantes-estaticas.test.js`.

### 19. Cadeia de suprimentos e CI (OWASP A03:2025)
- **Ameaça:** uma dependência, uma ferramenta, uma action do CI ou o próprio Node baixado
  trocados por versões maliciosas; ou o script de coleta alterado sem querer, quebrando o
  `authorized_keys` de quem já usa.
- **Mitigação:** zero dependências de runtime; o lockfile só aceita o registro oficial com
  integridade sha512; o Node é conferido pela soma SHA-256 **antes** de extrair; versões
  assinadas (ameaça 7); ferramentas de segurança em imagens presas por digest; actions do
  CI presas por SHA, só leitura e sem segredos (ADR 0014); hash dourado do script de
  coleta; Dependency Review em todo PR, OpenSSF Scorecard e Dependabot com 14 dias de espera
  por versão nova (ADR 0016); o GitHub só aceita actions do GitHub e do Scorecard, presas
  por SHA, e PR de fora só roda o CI com aprovação (ADR 0017).
- **Verificado por:** `test/seguranca/cadeia-suprimentos.test.js`, `test/unit/vendor.test.js`
  e `test/integration/assinatura.test.js`.

### 20. Vazamento pelo repositório público (OSINT)
- **Ameaça:** um segredo, um IP da rede de quem desenvolve, um e-mail pessoal ou dados do
  servidor real publicados por engano e colhidos por robôs que varrem o GitHub.
- **Mitigação:** `.env`, `data/` e chaves no `.gitignore`; fixtures só pela captura anônima
  (`npm run capturar-amostra`); exemplos só com IPs de documentação; commits e tags com o
  e-mail *noreply* do GitHub. O Gitleaks varre os arquivos **e todo o histórico** a cada PR.
- **Verificado por:** `test/seguranca/segredos-osint.test.js` (tudo que vai para o
  repositório, antes do commit) e `scripts/seguranca.mjs` (Gitleaks). Análise do que o
  histórico já expõe: [linha de base](docs/seguranca/2026-10-16-linha-de-base.md#osint-o-que-o-repositório-público-revela).

### 21. Saída do painel para a internet (ADR 0030)
- **Ameaça:** a procura diária de versão nova é a única conexão do painel além do SSH da coleta. Ela
  poderia aceitar uma versão adulterada, abrir uma pergunta de senha, segurar o painel ou ser
  disparada por outro site.
- **Mitigação:** só `git fetch --tags` para o `origin` do clone, sem API de terceiros e sem
  telemetria. Só vale tag assinada, conferida com a lista de chaves da versão instalada; a tag nova
  não se autoaprova. Roda em processo à parte, com `nice`, teto de tempo e sem perguntas. O "Procurar
  agora" exige sessão, passa pelo CSRF e aceita 1 pedido por minuto. As novidades são texto de uma
  tag assinada e passam pelo template `html`. A procura não troca de versão: a tela só avisa.
- **Verificado por:** `test/integration/atualizacao.test.js`, `test/unit/atualizacao.test.js` e
  `scripts/mutacao-seguranca.mjs` (aviso sem conferir a assinatura, "procurar agora" sem limite).

---

## OWASP Top 10:2025

Onde cada categoria do [OWASP Top 10:2025](https://top10.owasp.org/2025) é tratada no
painel. `test/unit/docs.test.js` confere que cada linha aponta um teste.

| Categoria | Ameaças acima | Verificado por |
|---|---|---|
| A01 Broken Access Control | 6, 8, 9, 11, 12 | `test/seguranca/superficie-ataque.test.js`, `test/seguranca/payloads-owasp.test.js` (path traversal) |
| A02 Security Misconfiguration | 12, 16 e cabeçalhos (CSP, COOP/COEP/CORP, no-store) | `test/seguranca/superficie-ataque.test.js`, `test/seguranca/invariantes-estaticas.test.js` |
| A03 Software Supply Chain Failures | 7, 19 | `test/seguranca/cadeia-suprimentos.test.js`, `test/unit/vendor.test.js` |
| A04 Cryptographic Failures | 4, 5, 11, 20 | `test/seguranca/invariantes-estaticas.test.js`, `test/seguranca/segredos-osint.test.js`, `test/unit/http-session.test.js` |
| A05 Injection | 1, 3, 10, 13, 15 | `test/seguranca/payloads-owasp.test.js`, `test/unit/config.test.js`, `test/unit/setup-nucleo.test.js` |
| A06 Insecure Design | 2, 3 (acesso mínimo, servidor só leitura) | `test/integration/ssh-restrito.test.js`, `test/unit/collector-builder.test.js` |
| A07 Authentication Failures | 6, 11 | `test/integration/api-sessao.test.js`, `test/seguranca/superficie-ataque.test.js` |
| A08 Software or Data Integrity Failures | 7, 17, 19 | `test/integration/assinatura.test.js`, `test/seguranca/payloads-owasp.test.js`, `test/seguranca/cadeia-suprimentos.test.js` |
| A09 Security Logging and Alerting Failures | log sem segredo; alertas de queda e de serviço | `test/seguranca/invariantes-estaticas.test.js`, `test/unit/alerts-engine.test.js` |
| A10 Mishandling of Exceptional Conditions | 13, 14, 16, 18 | `test/seguranca/payloads-owasp.test.js`, `test/unit/collector-fuzz.test.js`, `test/integration/api-ext.test.js` |

---

## Verificação contínua

A verificação é redundante de propósito: cada camada pega o que a outra pode deixar passar.
Os detalhes estão no AGENTS ("Verificação em camadas") e na ADR 0014.

1. **`npm run check`**, antes de todo commit. Inclui os testes de `test/seguranca/`:
   regras estáticas, matriz de ataque, payloads do OWASP, OSINT e cadeia de suprimentos.
2. **`npm run seguranca`**: Semgrep (regras OWASP), Gitleaks, ShellCheck, OSV-Scanner,
   OWASP ZAP e a **mutação dos guardas**, que quebra cada proteção de propósito e exige que
   um teste acuse.
3. **CI no GitHub** a cada push no `main` e a cada PR, com as duas etapas acima e o e2e.
4. **CodeQL** do GitHub (suíte *extended*). Cada alerta é corrigido ou descartado como
   falso positivo, com a análise em `docs/seguranca/`.

Análises publicadas:
- [Alertas do CodeQL de 16/10/2026](docs/seguranca/2026-10-16-codeql.md): viés no sorteio
  do código do assistente, corrigido; escape do `authorized_keys`, falso positivo.
- [Alertas do CodeQL *extended*](docs/seguranca/2026-10-16-codeql-extended.md): nome de
  parâmetro da query (endurecido) e conferir-e-depois-ler em testes (corrigido).
- [Alerta 8 do CodeQL](docs/seguranca/2026-10-16-codeql-file-access-to-http.md): dado de
  arquivo num pedido HTTP do cliente dos testes, falso positivo (destino só `127.0.0.1`,
  travado por teste).
- [Linha de base da 2.0.1](docs/seguranca/2026-10-16-linha-de-base.md): resultado de todas
  as ferramentas na `v2.0.0`, correções feitas e o que o repositório público revela.
- Achados aceitos depois de análise: `docs/seguranca/excecoes.json`.

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
- Para trocar o `DASH_TOKEN`: gere um novo com `openssl rand -base64 32` (a instalação usa
  32 bytes aleatórios), troque no `.env` e rode `./dashboard parar` e `./dashboard iniciar`.
  As sessões já abertas **continuam valendo** (elas não dependem do token): depois, use
  "Encerrar todas as sessões" na Ajuda, ou apague `data/sessions.json` com o painel parado.

---

## Trocar a chave do painel (se ela vazou)

1. Veja qual é a chave no `IdentityFile` de `data/ssh/config` (ex.:
   `~/.ssh/dashboard-<servidor>-<id>`) e anote o ID (os 8 últimos caracteres do nome).
2. No servidor, apague a linha que termina com `:<id>` no `authorized_keys` do `dashmon`
   e o arquivo `/etc/sudoers.d/dashboard-<computador>-<id>`. A chave antiga deixa de valer.
   As linhas dos outros computadores ficam.
3. Apague a chave local e o `.pub` e rode `./dashboard reconfigurar`. Ele cria uma chave
   nova, com outro ID, e o passo "Preparar o servidor" grava a linha dela.
4. Rode `./dashboard diagnosticar`. O resultado deve ser "nenhum aviso, nenhum erro".

Instalações vindas da V1 usam a chave da V1, com acesso completo ao servidor, até o
primeiro `./dashboard reconfigurar`. Depois dele, remova a linha antiga da V1 do
`authorized_keys` do usuário que ela usava no servidor.
