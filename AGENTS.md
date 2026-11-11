# Server Dashboard — referência técnica (agentes e desenvolvimento)

Painel de monitoramento, em tempo real, de um servidor Linux da rede local. Toda a carga fica na máquina local; o
servidor só responde **1 comando SSH por minuto**. Este requisito é obrigatório: o hardware do servidor é muito
limitado.

Este arquivo traz o que vale em toda sessão: regras, desenvolvimento, arquitetura e comandos. Com a
[referência sob demanda](#referência-sob-demanda) (`docs/referencia/`), ele é a **referência técnica única** do
projeto. Os outros documentos não repetem estes detalhes:

- [README.md](README.md): visão geral, instalação e comandos.
- [TUTORIAL.md](TUTORIAL.md): passo a passo para leigos.
- [SECURITY.md](SECURITY.md): modelo de ameaças.
- [CONTRIBUTING.md](CONTRIBUTING.md): o caminho de uma contribuição (issue, PR, checks).
- [docs/ROADMAP.md](docs/ROADMAP.md): os níveis de complexidade (P, M, G, GG) e as features entregues; o roadmap
  2.3.0–2.6.0 está concluído (histórico).

O teste `test/unit/docs.test.js` confere esta documentação contra o código.

## Referência sob demanda

Leia só o arquivo que a tarefa pede. Mudou o código de um destes temas? Atualize o arquivo dele.

| Preciso de… | Arquivo |
|---|---|
| Variáveis do `.env` (padrões e faixas), modo sistema e pacote `.deb` | [docs/referencia/configuracao.md](docs/referencia/configuracao.md) |
| Script de coleta, modos `basico`/`smart`, comando forçado, SMART e temperatura | [docs/referencia/coleta.md](docs/referencia/coleta.md) |
| Campos da amostra (`schemaVersion: 2`) | [docs/referencia/amostra.md](docs/referencia/amostra.md) |
| Arquivos de `data/`, `.atualizacao/` e o que fica fora da pasta do projeto | [docs/referencia/persistencia.md](docs/referencia/persistencia.md) |
| Rotas HTTP, SSE e o assistente | [docs/referencia/api.md](docs/referencia/api.md) |
| Alertas, histerese, disponibilidade e saúde 0–100 | [docs/referencia/alertas.md](docs/referencia/alertas.md) |
| Limites de tempo, tamanho e RAM, e como medir | [docs/referencia/desempenho.md](docs/referencia/desempenho.md) |
| Camadas de verificação de segurança: etapas, opções e limites do `npm run seguranca` e do CI | [docs/referencia/verificacao-de-seguranca.md](docs/referencia/verificacao-de-seguranca.md) |
| Por onde começar a investigar um problema | [docs/referencia/solucao-de-problemas.md](docs/referencia/solucao-de-problemas.md) |

## Regras (obrigatórias)

As invariantes da tabela abaixo valem sempre. Regras de conduta que a tabela não traz:

- **Nunca** compilar, instalar pacotes ou rodar scripts pesados **no servidor** (1 núcleo, pouca RAM, discos SMR). Não
  há agente nem dependência no servidor.
- Inspeção à mão no servidor: só comandos não interativos, pelo seu alias do `~/.ssh/config` (ex.:
  `ssh meu-servidor '<comando>'` → `usuario@192.0.2.10:22`). O painel conecta pelo alias `servidor` do
  `data/ssh/config`.
- **NUNCA** exibir, imprimir ou commitar o conteúdo de `.env`: ele guarda o `DASH_TOKEN` (o acesso ao painel). O
  painel não guarda senha: a coleta usa uma chave SSH. A senha do administrador serve só na instalação, fica na
  memória e é descartada.
- `data/` nunca vai para o git nem para issue, PR ou log: ela tem hostnames, IPs e telemetria da rede interna.
- Dado dinâmico (temperatura, espaço, status) é sempre coletado ao vivo, nunca presumido.

### Invariantes (citadas no código como I1–I11)

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
| I11 | A tela só dispara a atualização para a versão assinada mais nova já detectada e a reconfiguração; nenhum dado da tela entra no comando | a rota só compara a versão (409 se diferente), a do reconfigurar não lê o pedido, comando fixo em lista e regra estática, além das mutações |

### Regras de segurança (security by design)

- **Configuração centralizada** em `server/config.js`: parser único do `.env` (com override de `process.env`),
  validação de faixas (tabela [Configuração](docs/referencia/configuracao.md)) e caminhos de dados forçados para dentro de `data/`
  (`clampPathToData`).
- **Anti-injeção**: `NET_IF`, `DISK_MOUNTS`, `DISK_DEVS`, `SMART_DEVS` e `SERVICES` passam por `sanitizeToken()`
  (whitelist `[A-Za-z0-9_./:-]`, recusa token iniciado com `-`) **antes** de entrar no script de coleta
  (`server/collector/builder.js`). `SSH_HOST` passa por `sanitizeHost()`, e `runSSH()` recusa host iniciado com `-`.
- **Host check** (`server/security.js`): `Host` diferente de `localhost`, `127.0.0.1` ou `[::1]` recebe 403. Isto
  bloqueia DNS rebinding.
- **CSRF em 2 camadas**: mutações (POST/PUT/PATCH/DELETE) com `Origin` diferente do Host ou com
  `Sec-Fetch-Site: cross-site` recebem 403. Mutações com `Origin` também precisam do cookie `dash_csrf` (SameSite=Lax,
  HttpOnly), emitido nos GETs.
- **Cabeçalhos** em todas as respostas, inclusive 401/403/404: CSP sem `'unsafe-inline'` e sem `'unsafe-eval'`,
  `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener/Resource/Embedder-Policy` e
  `Permissions-Policy`. API, `/entrar` e o assistente respondem com `Cache-Control: no-store`.
- **Anti-XSS** (ADR 0010): a tela monta HTML só pelo template `html` de `public/js/core/html.js`, que escapa toda
  interpolação. HTML cru só por `raw()` explícito. Medidas vindas dos dados (largura de barra, cor) vão em
  `data-w`/`data-bg`/… e são aplicadas pelo CSSOM em `mount()`. Nunca `style="…"` no HTML.
- **Export seguro**: `server/csv.js` impede formula injection (`=+-@`, TAB e CR → prefixo `'`) e saneia o nome do
  arquivo.
- **Permissões**: `data/` e `data/ssh/` com 0700; `.env`, chave e arquivos de dados com
  0600. A instalação grava assim (`server/setup/local.js`), a escrita também
(`{ mode: 0o600 }`) e o `./dashboard diagnosticar` aponta o que estiver aberto.
- **Token e sessão** (ADR 0007): a instalação gera um `DASH_TOKEN`. Com ele, `/api/*` e `/api/stream` exigem sessão
  (cookie `dash_session`, HttpOnly + SameSite=Strict, 30 dias renovados com o uso) ou `Authorization: Bearer <token>`.
  O token é trocado 1 vez em `/api/login` (10 tentativas/min/IP). Em disco (`data/sessions.json`) fica só o SHA-256 da
  sessão. `?token=` na URL **não** vale. Comparação com `crypto.timingSafeEqual`. `GET /entrar?codigo=` aceita o link
  de uso único do `./dashboard abrir` (só o hash em `data/entrar.json`, 2 min, vale 1 vez).
- **Limites**: `/api/poll` com piso de 5 s entre coletas manuais; mutações da API com 120 por minuto por IP; corpo
  JSON com até 50 KB (413 acima); SSE com até 20 conexões (503 acima); resposta do SSH com até 1 MB
  (`MAX_OUTPUT_BYTES`; acima disso a conexão é cortada).
- **Erros sem vazamento**: o error handler central devolve JSON sem stack trace.
- **HTTP próprio** (ADR 0003): `node:http` + `server/http/`: estáticos só de `public/` (lista de tipos, sem arquivo
  oculto, pasta ou traversal; gzip quando o navegador aceita; `no-cache` + `ETag`, 304 sem mudança). Backend sem
  dependência de runtime. `test/integration/http-seguranca.test.js` é a caracterização caixa-preta e precisa continuar
  verde.
- **SSH isolado**: `BatchMode=yes` + `ConnectTimeout=10`. Com `SSH_CONFIG`, o painel usa só `ssh -F data/ssh/config`,
  com `known_hosts` próprio e `StrictHostKeyChecking yes` (nunca `no` nem `accept-new` depois da instalação).
- **Acesso restrito** ([ADR 0008](docs/adr/0008-ssh-restrito.md), `SSH_ACESSO=restrito`): usuário `dashmon` sem senha,
  com comando forçado no `authorized_keys` e sudoers sem curinga. Fora da ADR: a linha é gerada e escapada em
  `server/setup/acesso.js` (conferida contra o `opt_dequote` do OpenSSH), e o painel envia só a palavra do modo
  (`basico` ou `smart`); qualquer outro texto vira `basico`.
- **Vários computadores** ([ADR 0020](docs/adr/0020-varios-computadores-no-mesmo-servidor.md)): cada instalação tem um
  ID e troca ou remove só a sua linha do `authorized_keys` e o seu sudoers. O nome do computador passa por
  `machineLabel()` antes de virar arquivo ou comando.
- **Instalação** (`server/setup/`): toda entrada é validada em `acesso.js` antes de virar arquivo ou comando. A senha
  do administrador fica só em memória (o `ssh` a recebe pelo askpass, em variável de ambiente só daquele processo; o
  `sudo -S -k`, pelo stdin), nunca vai na linha de comando e é descartada no fim do passo 5. O assistente web só abre
  com código de uso único e tem as proteções do painel.
- **Entrada por chave** ([ADR 0021](docs/adr/0021-instalacao-em-servidor-so-com-chave.md)): o apelido do
  `~/.ssh/config` é lido sem conectar (`ssh -G`) e só os valores dele vão para o comando. `ProxyJump` e `ProxyCommand`
  são recusados. A senha do sudo vai só pelo stdin. O painel nunca altera o `sshd_config`.
- **Comando no PATH e autocomplete** (ADRs [0028](docs/adr/0028-comando-no-path-por-link-simbolico.md) e
  [0029](docs/adr/0029-autocomplete-estatico-do-bash.md)): o link `~/.local/bin/dashboard` nunca sobrescreve outro
  programa. O arquivo de login e o `~/.bashrc` só mudam com o sim, com cópia antes e bloco marcado. O `desinstalar`
  tira só o link desta pasta e só o bloco. `scripts/completar.bash` é estático e nunca passa o `~/.ssh/config` pelo
  `compgen -W`. As mensagens da CLI usam `out.cmd`.
- **Versões assinadas** (ADR 0012): o instalador e o `./dashboard atualizar` só aceitam tags assinadas por uma chave
  de `docs/allowed_signers`, e com o nome gravado dentro da tag igual ao da ref (`verifyTag`, motivo `nome-trocado`,
#155).
- **Versão nova** ([ADR 0030](docs/adr/0030-atualizacao-pelo-painel.md)): o painel procura 1 vez por dia, em processo
  à parte. É a única saída para a internet. Só vale tag assinada, e as novidades entram como texto. O `createApp` sem
  `procurarVersao` não sai da máquina: testes nunca fazem fetch.
- **Troca de versão pela tela** (ADRs [0031](docs/adr/0031-botao-atualizar-executor-fora-do-servico.md),
  [0032](docs/adr/0032-dashboard-atualizar-abre-o-painel.md) e
  [0051](docs/adr/0051-servico-escreve-so-em-painel-e-procura-por-espelho.md), I11): a rota só compara a versão e
  dispara um comando fixo fora do serviço, sem shell e sem dado da tela; exige sessão e a pasta da instalação. O
  serviço escreve só em `data/` e em `.atualizacao/painel/`; o resto da `.atualizacao/` é do executor, que nunca usa o
  espelho. `dashboard atualizar` só abre o link de uso único; quem troca é o clique.
- **Reconfigurar pela tela** (ADRs [0034](docs/adr/0034-reconfigurar-pela-tela-processo-a-parte.md),
  [0035](docs/adr/0035-copia-da-configuracao-fica-na-memoria.md),
  [0036](docs/adr/0036-reconfigurar-pela-tela-disparo-pelo-painel.md) e
  [0039](docs/adr/0039-dashboard-reconfigurar-abre-o-painel.md); espera e motivo na tela: 0037 e 0038; I11): o
  assistente roda em processo à parte, porque recebe a senha do administrador. A rota não lê nada do pedido e exige
  sessão. O código é de uso único e só o hash dele vai ao disco. Tudo o que pode recusar vem antes de parar o painel.
  A cópia do `.env` e do `data/ssh/` fica só na memória. Desistir ou falhar restaura a configuração e religa o painel.
  Nunca troca a versão da pasta.
- **Code scanning** (CodeQL do GitHub, suíte `extended`, a cada push): todo alerta é corrigido ou descartado como
  falso positivo com a análise em `docs/seguranca/` e, se possível, um teste que falhe na forma errada. Não aplique a
  sugestão do CodeQL sem conferir o formato real (ex.: o escape do `authorized_keys` segue o `opt_dequote`, não o
  padrão genérico).
- **Verificação em camadas** (redundante de propósito,
  [ADR 0014](docs/adr/0014-verificacao-de-seguranca-continua.md)): `test/seguranca/` em todo `npm run check`;
  `npm run seguranca` (ferramentas externas em Docker e mutação dos guardas); os 2 no CI, a cada push no `main` e a
  cada PR, com o check obrigatório `verificacao`; e as ferramentas do GitHub. Achado médio ou alto só passa com
  análise em `docs/seguranca/excecoes.json`. Etapas, opções e limites:
  [docs/referencia/verificacao-de-seguranca.md](docs/referencia/verificacao-de-seguranca.md).

## Desenvolvimento (obrigatório)

- **Decisões:** `docs/adr/` (uma ADR por decisão; ADR aceita não é editada, é substituída por outra). O plano da V2
  (fases F0–F9, decisões D0–D13, perguntas Q1–Q20) está concluído e fica como registro histórico na [tag
  v2.0.0](https://github.com/tsouza-thiago/linux-server-dashboard-v2/blob/v2.0.0/docs/PLANO_V2.md).
- **Antes de todo commit:** `npm run check` (sintaxe JS e shell, `.env`/`data/` fora do git, testes + cobertura com
  `test/seguranca/`, `npm audit`). Nenhum commit vermelho. Se um teste falhar, o relatório diz o nome dele e a saída
  completa fica em `.check/ultima-falha.log`.
- **Mudou código de segurança, removeu código ou terminou uma etapa?** Rode também `npm run seguranca` (precisa de
  Docker; sem ele, as ferramentas externas são puladas e a mutação roda assim mesmo).
- **Documentação junto com o código:** mudou comando, opção, variável, rota ou arquivo? Atualize este arquivo ou o de `docs/referencia/` (e o
  README/TUTORIAL, se a pessoa usuária vê a mudança). `test/unit/docs.test.js` falha se a documentação divergir do
  código.
- **Commits:** Conventional Commits em PT-BR (`feat(escopo):`, `fix:`, `test:`, `docs:`, `refactor:`, `style:`,
  `perf:`, `chore:`, `security:`), uma mudança lógica por commit. O **CHANGELOG.md** (Keep a Changelog) muda no mesmo
  commit.
- **Bug conhecido** ainda sem correção entra como issue e como teste `todo` no arquivo de testes da área, com o número
  da issue no nome; o commit que corrige tira o `todo` e o teste vira regressão. Os 12 bugs da V1 (B1–B12), todos
  corrigidos na V2, são regressões em `test/unit/bugs-v1.test.js`.
- **Versões:** SemVer a partir da `v2.0.0`: `PATCH` corrige, `MINOR` acrescenta sem quebrar, `MAJOR` quebra
  (configuração, formato de `data/` ou acesso ao servidor). Pré-versões (`-rc.N`) só chegam a quem já está numa
  pré-versão ou usa `--pre` (`./dashboard instalar --pre`, `./dashboard atualizar --pre`): uma instalação nova a
  partir do `main` fica na estável assinada mais nova, mesmo que o último commit tenha uma tag `-rc`. Toda versão é
  uma tag assinada + GitHub Release (abaixo).
- **Entregas pequenas** (ADR 0015 e 0023): um PR por mudança lógica; mudança pequena sai direto na versão estável
  (`PATCH`), sem pré-versão, que fica para os níveis G e GG do `docs/ROADMAP.md`. As `PATCH` da fila saem antes da 1ª
  pré-versão; correção urgente durante as pré-versões sai de um ramo `manutencao/X.Y` criado da última tag e volta ao
  `main` por merge. Merge com merge commit, sem squash nem reescrita do `main`. Documentação sem código não gera
  versão: sai nas notas da próxima.
- **Issue primeiro** (ADR 0016): toda mudança começa numa issue aberta pelo formulário do tipo (bug, funcionalidade,
  tarefa), com rótulos de tipo, área, prioridade e semver, no milestone da versão em que deve sair e no quadro do
  Projects. O PR fecha a issue (`Closes #N`) e segue o template; o merge exige os checks obrigatórios e o "pode
  publicar" do mantenedor. Dúvidas e ideias vão para Discussions; vulnerabilidade, só pelo reporte privado do GitHub,
  nunca em issue pública. Exceções: PRs do Dependabot e o commit de versão.
- **Imagens da documentação:** `docs/img/` tem só o que o `npm run capturar-telas` gera, do painel de teste. Nunca use
  print de uma instalação real. Antes do commit, olhe cada imagem nova: nenhum teste enxerga o que há dentro dela.
  Orçamento: 200 KB por arquivo e 3 MB na pasta (`test/unit/docs.test.js`). Refaça só quando a tela mudar de forma
  visível: cada versão de imagem fica no histórico para sempre.
- **Testes no navegador** (ADR 0019): toda mudança de tela é conferida no navegador real, pela extensão Claude in
  Chrome, num painel de teste (`npm run painel-teste`). A bateria completa segue
  [docs/testes-no-navegador.md](docs/testes-no-navegador.md) e roda antes de cada versão publicada. O PR registra o
  resultado; cada falha nova vira uma issue de bug.
- **Orçamento de desempenho:** veja [Orçamento de desempenho](docs/referencia/desempenho.md). Mudou coleta, histórico ou
  frontend? Rode `npm run soak` e `npm run test:e2e`.
- **Node.js 24** é a versão mínima (ADR 0002). **Navegadores:** Chrome/Edge, Firefox e Safari, nas 2 últimas versões
  (ES modules, `<dialog>` e CSS moderno, sem polyfill). **Exemplos** usam só IPs de documentação (`192.0.2.x`, RFC
  5737) e nomes genéricos.

### Publicar uma versão (ADR 0012)

1. Mudou o script de coleta (`COLLECTOR_VERSION`)? A seção da versão traz a linha
   `**Exige reconfigurar o acesso ao servidor.**`: a tela avisa antes de atualizar (ADR 0032). PR no `main` com o CI
   verde, a seção `[X.Y.Z] — data` no CHANGELOG e a versão no `package.json` e no `package-lock.json`. As issues da
   versão estão no milestone dela.
2. Depois do merge, na máquina do mantenedor, com a chave listada em `docs/allowed_signers`:

   ```bash
   git fetch origin && git checkout --detach origin/main
   git -c gpg.format=ssh -c user.signingkey=~/.ssh/thiago-assinatura-releases-linux-server-dashboard-v2_ed25519.pub tag -s vX.Y.Z -m "vX.Y.Z"
   git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=docs/allowed_signers verify-tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. Pacote `.deb` da tag (ADR 0049), na mesma máquina: gere, assine o `SHA256SUMS` com a mesma chave, no namespace
   `server-dashboard`, e confira a assinatura:

   ```bash
   npm run empacotar-deb -- --ref vX.Y.Z
   ssh-keygen -Y sign -f ~/.ssh/thiago-assinatura-releases-linux-server-dashboard-v2_ed25519 -n server-dashboard dist/SHA256SUMS
   ssh-keygen -Y verify -f docs/allowed_signers -I tsouza-thiago -n server-dashboard -s dist/SHA256SUMS.sig < dist/SHA256SUMS
   ```

4. Release no GitHub **escolhendo a tag que já existe** (`gh release create vX.Y.Z --verify-tag`), com as notas do
   CHANGELOG e as issues fechadas, e com os 3 arquivos de `dist/` anexados: `server-dashboard_X.Y.Z_all.deb`,
   `SHA256SUMS` e `SHA256SUMS.sig`. A interface do GitHub cria tags leves, sem assinatura, que o instalador ignora. Ao
   publicar, o `.github/workflows/pacote.yml` gera o `.deb` da tag de novo e confere os 3 arquivos: confira que ele
   ficou verde. Depois, feche o milestone.

Trocar a chave exige um commit em `docs/allowed_signers` **antes** da tag nova: quem já tem o painel só aceita a
versão nova se a chave dela estiver na lista da versão instalada. Sem a chave antiga (troca da 2.1.1, #64), as notas
da versão trazem um passo manual: conferir a impressão digital da chave nova no `verify-tag` e fazer o checkout da
tag. A chave nova também precisa de `namespaces="git,server-dashboard"` e entra na linha do README e do TUTORIAL que
confere o `SHA256SUMS` do pacote.

## Arquitetura

```
[Servidor Linux] ← 1 SSH/min (script único, LC_ALL=C, não interativo, somente leitura)
  → [poller] coleta → parse → taxas → alertas → amostra (schemaVersion 2)
  → [storage] data/history/ (72 h brutas, NDJSON) + data/rollup/ (90 dias em baldes de 5 min)
  → [node:http 127.0.0.1:3000] telas + API REST + SSE
  → [Navegador] 8 telas (ES modules + uPlot, sem build), saúde, eventos, relatórios
```

Toda a interatividade (filtros, ordenação, zoom, previsão, agregações) roda no navegador. O backend só coleta,
persiste e serve. O limite de 1 SSH por minuto continua.

## Comandos

```bash
./dashboard instalar            # assistente no navegador (--terminal: TUI; --sem-interface: sem perguntas)
./dashboard instalar --importar-v1 <pasta>   # upgrade V1 → V2 (para a V1, traz .env e data/)
dashboard instalar --importar-pasta <clone>  # só no pacote .deb: para o painel do clone e traz o .env e o data/ dele para as pastas pessoais
./dashboard instalar --sem-assinatura        # só para desenvolvimento: pasta sem tag assinada (cópia, ramo)
./dashboard instalar --sem-link              # não cria o comando dashboard (~/.local/bin/dashboard) nem o autocomplete, nos 3 modos
./dashboard instalar --sem-interface --editar-profile  # põe ~/.local/bin no PATH pelo arquivo de login e, sem o bash-completion, carrega o autocomplete pelo ~/.bashrc, com cópia antes
./dashboard abrir               # abre o painel já logado (link de uso único)
./dashboard iniciar             # serviço de usuário ou segundo plano
./dashboard parar               # para só o processo do painel desta pasta (PID conferido, B12)
./dashboard status              # rodando ou parado
./dashboard diagnosticar        # explica cada problema; reaproveita a última amostra e só coleta se ela estiver velha
./dashboard reconfigurar        # com o painel no ar, abre o painel logado no diálogo do Reconfigurar; sem tela, sem login, painel parado ou qualquer opção, reabre o assistente daqui (--terminal: TUI)
./dashboard atualizar           # abre o painel logado, no diálogo da versão nova; sem tela, sem login ou com o painel parado, segue no terminal; só na pasta da instalação (com .env e dona do serviço)
./dashboard atualizar --terminal  # tudo no terminal: tag assinada mais nova, backup de data/, volta atrás se falhar
./dashboard desinstalar         # remove daqui e oferece limpar a parte deste computador no servidor; no pacote, só a configuração e os dados da pessoa
./dashboard versao              # versão instalada
bin/dashboard <comando>         # lançador do pacote .deb (/usr/bin/dashboard): os mesmos comandos no modo sistema
libexec/atualizador verificar|atualizar|voltar|semear  # executor do pacote (usuário _server-dashboard, nunca root): versão nova, troca, volta atrás e 1ª instalação
npm start                       # o painel em primeiro plano (node --max-semi-space-size=2 --optimize-for-size server/index.js)
npm test                        # suíte de testes (node --test)
npm run check                   # verificação completa, obrigatória antes de cada commit
npm run test:unit               # só unitários (test/unit); test:integration: HTTP, shell, ssh falso, sshd real; test:seguranca: test/seguranca
npm run seguranca               # Semgrep, Gitleaks, ShellCheck, OSV, OWASP ZAP e mutação (Docker)
npm run test:e2e                # ponta a ponta no Chromium (playwright-core; pula sem navegador; CHROMIUM=<caminho> escolhe outro)
npm run capturar-amostra        # 1 coleta real → data/amostra-{bruta,anonima}.txt (fixtures)
npm run capturar-telas          # refaz docs/img/ a partir do painel de teste (--sem-animacao pula a animação, que usa o ffmpeg)
npm run migrar-v1               # migra a V1 agora (o painel também migra ao iniciar); com -- --verificar só resume o data/history.json, sem gravar
npm run soak                    # soak acelerado: 83 h de coletas simuladas e pedidos de 90 dias; confere RAM e vazamento
npm run empacotar-deb           # .deb reprodutível da tag da versão + dist/SHA256SUMS (--ref <tag|HEAD>, --saida <pasta>)
npm run painel-teste            # painel de teste com dados semeados (--cenario=normal|lacunas|offline|vazio, --porta=3943, --versao-nova, --sem-escrita, --exige-reconfigurar, --resultado=voltou, --reconfigurar[=volta|recusa|sem-assinatura|outra-pasta], --assistente)
scripts/e2e-instalacao/rodar.sh # instalação, botão Atualizar e pacote .deb (instalar, atualizar, voltar, desinstalar, apt purge) de ponta a ponta em contêineres Debian/Ubuntu, com e sem systemd (E2E_CENARIOS=pacote: só o .deb)
```

Opções do modo sem perguntas: `./dashboard instalar --sem-interface --ajuda`. Servidor que só aceita chave:
`--chave-ssh <apelido>` no lugar de `--servidor`/`--usuario`/`--porta` (também no
`./dashboard desinstalar --limpar-servidor`).
