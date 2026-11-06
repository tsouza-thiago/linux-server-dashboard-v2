# ADR 0049 — Pacote `.deb` reprodutível, 1ª instalação e `SHA256SUMS` assinado

- **Status:** Aceita
- **Data:** 05/11/2026
- **Feature:** F9 (#92), etapa 9 de 12. Aplica os itens 1, 9 e 10 da
  [ADR 0042](0042-modo-sistema-deb-e-executor-em-opt.md) e completa as
  [ADR 0044](0044-executor-atualizador-do-pacote.md) (subcomando novo),
  [0045](0045-unidades-systemd-do-executor.md), [0046](0046-regra-do-polkit-e-grupos-do-pacote.md) e
  [0047](0047-rede-do-atualizar-para-o-node.md) (o que o pacote cria).

## Contexto

As etapas 2 a 8 deixaram prontas as peças do modo sistema: lançador, executor, unidades, regra do
polkit, grupos e o painel ligado ao executor. Falta o pacote que as instala. A ADR 0042 fixou a tabela
de arquivos, o pacote `all`, a geração reprodutível com `SOURCE_DATE_EPOCH` da tag, o `SHA256SUMS`
assinado e a conferência no CI só com o `dpkg-deb` do runner. Ficaram abertos: como a 1ª versão e o
1º Node entram em `/opt` sem root rodar código da internet, quem põe a pessoa no grupo, o que torna o
pacote igual em máquinas diferentes e em que namespace a chave assina o `SHA256SUMS`.

## Decisão

1. **`npm run empacotar-deb`** (`scripts/empacotar-deb.mjs`): gera
   `dist/server-dashboard_<versão>_all.deb` e `dist/SHA256SUMS` a partir de uma ref do git (padrão: a
   tag `v<versão do package.json>`; `--ref HEAD` no CI). Tudo sai da ref com `git show` e
   `git archive`, nunca da pasta de trabalho. A tag precisa trazer a mesma versão no `package.json`.
   A pré-versão vira `X.Y.Z~rc.N` no Debian, que ordena antes da final.
2. **Reprodutível:** `SOURCE_DATE_EPOCH` é a data do commit da ref (a mesma que o `git archive` grava
   na semente). Todos os arquivos recebem essa data, pastas 0755, arquivos 0644 ou 0755, dono root
   (`--root-owner-group`) e o git roda sem a configuração do sistema e da pessoa. O `dpkg-deb` comprime
   com xz em 1 thread (`--threads-max=1`): com várias, o resultado muda com o número de núcleos.
   Conferido: Ubuntu 24.04 (dpkg 1.22.6, git 2.43), Debian 13 (dpkg 1.22.22, git 2.47) e a máquina do
   mantenedor (dpkg 1.23.7, git 2.53) geram os mesmos bytes.
3. **Conteúdo:** os arquivos da tabela da ADR 0042, mais o `copyright` em `/usr/share/doc`, o
   `sysusers.d` (ADR 0046), o `md5sums` e os links `<base>/atual` → `versoes/atual` (ADR 0045) e
   `/usr/bin/dashboard` → `/opt/server-dashboard/bin/dashboard`. `repo.git`, `versoes`, `estado` e
   `node` ficam fora da lista do `dpkg`: o `postinst` os cria. Depende de `systemd`,
   `polkitd | policykit-1`, `git`, `openssh-client`, `curl | wget` e `ca-certificates`; recomenda
   `bash-completion`.
4. **1ª instalação pelo executor:** o subcomando novo `atualizador semear` extrai a
   `share/semente.tar` (o `git archive` da tag, o mesmo formato do `atualizar`) para `versoes/vX.Y.Z`
   e cria o link `versoes/atual`, só quando ele ainda não existe. Depois, baixa o Node da versão com a
   soma SHA-256 dela (a mesma função do `atualizar`, ADR 0047), só se `node/bin/node` faltar. O
   `postinst` o roda com `runuser -u _server-dashboard`: root só extrai o que veio no próprio pacote, e
   o download fica com o usuário sem privilégio. A versão sai do `package.json` da semente e passa pelo
   padrão das tags. Rodar de novo (reinstalar) só completa o que faltou; uma semente mais nova que a
   versão atual não troca nada (quem troca é o `atualizar`, com a assinatura conferida).
5. **`postinst`:** `systemd-sysusers`, as 4 pastas do executor (0755, do `_server-dashboard`), o
   `semear`, o timer ligado só na 1ª instalação (quem o desligou continua com ele desligado) e o grupo.
   Uma falha no `semear` (sem internet, por exemplo) só avisa e manda reinstalar: o pacote fica
   configurado. O `prerm` desliga o timer na remoção; o `postrm` relê as unidades. O `apt purge` é da
   etapa 10.
6. **Grupo da pessoa:** o `postinst` põe no grupo `server-dashboard` a conta que instalou (`SUDO_USER`
   ou `PKEXEC_UID`, da loja de programas), só se ela for de pessoa (UID 1000 ou mais, fora o
   `nobody`, nome no formato do Debian) e só com o grupo vazio (1 pessoa por máquina, ADR 0042). Ele
   avisa que só vale depois de sair e entrar de novo. Sem conta detectada, mostra o
   `sudo usermod -a -G server-dashboard <sua-conta>`.
7. **`SHA256SUMS` assinado:** o mantenedor assina com
   `ssh-keygen -Y sign -f <chave> -n server-dashboard SHA256SUMS`, a chave das tags. A linha dela em
   `docs/allowed_signers` passa a `namespaces="git,server-dashboard"`: o namespace próprio impede que
   uma assinatura do `SHA256SUMS` valha como assinatura de tag, e o contrário. Quem baixa confere com
   `ssh-keygen -Y verify -f allowed_signers -I tsouza-thiago -n server-dashboard -s SHA256SUMS.sig`.
8. **CI:** o job `check` do `verificação` gera o pacote do `HEAD` 2 vezes, com umask e fuso diferentes,
   e compara. O workflow novo `pacote.yml` roda a cada Release publicado (ou à mão, com a tag): gera o
   `.deb` da tag, baixa o `SHA256SUMS`, a assinatura e o `.deb` do Release, confere a assinatura com o
   `allowed_signers` da tag e compara os 3 hashes. Só `dpkg-deb`, `curl` e `ssh-keygen` do runner, sem
   action de terceiros e sem token (o Release é público).

## Alternativas consideradas

- **Escrever o `.deb` em Node (ar e tar próprios):** controle total dos bytes, mas foge do item 10 da
  ADR 0042 (só o `dpkg-deb`) e é mais código para auditar. O `dpkg-deb` com as opções acima já é
  reprodutível entre versões.
- **gzip ou sem compressão:** o xz com 1 thread deu os mesmos bytes nas 3 versões do dpkg testadas;
  fica o xz, menor.
- **Root extrai a semente e baixa o Node no `postinst`:** mais simples, mas root leria dados da
  internet, o que a ADR 0042 descarta.
- **Node só pelo `atualizar`:** sem Node do sistema, o painel não rodaria até a 1ª versão nova.
- **Assinar o `SHA256SUMS` no namespace `git` ou `file`:** `git` deixaria a assinatura de um arquivo
  valer como a de uma tag; `file` é genérico e serviria a qualquer outro arquivo que a mesma chave
  assine.
- **Pedir a conta pela tela de configuração do `debconf`:** pergunta a mais numa instalação que já
  sabe quem pediu; sem conta detectada, o aviso basta.

## Consequências

- O mantenedor gera o `.deb` e assina o `SHA256SUMS` em cada versão; o passo entra em "Publicar uma
  versão" na etapa 12. O CI acusa um `.deb` publicado que não sai da tag.
- A instalação baixa o Node (~30 MB) uma vez, como `_server-dashboard`. Sem internet, o pacote fica
  instalado e avisa; reinstalar completa.
- `test/integration/empacotar-deb.test.js` confere a reprodução, o conteúdo, os donos e as recusas;
  `test/unit/pacote-debian.test.js`, os scripts do mantenedor com comandos falsos; o
  `test/integration/atualizador.test.js`, o `semear`. A instalação de verdade, em contêiner, é da
  etapa 11.
