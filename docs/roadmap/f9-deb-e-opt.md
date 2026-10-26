# F9 — Instalação em `/opt` por pacote `.deb`

- **Nível:** GG · **Versão:** 2.6.0 · **Áreas:** instalação, segurança, CI
- **Depende de:** F4 (comando no PATH), F5 (autocomplete), F7 (atualização pela tela) e F8 (reconfigurar pela tela).
- **Decidido:**
  - só `.deb` (Debian, Ubuntu, Mint). O Fedora continua com o `git clone`;
  - a instalação por `git clone` continua, e cada pessoa escolhe;
  - o painel cuida da própria atualização, **sem** `apt`;
  - o critério principal do desenho da atualização é a **segurança**.
- **Perguntas em aberto:** o Node (item 6 da decisão) e várias pessoas usuárias na mesma
  máquina (item "Riscos").

## Objetivo

Instalar com `sudo apt install ./server-dashboard_X.Y.Z_all.deb`, sem `git clone` e sem
ficar dentro da pasta do projeto, com atualização pela tela (F7).

## Por que não Flatpak

O Flatpak isola apps gráficos. O painel é um serviço em segundo plano que precisa do
`ssh`, de `~/.ssh`, do `systemctl --user` e de uma porta local. Para funcionar, o Flatpak
precisaria de furos no isolamento (`--filesystem=~/.ssh`, `--talk-name` para comandos do
sistema), o que tira a vantagem dele e costuma ser recusado no Flathub. Fica registrado
aqui para a decisão não voltar sem fato novo.

## Opções de atualização avaliadas

O código em `/opt` pertence ao root. A pergunta é: quem grava a versão nova lá?

| Critério | A. `/opt` gravável pela pessoa | B. Ajudante root (polkit) | **C. Híbrido (proposta)** |
|---|---|---|---|
| Quem grava o código | a pessoa usuária | root | usuário de sistema dedicado, sem login |
| Programa malicioso rodando como a pessoa consegue… | trocar o código do painel em silêncio | pedir a atualização | só pedir "instale a versão assinada mais nova" |
| Escalada de privilégio | **sim**: código gravável pela pessoa num caminho de sistema; se o root ou outra pessoa rodar `dashboard`, roda código alterado | não pela gravação, mas um bug no ajudante vira root | não: ninguém roda com root depois da instalação |
| Processo root lendo dados da internet | não | **sim** (`git fetch` como root) | não |
| Senha para atualizar | não | sim, ou regra sem senha | não (regra do polkit estreita) |
| Integridade do `dpkg` | quebrada (arquivos alterados) | mantida | mantida (as versões ficam fora da lista do `dpkg`) |
| Volta atrás | trocar arquivos | trocar arquivos | trocar 1 link |

**Proposta: C.** Ela junta o que A e B têm de bom e corta o que têm de perigoso:

- **De A** fica a troca de versão feita pelo próprio painel, direto no `/opt`, sem `apt` e
  sem `dpkg`. **Fica de fora** a permissão de gravação da pessoa usuária: é ela que abre a
  escalada de privilégio.
- **De B** fica a autorização estreita pelo polkit (a pessoa só **pede**). **Fica de
  fora** o root: quem grava é um usuário de sistema sem privilégio, numa unidade systemd
  isolada, como o `_apt` do Debian faz para baixar pacotes.

## Decisão proposta (C — híbrido)

1. **Arquivos do pacote** (do `dpkg`, root, só leitura):

   | Caminho | O que é |
   |---|---|
   | `/opt/server-dashboard/bin/dashboard` | lançador (troca o `./dashboard` do clone) |
   | `/usr/bin/dashboard` | link para o lançador (substitui o link da F4 neste modo) |
   | `/opt/server-dashboard/libexec/atualizador` | executor, em `sh` POSIX (sem Node como root) |
   | `/opt/server-dashboard/share/allowed_signers` | chaves de partida |
   | `/opt/server-dashboard/share/semente.tar` | a versão do pacote, para a 1ª instalação |
   | `/usr/lib/systemd/system/server-dashboard-{verificar,atualizar,voltar}.service` | unidades de uso único |
   | `/usr/lib/systemd/system/server-dashboard-verificar.timer` | 1 vez por dia, com atraso aleatório |
   | `/usr/share/polkit-1/rules.d/50-server-dashboard.rules` | quem pode pedir |
   | `/usr/share/bash-completion/completions/dashboard` | autocomplete (F5) |

2. **Arquivos do executor** (usuário de sistema `_server-dashboard`, fora da lista do
   `dpkg`): `/opt/server-dashboard/repo.git` (clone sem pasta de trabalho),
   `versoes/vX.Y.Z/` (cada versão, só leitura para os outros), os links `atual` e
   `anterior`, e `estado/` (versão disponível, log, data da última troca; leitura para
   todos, sem segredo).
3. **Dados de cada pessoa** (XDG, como hoje 0700/0600): `~/.config/server-dashboard/.env`
   e `~/.local/share/server-dashboard/` (`data/`, backups). O `server/config.js` ganha o
   "modo sistema", escolhido pelo lançador; `clampPathToData` passa a usar a pasta de
   dados, não a do código.
4. **Fluxo da atualização:**
   1. O timer roda `verificar` como `_server-dashboard`: `git fetch --tags`, confere a
      assinatura com as chaves da versão **atual** e grava a versão nova em `estado/`.
   2. O painel lê `estado/` e mostra o aviso da F7.
   3. A pessoa clica em "Atualizar". O painel faz a cópia dos dados **dela** e roda
      `systemctl start server-dashboard-atualizar.service`. A unidade **não recebe
      parâmetro**: instala a versão já verificada em `estado/`.
   4. O executor confere a assinatura de novo, extrai a tag (`git archive | tar -x`) em
      `versoes/vX.Y.Z.tmp`, renomeia (atômico) e troca o link `atual` (atômico), guardando
      o anterior em `anterior`.
   5. O painel se reinicia (`systemctl --user restart`) e confere a saúde. Se falhar, roda
      `server-dashboard-voltar.service` (troca `atual` por `anterior`) e devolve os dados
      da cópia.
   6. Os logs do executor (`estado/`) e do painel aparecem juntos na tela de progresso.
5. **Regra do polkit:** pessoas do grupo `server-dashboard` podem só **iniciar** (`start`)
   só as unidades `server-dashboard-atualizar` e `server-dashboard-voltar`, sem senha.
   Nenhuma outra ação do systemd.
6. **Node:** proposta: o executor baixa o Node para `/opt/server-dashboard/node/` com a
   soma SHA-256 fixada no `scripts/node-runtime.sh` da versão (que veio numa tag
   assinada). Assim o pacote é `all` (um só para amd64 e arm64) e há 1 cópia do Node para
   todas as pessoas. Alternativa: um `.deb` por arquitetura com o Node dentro (~30 MB).
7. **Isolamento das unidades:** `User=_server-dashboard`, `NoNewPrivileges=yes`,
   `ProtectSystem=strict`, `ReadWritePaths=` só `repo.git`, `versoes`, `estado` e `node`,
   `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`,
   `RestrictAddressFamilies=AF_INET AF_INET6`, `CapabilityBoundingSet=` vazio,
   `SystemCallFilter=@system-service`, `MemoryMax` e `TimeoutStartSec`.
8. **Volta atrás manual limitada:** `voltar` só aceita a versão `anterior` e só até 24 h
   depois da troca. Motivo: impedir que um programa malicioso force uma versão velha com
   falha conhecida.
9. **Primeira confiança:** quem baixa o `.deb` confere o `SHA256SUMS` com
   `ssh-keygen -Y verify` e a chave publicada no README, a mesma das tags.
10. **Publicação:** o mantenedor gera o `.deb` com `npm run empacotar-deb` (reprodutível,
    `SOURCE_DATE_EPOCH` da tag) e assina o `SHA256SUMS`. O CI gera de novo e compara o
    hash. Só `dpkg-deb` do próprio runner, sem action de terceiros (ADR 0017).
11. **Do clone para o `.deb`:** `dashboard instalar --importar-pasta <clone>` traz o
    `.env` e o `data/` para as pastas XDG, como o `--importar-v1` faz hoje.
12. **Desinstalar:** cada pessoa roda `dashboard desinstalar` (limpa o servidor e os dados
    dela). `apt purge` remove `/opt/server-dashboard`, as unidades, a regra, o grupo e o
    usuário de sistema; não toca nas pastas pessoais.

### Alternativas consideradas para a mesma ideia

- **Unidade `.path` no lugar do polkit:** a pessoa grava um pedido numa pasta do grupo e o
  systemd inicia o executor. Funciona sem polkit, mas a regra do polkit é mais fácil de
  auditar e não cria pasta gravável compartilhada.
- **`tar.gz` assinado no Release no lugar do `git fetch`:** baixa menos, mas cria um passo
  novo de assinatura em cada versão. O `git` reaproveita as tags assinadas que já existem
  e o código do `signedReleaseTags`.
- **Versões em `/var/opt/server-dashboard/`** (o lugar do FHS para dados variáveis de
  `/opt`): mais correto pelo padrão. A proposta mantém tudo em `/opt` porque foi o pedido;
  trocar é simples se preferir.

## Etapas

1. ADR do modo sistema e do executor (com a tabela de opções acima).
2. `server/config.js`: modo sistema, pastas XDG, `clampPathToData` pela pasta de dados.
3. Lançador `bin/dashboard` e detecção do modo nos subcomandos.
4. Executor `atualizador` em `sh` (verificar, atualizar, voltar), com ShellCheck e
   testes em contêiner.
5. Unidades systemd isoladas e o timer; conferir com `systemd-analyze security`.
6. Regra do polkit e o grupo; teste de que outra unidade e outra ação são recusadas.
7. Node baixado pelo executor (ou embutido, conforme a resposta da pergunta).
8. F7 no modo sistema: o painel usa o executor no lugar do `git checkout`.
9. `npm run empacotar-deb` reprodutível, `SHA256SUMS` assinado e conferência no CI.
10. `--importar-pasta`, `desinstalar` e `apt purge`.
11. `scripts/e2e-instalacao/`: instalar o `.deb`, atualizar, voltar, desinstalar, em
    Debian e Ubuntu.
12. README, TUTORIAL, AGENTS, SECURITY e o passo novo de "Publicar uma versão".

## Riscos

- **Grupo novo só vale no próximo login:** o `systemd --user` só enxerga o grupo depois
  de sair e entrar. A instalação avisa.
- **Várias pessoas na mesma máquina:** cada uma tem o seu painel e precisa de outra porta.
  Confirmar se é um caso de uso; se não for, a 1ª versão atende 1 pessoa e documenta.
- **Clone e `.deb` na mesma máquina:** o `~/.local/bin/dashboard` (F4) vem antes do
  `/usr/bin/dashboard` no PATH. O `diagnosticar` avisa qual roda.
- **Troca de chave de assinatura:** segue a regra de hoje (a chave nova precisa estar na
  lista da versão instalada).
- **Tamanho do trabalho:** é a maior feature do roadmap. Deve ser feita em pré-versões por
  grupo de etapas, com o modo clone intacto em todas.
