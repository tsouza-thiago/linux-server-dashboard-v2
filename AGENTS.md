# Server Dashboard — referência técnica (agentes e desenvolvimento)

Painel de monitoramento, em tempo real, de um servidor Linux da rede local. Toda a carga
fica na máquina local; o servidor só responde **1 comando SSH por minuto**. Este requisito
é obrigatório: o hardware do servidor é muito limitado.

Este arquivo é a **referência técnica única** do projeto: regras, arquitetura,
configuração, coleta, formato da amostra, persistência, API e alertas. Os outros
documentos não repetem estes detalhes:

- [README.md](README.md): visão geral, instalação e comandos.
- [TUTORIAL.md](TUTORIAL.md): passo a passo para leigos.
- [SECURITY.md](SECURITY.md): modelo de ameaças.
- [CONTRIBUTING.md](CONTRIBUTING.md): o caminho de uma contribuição (issue, PR, checks).
- [docs/ROADMAP.md](docs/ROADMAP.md): as próximas features, por complexidade, com o
  planejamento de cada uma em `docs/roadmap/`.

O teste `test/unit/docs.test.js` confere esta documentação contra o código.

## Regras (obrigatórias)

- **1 único SSH por coleta**, com um comando combinado. Nada de conexões em paralelo
  contra o servidor.
- **Servidor somente leitura.** Nunca compilar, instalar pacotes ou rodar scripts pesados
  **no servidor**. Não há agente nem dependência no servidor.
- O servidor é modesto (1 núcleo, pouca RAM) e tem discos **SMR**: evitar escrita
  intensa ou aleatória nele.
- **Apenas comandos não interativos.** O painel conecta pelo alias `servidor` do
  `data/ssh/config`. Para inspeções à mão, use o seu alias do `~/.ssh/config`
  (ex.: `ssh meu-servidor '<comando>'` → `usuario@192.0.2.10:22`).
- **NUNCA** exibir, imprimir ou commitar o conteúdo de `.env`: ele guarda o `DASH_TOKEN`
  (o acesso ao painel). O painel não guarda senha: a coleta usa uma chave SSH. A senha do
  administrador serve só na instalação, fica na memória e é descartada.
- **Nunca commitar `data/`.** Ela tem hostnames, IPs e telemetria da rede interna.
- Dado dinâmico (temperatura, espaço, status) é sempre coletado ao vivo, nunca presumido.
  Dado ausente é `null`, nunca zero inventado.
- O painel escuta só em `127.0.0.1`.

### Invariantes (citadas no código como I1–I10)

| # | Invariante | Como é garantida |
|---|---|---|
| I1 | 1 SSH por coleta, sem paralelismo | trava de coleta; "coletar agora" com intervalo mínimo; o `diagnosticar` reaproveita a última amostra |
| I2 | Servidor só leitura | o script só lê `/proc`, `/sys`, `df`, `systemctl is-active`, `ps` e `smartctl -H`; o que a instalação cria lá é mostrado antes e reversível |
| I3 | Discos SMR: nada de escrita no servidor | SMART 1 vez por hora (cada `sudo` grava 1 linha de log lá) |
| I4 | Não interativo e imune ao idioma | `LC_ALL=C`, `BatchMode=yes`, `ConnectTimeout=10` |
| I5 | Dado ausente é `null`, nunca zero inventado | parser, agregados e formatação da tela |
| I6 | Só `127.0.0.1` | teste do endereço de escuta e regra estática |
| I7 | `.env` e `data/` fora do git; acesso por chave | `.gitignore`, `npm run check` e `test/seguranca/segredos-osint.test.js` |
| I8 | Nada da configuração vira comando | `sanitizeToken`/`sanitizeHost` + fuzz e payloads |
| I9 | Proteções HTTP (Host, CSRF, CSP, escape, CSV, permissões, token, limites, erros) | `test/integration/http-seguranca.test.js` (caracterização) e `test/seguranca/` |
| I10 | Interatividade toda no navegador | nenhuma ação da tela abre SSH, exceto "coletar agora" |

### Regras de segurança (security by design)

- **Configuração centralizada** em `server/config.js`: parser único do `.env` (com override
  de `process.env`), validação de faixas (tabela [Configuração](#configuração)) e caminhos
  de dados forçados para dentro de `data/` (`clampPathToData`).
- **Anti-injeção**: `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS`, `SMART_DEVS` e `SERVICES` passam
  por `sanitizeToken()` (whitelist `[A-Za-z0-9_./:-]`, recusa token iniciado com `-`)
  **antes** de entrar no script de coleta (`server/collector/builder.js`). `SSH_HOST`
  passa por `sanitizeHost()`, e `runSSH()` recusa host iniciado com `-`.
- **Host check** (`server/security.js`): `Host` diferente de `localhost`, `127.0.0.1` ou
  `[::1]` recebe 403. Isto bloqueia DNS rebinding.
- **CSRF em 2 camadas**: mutações (POST/PUT/PATCH/DELETE) com `Origin` diferente do Host
  ou com `Sec-Fetch-Site: cross-site` recebem 403. Mutações com `Origin` também precisam
  do cookie `dash_csrf` (SameSite=Lax, HttpOnly), emitido nos GETs.
- **Cabeçalhos** em todas as respostas, inclusive 401/403/404: CSP sem `'unsafe-inline'`
  e sem `'unsafe-eval'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener/Resource/Embedder-Policy` e `Permissions-Policy`. API, `/entrar` e o
  assistente respondem com `Cache-Control: no-store`.
- **Anti-XSS** (ADR 0010): a tela monta HTML só pelo template `html` de
  `public/js/core/html.js`, que escapa toda interpolação. HTML cru só por `raw()`
  explícito. Medidas vindas dos dados (largura de barra, cor) vão em `data-w`/`data-bg`/…
  e são aplicadas pelo CSSOM em `mount()`. Nunca `style="…"` no HTML.
- **Export seguro**: `server/csv.js` impede formula injection (`=+-@`, TAB e CR → prefixo `'`) e
  saneia o nome do arquivo.
- **Permissões**: `data/` e `data/ssh/` com 0700; `.env`, chave e arquivos de dados com
  0600. A instalação grava assim (`server/setup/local.js`), a escrita também
  (`{ mode: 0o600 }`) e o `./dashboard diagnosticar` aponta o que estiver aberto.
- **Token e sessão** (ADR 0007): a instalação gera um `DASH_TOKEN`. Com ele, `/api/*` e
  `/api/stream` exigem sessão (cookie `dash_session`, HttpOnly + SameSite=Strict, 30 dias
  renovados com o uso) ou `Authorization: Bearer <token>`. O token é trocado 1 vez em
  `/api/login` (10 tentativas/min/IP). Em disco (`data/sessions.json`) fica só o SHA-256
  da sessão. `?token=` na URL **não** vale. Comparação com `crypto.timingSafeEqual`.
  `GET /entrar?codigo=` aceita o link de uso único do `./dashboard abrir` (só o hash em
  `data/entrar.json`, 2 min, vale 1 vez).
- **Limites**: `/api/poll` com piso de 5 s entre coletas manuais; mutações da API com 120
  por minuto por IP; corpo JSON com até 50 KB (413 acima); SSE com até 20 conexões (503
  acima); resposta do SSH com até 1 MB (`MAX_OUTPUT_BYTES`; acima disso a conexão é
  cortada).
- **Erros sem vazamento**: o error handler central devolve JSON sem stack trace.
- **HTTP próprio** (ADR 0003): `node:http` + `server/http/` (roteador, estáticos só de
  `public/` com lista de tipos, sem arquivo oculto, pasta ou traversal; HTML, CSS, JS, JSON
  e SVG em gzip quando o navegador aceita, só arquivos do pacote; todos com `no-cache` +
  `ETag`, 304 sem mudança, para a versão nova valer logo depois de atualizar). Backend sem
  dependência de runtime. `test/integration/http-seguranca.test.js` é a caracterização
  caixa-preta e precisa continuar verde.
- **SSH isolado**: `BatchMode=yes` + `ConnectTimeout=10`. Com `SSH_CONFIG`, o painel usa só
  `ssh -F data/ssh/config`, com `known_hosts` próprio e `StrictHostKeyChecking yes`
  (nunca `no` nem `accept-new` depois da instalação).
- **Acesso restrito** (ADR 0008, `SSH_ACESSO=restrito`): usuário `dashmon` sem senha. A
  linha do `authorized_keys` é `restrict,from=,command="<coleta>"`, gerada e escapada em
  `server/setup/acesso.js` (conferida contra o `opt_dequote` do OpenSSH). O painel envia só
  a palavra do modo (`basico` ou `smart`); qualquer outro texto vira `basico`. Sudoers com
  um `smartctl -H /dev/X` por disco, nunca curinga, validado com `visudo -cf`.
- **Vários computadores** (ADR 0020): cada instalação tem um ID (8 hex do SHA-256 da chave
  pública) e troca só a sua linha do `authorized_keys` (comentário
  `dashboard@<computador>:<id>`) e o seu sudoers
  (`/etc/sudoers.d/dashboard-<computador>-<id>`). O nome do computador passa por
  `machineLabel()` (`[a-z0-9-]`, sem ponto) antes de virar nome de arquivo ou comando. O
  `desinstalar` tira só a parte do próprio ID; o `dashmon` sai só sem nenhuma linha.
- **Instalação** (`server/setup/`): toda entrada é validada em `acesso.js` antes de virar
  arquivo ou comando. A senha do administrador fica só em memória: o `ssh` a recebe pelo
  askpass (variável de ambiente só daquele processo), e o `sudo -S -k` pelo stdin. Ela
  nunca vai na linha de comando e é descartada no fim do passo 5. O assistente web só abre
  com código de uso único e tem as mesmas proteções do painel.
- **Entrada por chave** (ADR 0021): o apelido do `~/.ssh/config` é lido com `ssh -G` (não
  conecta) e só os valores dele vão para o `runAdmin` (`server/setup/remoto.js`):
  `-F /dev/null`, `-i <IdentityFile>`, `IdentitiesOnly=yes`, o `IdentityAgent` do apelido,
  `BatchMode=yes` e o `known_hosts` do painel. `ProxyJump` e `ProxyCommand` são recusados. A
  passphrase fica no ssh-agent: o painel compara o `ssh-add -L` com o `.pub` e mostra o
  `ssh-add -t 15m <chave>` quando falta. A senha do sudo é separada da do SSH (estado
  `pede-senha` da detecção) e vai só pelo stdin. O preparo começa por uma conferência só de
  leitura do sshd (`sshd -T -C user=dashmon,…`) que avisa o que barraria o `dashmon`; o
  painel nunca altera o `sshd_config`.
- **Comando no PATH** (ADR 0028): o link `~/.local/bin/dashboard` nunca sobrescreve outro programa
  e só troca o de outra pasta com o sim. O arquivo de login só muda com o sim (`--editar-profile` no
  modo sem perguntas): cópia antes, bloco marcado e fixo, sem nenhum dado da configuração. O
  `desinstalar` tira só o link desta pasta e só o bloco. As mensagens da CLI usam `out.cmd`
  (`server/cli/saida.js`); as telas e os logs do painel seguem com `./dashboard`.
- **Autocomplete** (ADR 0029): `scripts/completar.bash` é estático, lê o `~/.ssh/config` sem rodar
  `ssh` e só sugere nomes `[A-Za-z0-9_.-]`, sem passar o arquivo pelo `compgen -W` (ele expandiria
  `$(...)`). O link segue as regras do link do comando. O `~/.bashrc` só muda sem o pacote
  `bash-completion` e com o sim (`--editar-profile` no modo sem perguntas), com as mesmas garantias
  do arquivo de login. `test/unit/autocomplete.test.js` confere comandos e opções contra o código.
- **Versões assinadas** (ADR 0012): o instalador e o `./dashboard atualizar` só aceitam
  tags assinadas por uma chave de `docs/allowed_signers`.
- **Code scanning** (CodeQL padrão do GitHub, a cada push): todo alerta é corrigido ou
  descartado como falso positivo com a análise em `docs/seguranca/` e, se possível, um
  teste que falhe na forma errada. Não aplique a sugestão do CodeQL sem conferir o formato
  real (ex.: o escape do `authorized_keys` segue o `opt_dequote`, não o padrão genérico).
- **Verificação em camadas** (redundante de propósito):
  1. `test/seguranca/` roda em todo `npm run check`: regras estáticas no código
     (`invariantes-estaticas`), matriz de ataque gerada das rotas reais
     (`superficie-ataque`), corpus de ataques OWASP (`payloads-owasp`), segredos e OSINT
     no que vai para o repositório público (`segredos-osint`) e cadeia de suprimentos,
     inclusive o hash dourado do script de coleta (`cadeia-suprimentos`).
  2. `npm run seguranca` (`scripts/seguranca.mjs`): Semgrep (regras OWASP), Gitleaks
     (arquivos, sem o Node de `.runtime/`, e histórico), ShellCheck, OSV-Scanner e OWASP ZAP (ataque ativo e
     autenticado a um painel de teste), em imagens Docker presas por digest; e a mutação
     dos guardas (`scripts/mutacao-seguranca.mjs`): cada proteção é quebrada de propósito
     numa cópia e algum teste precisa acusar. Achado médio ou alto só passa com análise
     em `docs/seguranca/excecoes.json`. Para rodar só algumas etapas:
     `npm run seguranca -- --so=semgrep,shell` ou `--pular=zap` (etapas: `semgrep`,
     `segredos`, `shell`, `osv`, `zap`, `mutacao`; nome errado sai com erro).
  3. CI no GitHub (ADR 0014, `.github/workflows/seguranca.yml`), a cada push no `main` e
     a cada PR: `npm run check`, `npm run test:e2e` com `E2E_OBRIGATORIO=1` (sem
     navegador, falha em vez de pular) e `npm run seguranca`. Actions presas por SHA,
     permissão só de leitura, sem segredos.
  4. Ferramentas gratuitas do GitHub (ADR 0016): Dependency Review em todo PR
     (`.github/workflows/dependencias.yml`: reprova vulnerabilidade moderada ou pior e
     licença incompatível), OpenSSF Scorecard a cada push no `main` e toda segunda
     (`.github/workflows/scorecard.yml`, resultado no code scanning), Dependabot de versões
     para as actions e o npm (`.github/dependabot.yml`, semanal, com 14 dias de espera por
     versão nova), alertas do Dependabot e secret scanning com push protection.
  5. Superfície pública mínima (ADR 0017): o GitHub só aceita actions do GitHub e a
     `ossf/scorecard-action`, presas por SHA; PR de fora só roda o CI com aprovação; logs e
     artefatos ficam 30 dias; a Wiki só é editada por colaboradores; o quadro do Projects é
     privado; o PR só entra no `main` atualizado com ele. Alertas do Scorecard sem correção:
     análise em `docs/seguranca/2026-10-19-scorecard.md`.

## Desenvolvimento (obrigatório)

- **Decisões:** `docs/adr/` (uma ADR por decisão; ADR aceita não é editada, é substituída
  por outra). O plano da V2 (fases F0–F9, decisões D0–D13, perguntas Q1–Q20) está concluído
  e fica como registro histórico na
  [tag v2.0.0](https://github.com/tsouza-thiago/linux-server-dashboard-v2/blob/v2.0.0/docs/PLANO_V2.md).
- **Antes de todo commit:** `npm run check` (sintaxe JS e shell, `.env`/`data/` fora do git,
  testes + cobertura com `test/seguranca/`, `npm audit`). Nenhum commit vermelho. Se um teste
  falhar, o relatório diz o nome dele e a saída completa fica em `.check/ultima-falha.log`.
- **Mudou código de segurança, removeu código ou terminou uma etapa?** Rode também
  `npm run seguranca` (precisa de Docker; sem ele, as ferramentas externas são puladas e a
  mutação roda assim mesmo).
- **Documentação junto com o código:** mudou comando, opção, variável, rota ou arquivo?
  Atualize este arquivo (e o README/TUTORIAL, se a pessoa usuária vê a mudança).
  `test/unit/docs.test.js` falha se a documentação divergir do código.
- **Commits:** Conventional Commits em PT-BR (`feat(escopo):`, `fix:`, `test:`, `docs:`,
  `refactor:`, `style:`, `perf:`, `chore:`, `security:`), uma mudança lógica por commit.
- **CHANGELOG.md** atualizado no mesmo commit da mudança (Keep a Changelog).
- **Bug conhecido** ainda sem correção entra como issue e como teste `todo` no arquivo de
  testes da área, com o número da issue no nome; o commit que corrige tira o `todo` e o
  teste vira regressão. Os 12 bugs da V1 (B1–B12),
  todos corrigidos na V2, são regressões em `test/unit/bugs-v1.test.js`.
- **Versões:** SemVer a partir da `v2.0.0`: `PATCH` corrige, `MINOR` acrescenta sem quebrar,
  `MAJOR` quebra (configuração, formato de `data/` ou acesso ao servidor). Pré-versões
  (`-rc.N`) só chegam a quem já está numa pré-versão ou usa `--pre`
  (`./dashboard instalar --pre`, `./dashboard atualizar --pre`): uma instalação nova a
  partir do `main` fica na estável assinada mais nova, mesmo que o último commit tenha uma
  tag `-rc`. Toda versão é uma tag assinada + GitHub Release (abaixo).
- **Entregas pequenas** (ADR 0015 e 0023): um PR por mudança lógica. Correção sai como
  `PATCH` (2.0.2, 2.0.3…). As versões sobem conforme os milestones, e mudança pequena sai
  direto na versão estável, sem pré-versão. A pré-versão fica para mudança grande (níveis G e
  GG do `docs/ROADMAP.md`). As `PATCH` da fila saem antes da 1ª pré-versão; correção urgente
  durante as pré-versões sai de um ramo `manutencao/X.Y` criado da última
  tag e volta ao `main` por merge. Merge com merge commit, sem squash nem reescrita do
  `main`. Documentação sem código não gera versão: sai nas notas da próxima.
- **Issue primeiro** (ADR 0016): toda mudança começa numa issue aberta pelo formulário do
  tipo (bug, funcionalidade, tarefa), com rótulos de tipo, área, prioridade e semver, no
  milestone da versão em que deve sair e no quadro do Projects. O PR fecha a issue
  (`Closes #N`) e segue o template; o merge exige os checks obrigatórios e o "pode publicar"
  do mantenedor. Dúvidas e ideias vão para Discussions; vulnerabilidade, só pelo reporte
  privado do GitHub, nunca em issue pública. Exceções: PRs do Dependabot e o commit de
  versão.
- **Imagens da documentação:** `docs/img/` tem só o que o `npm run capturar-telas` gera, do painel
  de teste. Nunca use print de uma instalação real. Antes do commit, olhe cada imagem nova: nenhum
  teste enxerga o que há dentro dela. Orçamento: 200 KB por arquivo e 3 MB na pasta
  (`test/unit/docs.test.js`). Refaça só quando a tela mudar de forma visível: cada versão de
  imagem fica no histórico para sempre.
- **Testes no navegador** (ADR 0019): toda mudança de tela é conferida no navegador real,
  pela extensão Claude in Chrome, num painel de teste (`npm run painel-teste`). A bateria
  completa segue [docs/testes-no-navegador.md](docs/testes-no-navegador.md) e roda antes de
  cada versão publicada. O PR registra o resultado; cada falha nova vira uma issue de bug.
- **Orçamento de desempenho:** veja [Orçamento de desempenho](#orçamento-de-desempenho).
  Mudou coleta, histórico ou frontend? Rode `npm run soak` e `npm run test:e2e`.
- **Node.js 24** é a versão mínima (ADR 0002).
- **Navegadores:** Chrome/Edge, Firefox e Safari, nas 2 últimas versões (ES modules,
  `<dialog>` e CSS moderno, sem polyfill).
- **Exemplos** usam só IPs de documentação (`192.0.2.x`, RFC 5737) e nomes genéricos.

### Publicar uma versão (ADR 0012)

1. PR no `main` com o CI verde, a seção `[X.Y.Z] — data` no CHANGELOG e a versão no
   `package.json` e no `package-lock.json`. As issues da versão estão no milestone dela.
2. Depois do merge, na máquina do mantenedor, com a chave listada em `docs/allowed_signers`:

   ```bash
   git fetch origin && git checkout --detach origin/main
   git -c gpg.format=ssh -c user.signingkey=~/.ssh/thiago-assinatura-releases-linux-server-dashboard-v2_ed25519.pub tag -s vX.Y.Z -m "vX.Y.Z"
   git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=docs/allowed_signers verify-tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. Release no GitHub **escolhendo a tag que já existe** (`gh release create vX.Y.Z
   --verify-tag`), com as notas do CHANGELOG e as issues fechadas. A interface do GitHub
   cria tags leves, sem assinatura, que o instalador ignora. Depois, feche o milestone.

Trocar a chave exige um commit em `docs/allowed_signers` **antes** da tag nova: quem já tem
o painel instalado só aceita a versão nova se a chave dela estiver na lista da versão
instalada. Sem a chave antiga (troca da 2.1.1, #64), quem está numa versão anterior precisa
de um passo manual uma vez, descrito nas notas da versão: conferir a impressão digital da
chave nova no `verify-tag` e fazer o checkout da tag.

## Arquitetura

```
[Servidor Linux]  ← 1 SSH/min (script único, LC_ALL=C, não interativo, somente leitura)
        ↑
[poller]  coleta → parse → taxas → alertas → amostra (schemaVersion 2)
        ↓
[storage]  data/history/ (72 h brutas, NDJSON) + data/rollup/ (90 dias em baldes de 5 min)
        ↓
[node:http 127.0.0.1:3000]  telas + API REST + SSE (tempo real)
        ↓
[Navegador]  8 telas (ES modules + uPlot, sem build), saúde, eventos, relatórios
```

Toda a interatividade (filtros, ordenação, zoom, previsão, agregações) roda no
navegador. O backend só coleta, persiste e serve. O limite de 1 SSH por minuto continua.

## Comandos

```bash
./dashboard instalar            # assistente no navegador (--terminal: TUI; --sem-interface: sem perguntas)
./dashboard instalar --importar-v1 <pasta>   # upgrade V1 → V2 (para a V1, traz .env e data/)
./dashboard instalar --sem-assinatura        # só para desenvolvimento: pasta sem tag assinada (cópia, ramo)
./dashboard instalar --sem-link              # não cria o comando dashboard (~/.local/bin/dashboard) nem o autocomplete, nos 3 modos
./dashboard instalar --sem-interface --editar-profile  # põe ~/.local/bin no PATH pelo arquivo de login e, sem o bash-completion, carrega o autocomplete pelo ~/.bashrc, com cópia antes
./dashboard abrir               # abre o painel já logado (link de uso único)
./dashboard iniciar             # serviço de usuário ou segundo plano
./dashboard parar               # para só o processo do painel desta pasta (PID conferido, B12)
./dashboard status              # rodando ou parado
./dashboard diagnosticar        # explica cada problema; reaproveita a última amostra e só coleta se ela estiver velha
./dashboard reconfigurar        # reabre o assistente
./dashboard atualizar           # tag assinada mais nova, backup de data/, volta atrás se falhar
./dashboard desinstalar         # remove daqui e oferece limpar a parte deste computador no servidor
./dashboard versao              # versão instalada
npm start                       # o painel em primeiro plano (node --max-semi-space-size=2 --optimize-for-size server/index.js)
npm run poll                    # 1 coleta, sem o servidor web (node server/poller.js --once)
npm test                        # suíte de testes (node --test)
npm run check                   # verificação completa, obrigatória antes de cada commit
npm run test:unit               # só testes unitários (test/unit)
npm run test:integration        # só integração (HTTP, shell, ssh falso, sshd real)
npm run test:seguranca          # só a rede de segurança (test/seguranca)
npm run seguranca               # Semgrep, Gitleaks, ShellCheck, OSV, OWASP ZAP e mutação (Docker)
npm run test:e2e                # ponta a ponta no Chromium (playwright-core; pula sem navegador; CHROMIUM=<caminho> escolhe outro)
npm run capturar-amostra        # 1 coleta real → data/amostra-{bruta,anonima}.txt (fixtures)
npm run capturar-telas          # refaz docs/img/ a partir do painel de teste (--sem-animacao pula a animação, que usa o ffmpeg)
npm run migrar-v1 -- --verificar  # resume o data/history.json da V1 sem gravar nada
npm run migrar-v1               # migra a V1 agora (o painel também migra sozinho ao iniciar)
npm run soak                    # soak acelerado: 83 h de coletas simuladas e pedidos de 90 dias; confere RAM e vazamento
npm run painel-teste            # painel de teste com dados semeados (--cenario=normal|lacunas|offline|vazio, --porta=3943)
scripts/e2e-instalacao/rodar.sh # instalação de ponta a ponta em contêineres Debian/Ubuntu
```

Opções do modo sem perguntas: `./dashboard instalar --sem-interface --ajuda`. Servidor que só
aceita chave: `--chave-ssh <apelido>` no lugar de `--servidor`/`--usuario`/`--porta` (também
no `./dashboard desinstalar --limpar-servidor`).

## Configuração

O assistente grava o `.env` (0600). A coluna **Padrão** é o valor que o código usa quando a
variável falta ou está vazia. Valor fora da faixa volta ao padrão (os limiares avisam no
log).

| Variável | Padrão | Faixa | Descrição |
|---|---|---|---|
| `SSH_HOST` | `seu-host` | alias ou `usuario@host` | Servidor. O assistente grava `servidor`, o alias do `data/ssh/config` |
| `SSH_CONFIG` | *(vazio)* | dentro de `data/` | Configuração SSH própria (`ssh -F`). Vazio = usa o `~/.ssh/config` (V1). O assistente grava `data/ssh/config` |
| `SSH_ACESSO` | `direto` | `restrito` ou `direto` | `restrito`: a chave só roda a coleta e o painel envia só o modo. `direto`: o painel envia o script inteiro (V1). O assistente grava `restrito` |
| `POLL_INTERVAL` | `60000` | `10000`–`3600000` | Intervalo entre coletas, em ms |
| `PORT` | `3000` | `1`–`65535` | Porta do painel (só em 127.0.0.1) |
| `HISTORY_LIMIT` | `4320` | `100`–`100000` | Amostras brutas em memória (4320 = 72 h a 1 por minuto) |
| `HISTORY_FILE` | `data/history.json` | dentro de `data/` | Histórico da V1 a migrar (1 vez, com backup). A pasta dele também é a de `history/` e `rollup/`; mantenha em `data/` |
| `LOG_FILE` | `data/dashboard.log` | dentro de `data/` | Log do painel (gira em 5 MB para `dashboard.log.1`) |
| `NET_IF` | *(vazio)* | 1 interface | Interface de rede. Vazio = sem a seção de rede |
| `DISK_MOUNTS` | `/` | pontos de montagem | Pastas acompanhadas, separadas por espaço |
| `DISK_DEVS` | *(vazio)* | discos | Discos com leitura e gravação (I/O), ex.: `sda sdb` |
| `SMART_DEVS` | *(= DISK_DEVS)* | discos | Discos com teste SMART (1 vez por hora). Ausente = os de `DISK_DEVS`; presente e vazio = nenhum |
| `SERVICES` | *(vazio)* | serviços systemd | Serviços acompanhados, separados por espaço |
| `DASH_TOKEN` | *(vazio)* | texto sem espaço | Token de acesso. A instalação gera um; vazio = sem login |
| `ALERT_DISK_PCT` | `90` | `50`–`99` | Alerta de disco (% usado) |
| `ALERT_RAM_PCT` | `90` | `50`–`99` | Alerta de RAM (% usada) |
| `ALERT_TEMP_C` | `60` | `30`–`110` | Alerta de temperatura da CPU (°C) |
| `ALERT_HYSTERESIS` | `5` | `0`–`20` | Quanto o valor precisa cair abaixo do limiar para o alerta limpar |
| `ALERT_OFFLINE_AFTER` | `2` | `1`–`10` | Coletas seguidas com falha antes de "servidor inacessível" |

Mudar alvos (pastas, discos, serviços) à mão quebra a chave restrita: o script no
`authorized_keys` deixa de bater (`hashMismatch`). Use `./dashboard reconfigurar`.

## Comando SSH de coleta

O script é montado por `server/collector/builder.js`. É um único script POSIX `sh`,
somente leitura. Exemplo com `NET_IF=enpXsY`, `DISK_MOUNTS=/ /mnt/disco1`,
`DISK_DEVS=sda sdb` e `SERVICES=smbd nmbd`, no modo `smart`:

```sh
LC_ALL=C; export LC_ALL; M="${SSH_ORIGINAL_COMMAND:-smart}"; case "$M" in smart) ;; *) M=basico;; esac;
echo '===VER==='; echo '2 6443f6bd222e'; echo "$M";
echo '===HOST==='; cat /proc/sys/kernel/hostname;
echo '===OS==='; uname -r; grep -E '^(PRETTY_NAME|NAME)=' /etc/os-release 2>/dev/null;
echo '===CPU==='; getconf _NPROCESSORS_ONLN 2>/dev/null;
echo '===UPTIME==='; cat /proc/uptime;
echo '===LOAD==='; cat /proc/loadavg;
echo '===STAT==='; head -1 /proc/stat;
echo '===MEM==='; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree|Dirty|Writeback):' /proc/meminfo;
echo '===DF==='; df -B1 --output=source,target,size,used,avail,pcent,ipcent / /mnt/disco1 2>/dev/null;
echo '===NET==='; awk -F: -v i='enpXsY' '{n=$1; gsub(/[ \t]/,"",n)} n==i' /proc/net/dev;
echo '===IO==='; awk '$3=="sda"||$3=="sdb"' /proc/diskstats;
echo '===PSI==='; for f in cpu memory io; do printf '%s ' "$f"; grep -h . /proc/pressure/$f 2>/dev/null | tr '\n' ' '; echo; done;
echo '===TEMP==='; for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && printf '%s %s\n' "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"; done 2>/dev/null; true;
echo '===SMART==='; case "$M" in smart) for d in sda sdb; do
  if [ "$(id -u)" = 0 ]; then r=$(smartctl -H "/dev/$d" 2>&1); else r=$(sudo -n smartctl -H "/dev/$d" 2>&1); fi;
  case "$r" in *"result: PASSED"*|*"Health Status: OK"*) s=PASSED;; *"result: FAILED"*|*"Health Status: FAIL"*) s=FAILED;;
  *"smartctl: not found"*|*"smartctl: command not found"*) s=SEM_SMARTCTL;;
  *"sudo:"*|*ermission*|*"Operation not permitted"*) s=SEM_PERMISSAO;; *) s=DESCONHECIDO;; esac;
  printf '%s %s\n' "$d" "$s"; done;; *) echo pulado;; esac;
echo '===SERVICES==='; for s in smbd nmbd; do printf '%s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)"; done;
echo '===PS==='; ps -eo user:32,pid,pcpu,pmem,rss,etimes,args --sort=-rss 2>/dev/null | head -9;
echo '===FIM==='
```

- `LC_ALL=C` no início. As métricas vêm de `/proc` e `/sys`, imunes ao idioma.
- `ssh -o BatchMode=yes -o ConnectTimeout=10`: falha rápido se o servidor estiver fora.
- `NET`, `IO`, `SMART` e `SERVICES` só entram quando configurados. `===FIM===` marca a
  saída completa (`collector.complete`).
- `===VER===` traz a versão do coletor e um hash de 12 hex dos alvos. Hash diferente do
  esperado indica `authorized_keys` desatualizado (`hashMismatch`).
- **Modo** `basico` ou `smart`. O SMART roda **1 vez por hora**; nas outras coletas a
  seção imprime `pulado` e o último resultado é reaproveitado.
- **Comando forçado** (ADR 0008): o script vai para o `authorized_keys` do `dashmon` e o
  painel envia só a palavra do modo. Ela chega em `$SSH_ORIGINAL_COMMAND` e só passa pelo
  `case` da 1ª linha; nunca é executada nem ecoada. Exemplo das linhas no servidor:

  ```
  restrict,from="192.0.2.20",command="<script acima>" ssh-ed25519 AAAA… dashboard@notebook-a:3f9a12c4
  dashmon ALL=(root) NOPASSWD: /usr/sbin/smartctl -H /dev/sda, /usr/sbin/smartctl -H /dev/sdb
  ```

  A 1ª linha vai para o `authorized_keys` do `dashmon`, ao lado das linhas dos outros
  computadores (ADR 0020). A 2ª vai para `/etc/sudoers.d/dashboard-<computador>-<id>`. A
  regra única das versões até a 2.1.0 (`/etc/sudoers.d/dashboard`) sai quando nenhuma linha
  sem ID sobrar.

- SMART: root roda `smartctl -H` direto; outro usuário usa `sudo -n` (nunca pede senha).
  Estados: `PASSED`, `FAILED`, `SEM_PERMISSAO`, `SEM_SMARTCTL`, `DESCONHECIDO`.
- Temperatura: todas as `thermal_zone*`. Prioridade: `x86_pkg_temp` > `coretemp` >
  `k10temp` > `cpu-thermal`/`cpu_thermal`/`soc_thermal` > `acpitz` > maior valor.
- Falhas do SSH viram mensagens claras (`describeError()`): timeout, identidade do
  servidor, exit 255, resposta grande demais.

## Formato da amostra

`schemaVersion: 2`, gerada por `server/collector/parser.js`. Dado ausente é `null`, nunca
zero inventado. Taxas (`cpu`, `rxMbps`, `readMBps`, `utilPct`…) são `null` na 1ª coleta,
depois de um reboot ou com contador que voltou. `rxDeltaBytes`/`txDeltaBytes` são os bytes
trafegados desde a coleta anterior, exatos pelos contadores (o volume por dia sai deles); são
`null` nos mesmos casos e também com mais de 2 h entre as coletas. Exemplo (listas encurtadas):

```json
{
  "schemaVersion": 2,
  "ts": "2026-10-07T13:51:00.000Z",
  "collector": { "version": 2, "hash": "73cebb436c7c", "mode": "smart", "complete": true,
                 "expectedVersion": 2, "durationMs": 1290, "outputBytes": 2949 },
  "host": "servidor-exemplo",
  "os": { "kernel": "6.12.0+deb13-amd64", "name": "Debian GNU/Linux 13 (trixie)" },
  "cores": 1,
  "uptimeSec": 12937.03,
  "bootAt": "2026-10-07T10:15:22.970Z",
  "load": [0.08, 0.02, 0.01],
  "cpuTicks": { "user": 102345, "nice": 120, "system": 45678, "idle": 1234567,
                "iowait": 8901, "irq": 0, "softirq": 1234, "steal": 0, "total": 1392845 },
  "cpu": { "pct": 3.2, "user": 2.1, "system": 0.9, "iowait": 0.2, "steal": 0 },
  "ram": { "total": 840, "used": 406, "free": 120, "cache": 479, "avail": 434,
           "swapTotal": 885, "swapUsed": 24, "dirty": 0, "writeback": 0 },
  "disks": [
    { "mount": "/", "source": "/dev/sda2", "dev": "sda", "size": "100G", "used": "1.5G",
      "avail": "94G", "pct": 2, "sizeBytes": 107374182400, "usedBytes": 1610612736,
      "availBytes": 100394860544, "inodesPct": 3 }
  ],
  "missingMounts": [],
  "net": { "iface": "enp0s7", "rxBytes": 1752505, "rxErrors": 0, "rxDrops": 0,
           "txBytes": 771648, "txErrors": 0, "txDrops": 0, "rxMbps": 0.02, "txMbps": 0.01,
           "rxDeltaBytes": 150124, "txDeltaBytes": 74980 },
  "io": [ { "dev": "sda", "readIos": 15783, "sectorsRead": 1156426, "readTicksMs": 136971,
            "writeIos": 3699, "sectorsWrite": 118552, "writeTicksMs": 19880,
            "ioTicksMs": 91540, "readMBps": 0.0, "writeMBps": 0.01, "utilPct": 0.4,
            "latencyMs": 6.1 } ],
  "psi": null,
  "temps": [ { "type": "acpitz", "c": 32 } ],
  "tempC": 32,
  "tempSensor": "acpitz",
  "smart": [ { "dev": "sda", "status": "PASSED" } ],
  "smartAt": "2026-10-07T13:51:00.000Z",
  "services": { "smbd": "active" },
  "topProcs": [ { "user": "root", "pid": 990, "cpu": 0.0, "mem": 11.4, "rssKB": 98520,
                  "etimesSec": 12880, "cmd": "/usr/sbin/sshd" } ]
}
```

Amostras da V1 (sem `schemaVersion` e sem os campos novos) continuam válidas: o frontend
trata campos ausentes.

## Persistência

Tudo fica no disco local. Nada é gravado no servidor.

| Caminho | O que guarda |
|---|---|
| `data/history/AAAA-MM-DD.ndjson` | Amostras brutas, 1 linha por coleta, só acréscimo (fila assíncrona), 1 arquivo por dia (UTC). Retenção de 72 h; linha cortada por queda é ignorada. ~3,7 KB por coleta (~16 MB em 72 h). Em memória, só a amostra mais recente guarda `topProcs` (as antigas ficam compactas, `compactSample`); o arquivo guarda tudo e é lido em blocos de 1 MB ao reiniciar |
| `data/rollup/AAAA-MM-DD.ndjson` | Agregados de 5 min `{ t, n, m: { métrica: [mín, máx, média] } }` por 90 dias. Quando só parte das `n` amostras tem a métrica, um 4º item diz quantas (`[mín, máx, média, c]`; média × c = soma). Fechar de novo não duplica; o boot fecha os pendentes. ~1,2 KB a cada 5 min (~29 MB em 90 dias) |
| `data/alerts.json` | Alertas com ciclo de vida `new` → `ack` → `resolved` (até 500) |
| `data/annotations.json` | Anotações (texto, rótulo, instante) |
| `data/outages.ndjson` | Quedas do servidor (`off`/`on`), 90 dias, separadas dos alertas (B9) |
| `data/history.v1-migrado.json` | Backup do histórico da V1, feito pela migração (pode ser apagado) |
| `data/sessions.json` | SHA-256 das sessões do navegador |
| `data/entrar.json` | Hash do link de entrada de uso único (2 min no `./dashboard abrir`, 10 min no fim da instalação) |
| `data/ssh/` | `config` e `known_hosts` próprios do painel (0700) |
| `data/dashboard.log` | Log (gira em 5 MB para `dashboard.log.1`) |
| `data/dashboard.pid`, `data/dashboard-erros.log` | Modo segundo plano (sem systemd): PID e erros de inicialização |
| `.runtime/node/` | Node 24 baixado pelo `./dashboard`, se o do sistema faltar |
| `.backups/` | Cópias de `data/` feitas pelo `atualizar` (as 3 mais novas, 0700) |

Fora da pasta do projeto: a chave `~/.ssh/dashboard-<servidor>-<id>` (as instalações até a
2.1.0 continuam com a `dashboard_ed25519` ou a `dashboard_v2_ed25519`), o serviço
`~/.config/systemd/user/server-dashboard.service`, o atalho
`~/.local/share/applications/server-dashboard.desktop`, o comando `~/.local/bin/dashboard`
(link para o `dashboard` desta pasta), o autocomplete
`~/.local/share/bash-completion/completions/dashboard` (link para `scripts/completar.bash`; respeita
`BASH_COMPLETION_USER_DIR` e `XDG_DATA_HOME`) e, só com o sim, um bloco marcado
(`# >>> server-dashboard >>>`) no arquivo de login do bash e, sem o pacote `bash-completion`, outro
no `~/.bashrc`, com a cópia `<arquivo>.dashboard-bak`.

Ao encerrar (SIGINT/SIGTERM), o painel espera gravar histórico, alertas e anotações
pendentes (B11).

## API

Todas as rotas passam por: Host check, CSRF (com cookie `dash_csrf`), cabeçalhos de
segurança, rate limit das mutações e error handler sem stack trace. Com `DASH_TOKEN`,
`/api/*` e `/api/stream` exigem sessão ou `Bearer <token>` (menos `/api/session`,
`/api/login` e `/api/logout`).

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
| `/api/outages` | GET | `?days=1..90` (padrão 30) → `{days, outages, monitored, uptime}`. `monitored` são os intervalos `{from, to}` em que o painel estava medindo; `uptime` conta só esse tempo (ADR 0018) |
| `/api/alerts` | GET | `?status=&level=&limit=` → `{active, all}` |
| `/api/alerts/:id/ack` | POST | Reconhece o alerta |
| `/api/alerts/:id/resolve` | POST | Resolve o alerta |
| `/api/annotations` | GET / POST | Lista / cria anotação (`{ts, text, label}`) |
| `/api/annotations/:id` | DELETE | Remove a anotação |
| `/api/export` | GET | `?format=csv\|json&from=&to=` → download do relatório |
| `/api/stream` | GET | SSE: `hello`, `sample` (`id` = instante), `alerts`, `annotations`, `status`. `Last-Event-ID` recupera até 2000 amostras |
| `/api/poll` | POST | Coleta agora (piso de 5 s entre coletas manuais) |

Durante a instalação, o assistente (`server/setup/web.js`) roda num servidor temporário,
na mesma porta e com as mesmas proteções: `/configurar` (a página) e `/api/configurar/*`
(os passos). Ele só abre com o código de uso único mostrado no terminal (30 min, 20
tentativas).

## Alertas

Motor em `server/alerts/` (ADR 0006).

| Condição | Chave estável | Nível | Limiar |
|---|---|---|---|
| Disco usado ≥ limiar | `disk:<mount>:usage` | warning | `ALERT_DISK_PCT` |
| RAM usada ≥ limiar | `ram:usage` | warning | `ALERT_RAM_PCT` |
| Temperatura da CPU ≥ limiar | `temp:cpu` | warning | `ALERT_TEMP_C` |
| SMART `FAILED` (sem permissão ou sem smartctl é neutro) | `smart:<dev>` | critical | — |
| Serviço fora de `active`/`reloading`/`activating` (sem resposta é neutro) | `service:<nome>` | critical | — |
| Servidor inacessível depois de N falhas seguidas | `servidor-inacessivel` | critical | `ALERT_OFFLINE_AFTER` |

- **Chave estável**: a condição que continua atualiza o MESMO alerta (B3).
- **Histerese**: dispara no limiar e só limpa quando o valor cai `ALERT_HYSTERESIS` abaixo
  (disco e RAM em pontos de %, temperatura em °C).
- **Debounce do offline**: 1 falha isolada não alerta. A queda começa no instante da 1ª
  falha. Durante a queda, os outros alertas ficam como estão (nada foi medido).
- **Dado ausente** não cria nem resolve alerta.
- **Disponibilidade** (ADR 0018): conta só o **tempo medido**, as faixas de 5 min com pelo
  menos 1 amostra (bruta ou agregada) mais as quedas registradas (o painel estava rodando e
  tentando). Fórmula: 100 − fora do ar ÷ tempo medido × 100. Sem tempo medido, é `null`
  ("sem dados"), nunca 100%. Um dia sem nenhuma coleta fica cinza em Eventos e "sem dados"
  nos Relatórios. Os agregados guardam a cobertura em memória (`RollupStore.coverage`), lida
  do disco 1 vez.
- **Saúde 0–100** (`server/alerts/health.js`): começa em 100 e perde pontos por problema,
  a partir dos mesmos limiares dos alertas:
  - RAM: −15 no limiar, −5 a partir de 15 pontos abaixo dele;
  - disco: −15 no limiar, −5 a partir de 10 pontos abaixo;
  - temperatura: −15 no limiar, −25 a partir de 10 °C acima;
  - carga acima de 1,5 × núcleos: −10;
  - SMART `FAILED`: −40; serviço parado: −25;
  - offline ou sem dado: 0.

  Faixas: 80–100 saudável, 50–79 atenção, 0–49 crítico. A tela só mostra o que vem em
  `/api/status` (`health`).

## Orçamento de desempenho

Definido no plano da V2. O limite de RAM foi revisto em 16/10/2026 e em 19/10/2026 (#26),
sempre depois de medido. O pico dos pedidos de 90 dias entrou em 26/10/2026 (#78).
O limite da página inicial subiu de 300 KB para 450 KB em 30/10/2026, a pedido do mantenedor (#100).

| Medida | Limite | Medido | Como se confere |
|---|---|---|---|
| Tempo do comando no servidor | ≤ 1,5 s | 1,26–1,31 s (servidor real, 1 núcleo) | faixa de status e `./dashboard diagnosticar` |
| Tamanho da resposta | ≤ 16 KB | 2,9 KB (servidor real) | idem; acima de 1 MB a conexão é cortada |
| Página inicial | ≤ 450 KB transferidos | 293 KB (com gzip) | `test/e2e/telas.test.js` |
| RAM do Node com 72 h em memória | ≤ 95 MB | 88,5–90,4 MB (painel reiniciado com 72 h) | `npm run soak` |
| RAM do Node no pico dos pedidos de 90 dias | ≤ 120 MB | 113–115 MB (gráfico e Relatórios, 1 h e 15 min) | `npm run soak` (fase 3) |
| Memória depois que a janela de 72 h enche | sem crescer (≤ +4 MB) | +1,1 a +1,8 MB em 11 h a mais | `npm run soak` |

O Node 24 vazio usa ~44 MB e o painel sem histórico, ~63 MB (o `node:http` sozinho ocupa
~16 MB). As amostras de 72 h ocupam ~12 MB de heap. O que mais pesava era a geração jovem do
V8: ela crescia até 32 MB na carga das 72 h e não encolhia. Por isso o painel sobe com
`--max-semi-space-size=2` (`server/node-flags.js`), nos 4 caminhos: serviço systemd, segundo
plano, `npm start` e o soak. A opção só vale na linha de comando do Node.

Os pedidos de baldes de 90 dias (gráficos e Relatórios) levavam o RSS a 165–264 MB (#78), e ele
não voltava: o V8 guarda as páginas que já usou. Três mudanças trouxeram o pico para ~115 MB.
Os agregados são lidos 1 arquivo diário por vez, em blocos de 64 KB, e cada um é somado e
solto logo depois (`RollupStore.each` + `bucketMerger`). O acumulador guarda só números, 4 por
métrica. E o painel sobe também com `--optimize-for-size`, que faz o V8 coletar a geração
velha mais cedo (sem custo de CPU por coleta medido no soak). Guardar as amostras
numa forma compacta foi medido em 19/10/2026: o heap cai ~5 MB, mas o RSS não melhora (a
codificação gera lixo na carga). A meta antiga de 80 MB não é alcançável assim.

## Estrutura

```
linux-server-dashboard-v2/
├── AGENTS.md · README.md · TUTORIAL.md · SECURITY.md · CONTRIBUTING.md · CHANGELOG.md · LICENSE (MIT)
├── dashboard               comando único: garante o Node 24 (scripts/node-runtime.sh) e chama server/cli/
├── package.json            sem dependências de runtime; devDependency: playwright-core (e2e)
├── .env.example            modelo do .env (sem valores reais)
├── .github/                workflows/: seguranca.yml (CI, ADR 0014), dependencias.yml e
│                           scorecard.yml; dependabot.yml (ADR 0016);
│                           ISSUE_TEMPLATE/ (bug, funcionalidade, tarefa), template de PR e
│                           CODEOWNERS (ADR 0016)
├── docs/                   adr/, seguranca/ (análises e excecoes.json), allowed_signers,
│                           testes-no-navegador.md (roteiro da bateria, ADR 0019),
│                           ROADMAP.md e roadmap/ (planejamento de cada feature),
│                           img/ (prints e SVG do README e do TUTORIAL)
├── scripts/                check.mjs, seguranca.mjs, mutacao-seguranca.mjs, soak-acelerado.mjs,
│                           capturar-amostra.mjs, painel-teste.mjs, capturar-telas.mjs,
│                           desenhar-graficos.mjs, node-runtime.sh, askpass.sh,
│                           completar.bash (autocomplete do bash),
│                           e2e-instalacao/
├── server/
│   ├── index.js            rotas, loop de coleta, export
│   ├── config.js           parser único do .env, faixas, sanitizeToken/sanitizeHost
│   ├── security.js         Host check, CSRF, cabeçalhos, token timing-safe, rate limit
│   ├── poller.js           fachada do coletor + alertas (CLI --once)
│   ├── csv.js · stores.js · logfile.js · version.js · node-flags.js (opções do Node do painel)
│   ├── cli/                subcomandos do ./dashboard (index, servico, instalar, diagnosticar,
│   │                       atualizar, desinstalar, importar-v1, saida)
│   ├── setup/              instalação: acesso, deteccao, preparo, remoto, local, assinatura,
│   │                       instalacao, web (assistente), tui, sem-interface
│   ├── http/               router, static, session, sse, entrar (link de uso único)
│   ├── collector/          builder (script), parser (amostra v2), rates (taxas), index (1 SSH)
│   ├── storage/            ndjson (72 h), rollup (5 min/90 d), buckets, migrate-v1, outages,
│   │                       coverage (tempo medido), index
│   └── alerts/             rules, health, engine
├── public/
│   ├── index.html          casca das 8 telas, login e avisos
│   ├── configurar.html     assistente de instalação (js/configurar/, css/configurar.css)
│   ├── css/                tokens.css (escuro/claro), base, components, views, print
│   ├── fonts/              Geist + Geist Mono 1.7.2 (OFL, SHA-256 em vendor/vendor.json)
│   ├── vendor/             uPlot 1.6.32 (SHA-256 em vendor.json)
│   └── js/                 main.js, locale-guard.js, core/, charts/, views/ (as 8 telas)
├── test/                   unit/, integration/, seguranca/, e2e/ e fixtures/ (node --test)
└── test-support/           request.js (HTTP/SSE), sshd.js (sshd real), instalacao-fake.js,
                            rotas.js (rotas lidas do código), fonte.js (código sem comentários),
                            hover.js (resposta ao mouse no navegador)
```

## Solução de problemas (para quem desenvolve)

Os problemas de quem usa estão no TUTORIAL ("Solução de problemas"); comece sempre pelo
`./dashboard diagnosticar`. Para quem mexe no código:

- **Coleta lenta ou parada:** `data/dashboard.log` e `journalctl --user -u server-dashboard`.
  A faixa de status mostra o tempo e o tamanho de cada coleta.
- **Histórico vazio:** confira `data/history/` (o `.ndjson` de hoje) e as permissões de
  `data/`. Veio da V1? `npm run migrar-v1 -- --verificar`.
- **Suíte vermelha só na sua máquina:** rode os testes num clone sem `.env` (o `.env` de
  uma instalação de verdade muda os padrões) e com o Node 24 (`.runtime/node/bin`).
- **e2e pulado:** instale o `playwright-core` (`npm ci`) e um Chromium, ou aponte um com
  `CHROMIUM=<caminho>`.
