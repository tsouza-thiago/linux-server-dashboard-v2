# F4 — Link simbólico: `dashboard` sem `./`, de qualquer pasta

- **Nível:** P–M · **Versão:** 2.4.0-rc.1 · **Área:** instalação
- **Decidido:** o nome no PATH é `dashboard`.
- **Pergunta em aberto:** quando `~/.local/bin` não está no PATH, o painel só **mostra** a
  linha a acrescentar, sem editar o `~/.profile` nem o `~/.bashrc`? Proposta: sim.

## Objetivo

Rodar `dashboard atualizar`, `dashboard abrir` etc. de qualquer pasta, sem `cd` para a
pasta do projeto e sem `./`.

## Situação hoje

- O arquivo `dashboard` já resolve a própria pasta com `readlink -f "${BASH_SOURCE[0]}"`.
  Um link simbólico para ele **já funciona** sem mudar o script.
- A instalação cria o atalho do menu (`~/.local/share/applications/server-dashboard.desktop`,
  `server/setup/local.js`), com a opção `--sem-atalho` para pular.
- As mensagens da CLI citam `./dashboard` em 50 lugares de 17 arquivos de `server/`, e
  3 arquivos de `public/` citam o comando.

## Decisão proposta

1. **Onde:** `~/.local/bin/dashboard` → `<pasta do projeto>/dashboard`. Sem sudo, como
   todo o resto da instalação. `/usr/local/bin` exigiria sudo e valeria para todas as
   pessoas usuárias da máquina; fica para o pacote `.deb` (F9).
2. **Quando:** a instalação cria o link nos 3 modos (assistente, `--terminal` e
   `--sem-interface`). Opção nova `--sem-link` para pular (o nome `--sem-atalho` já é
   do atalho do menu).
3. **Conflito de nome:** antes de criar, a instalação confere:
   - `~/.local/bin/dashboard` já existe e aponta para **esta** pasta: nada a fazer;
   - aponta para **outra** pasta do painel (2ª instalação na mesma máquina): pergunta se
     troca e avisa que o comando passa a valer para esta pasta;
   - é outro programa: **não** sobrescreve; avisa e segue sem o link;
   - existe outro `dashboard` antes no PATH (`command -v dashboard`): avisa qual vai rodar.
4. **PATH:** se `~/.local/bin` não está no PATH, a instalação explica. No Debian, Ubuntu e
   Mint, o `~/.profile` padrão põe a pasta no PATH no próximo login, se ela existir. No
   Fedora, o `~/.bashrc` padrão já põe. Caso contrário, mostra a linha a acrescentar.
   O painel não edita arquivos do shell.
5. **Mensagens:** uma função em `server/cli/saida.js` devolve `dashboard` quando o link é
   válido e está no PATH, e `./dashboard` nos outros casos. As 50 mensagens passam a usar
   a função.
6. **Ciclo de vida:** `reconfigurar` e `atualizar` não mexem no link (ele aponta para a
   pasta, que continua a mesma). `desinstalar` remove o link só se ele aponta para esta
   pasta. `diagnosticar` confere o link e o PATH.

## Etapas

1. Funções `criarLinkNoPath()` e `removerLinkDoPath()` em `server/setup/local.js`, com as
   conferências do item 3, e testes unitários com uma pasta pessoal temporária.
2. Opção `--sem-link` nos 3 modos de instalação e na ajuda (`server/cli/index.js`).
3. Passo novo no assistente web e no TUI, com a explicação do PATH.
4. `desinstalar` e `diagnosticar`.
5. Função de mensagem em `saida.js` e troca das 50 mensagens.
6. README, TUTORIAL e AGENTS (tabela de comandos e "Fora da pasta do projeto").
7. Teste no `scripts/e2e-instalacao/rodar.sh` (Debian e Ubuntu): depois de instalar,
   `dashboard versao` roda de outra pasta num shell de login.

## Testes

- Unitário: os 4 casos de conflito do item 3; o link aponta para o caminho absoluto.
- `test/unit/docs.test.js`: a opção `--sem-link` aparece na ajuda e no AGENTS.
- e2e de instalação: comando global funciona; `desinstalar` remove o link.

## Riscos

- Pessoa com 2 pastas do painel: o comando global vale para a última instalada. Mitigação:
  o aviso do item 3 e o `dashboard status` mostrando a pasta.
- `~/.local/bin` só entra no PATH no próximo login (Debian/Ubuntu). Mitigação: a
  mensagem diz isso e mostra o caminho completo para usar agora.
