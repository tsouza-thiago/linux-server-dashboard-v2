# F5 — Autocomplete com Tab (bash)

- **Nível:** M · **Versão:** 2.4.0 · **Área:** instalação
- **Decidido:** só bash.
- **Depende de:** F4 para valer em `dashboard <Tab>` de qualquer pasta. Em
  `./dashboard <Tab>` funciona sem a F4.

## Objetivo

Completar com Tab os comandos (`atualizar`, `reconfigurar`…), as opções de cada comando e,
quando faz sentido, os valores das opções.

## Situação hoje

- Os comandos estão em `COMMAND_NAMES` (`server/cli/index.js`). O `docs.test.js` já
  confere a ajuda contra o código.
- Opções lidas no código hoje (`server/cli` e `server/setup`): `--ajuda`,
  `--apagar-historico`, `--chave-ssh`, `--forcar`, `--identidade`, `--importar-v1`,
  `--ja-preparado`, `--limpar-servidor`, `--modo`, `--pastas`, `--porta`, `--pre`,
  `--rede`, `--sem-assinatura`, `--sem-atalho`, `--sem-inicio-automatico`,
  `--sem-interface`, `--sem-origem`, `--senha-stdin`, `--servicos`, `--servidor`, `--sim`,
  `--smart`, `--terminal` e `--usuario`. `--pos-atualizacao` é interna e **não** entra no
  autocomplete.

## Decisão proposta

1. **Arquivo estático** `scripts/completar.bash` com a função `_dashboard`, no lugar de
   chamar o Node a cada Tab. Motivo: resposta instantânea (o `./dashboard` garante o Node
   antes de rodar, o que custa dezenas de ms por Tab).
2. **Teste de sincronia:** um teste novo compara os comandos e as opções do arquivo com
   `COMMAND_NAMES` e com as opções que o código lê. Comando ou opção nova sem
   autocomplete reprova o `npm run check`.
3. **O que completa:**
   - 1ª palavra: os comandos (sem os apelidos `help`, `-h`, `versão`);
   - depois do comando: as opções daquele comando;
   - `--importar-v1 <Tab>`: pastas;
   - `--chave-ssh <Tab>`: os apelidos `Host` do `~/.ssh/config` (sem curingas `*` e `?`),
     lidos pelo bash, sem rodar `ssh`;
   - `--modo <Tab>`: `manual` (o único valor que o `--sem-interface` aceita hoje).
4. **Instalação:** link em
   `${BASH_COMPLETION_USER_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion}/completions/dashboard`.
   O pacote `bash-completion` carrega o arquivo na 1ª vez que se aperta Tab depois de
   `dashboard`. Sem sudo e sem editar o `~/.bashrc`.
5. **Sem o pacote `bash-completion` (decidido: mesma regra da F4):** a instalação
   pergunta e, com o sim, acrescenta no `~/.bashrc` um bloco marcado que carrega o
   arquivo (cópia antes, sem duplicar, removido no `desinstalar`; no `--sem-interface`, só
   com `--editar-profile`). Sem o sim, o `diagnosticar` mostra a linha `source`.
6. Mesma opção `--sem-link` da F4 pula também o autocomplete; `desinstalar` remove.

### Alternativas descartadas

- **Completar chamando a CLI** (`dashboard __completar …`): sempre igual ao código, mas
  lento a cada Tab. O teste de sincronia do item 2 dá a mesma garantia sem o custo.
- **zsh e fish:** fora, por decisão. O arquivo do bash fica isolado para outro shell
  entrar depois sem mexer nele.

## Etapas

1. Escrever `scripts/completar.bash` (POSIX onde der, ShellCheck limpo).
2. Teste de comportamento: rodar `bash` com `COMP_WORDS`/`COMP_CWORD` simulados e
   conferir `COMPREPLY` (comandos, opções, `--modo manual`, pastas, apelidos de um
   `ssh/config` de teste).
3. Teste de sincronia com o código (item 2 da decisão).
4. Instalar e remover junto com o link da F4 (`server/setup/local.js`).
5. Sem o `bash-completion`: pergunta, bloco marcado no `~/.bashrc` (mesmo código da F4)
   e aviso no `diagnosticar`.
6. README, TUTORIAL e AGENTS.
7. e2e de instalação: num shell interativo do contêiner, `dashboard atu<Tab>` vira
   `dashboard atualizar`.

## Testes

- Unitário de comportamento e de sincronia (etapas 2 e 3).
- ShellCheck do arquivo novo (já roda no `npm run check` e no `npm run seguranca`).

## Riscos

- O `bash-completion` carrega pelo nome do comando. Em `./dashboard <Tab>`, o bash procura
  o caminho completo e depois só o nome; a etapa 2 confere isso no bash do Debian e do
  Fedora.
- `~/.ssh/config` com `Include`: a 1ª versão lê só o arquivo principal. Documentar.
