# ADR 0042 — Modo sistema: pacote `.deb` em `/opt` e executor sem privilégio

- **Status:** Aceita
- **Data:** 05/11/2026 (decisões aprovadas pelo mantenedor em 26/10/2026)
- **Feature:** F9 (#92), etapa 1 de 12

## Contexto

Hoje o painel só se instala por `git clone`, e o código fica na pasta do projeto, junto do `.env` e de
`data/`. A F9 traz uma 2ª forma: `sudo apt install ./server-dashboard_X.Y.Z_all.deb`, com o código em
`/opt` e sem `git clone`. O plano completo está em
[docs/roadmap/f9-deb-e-opt.md](../roadmap/f9-deb-e-opt.md). Já estava decidido:

- só `.deb` (Debian, Ubuntu, Mint). O Fedora continua com o `git clone`. O Flatpak fica fora: o
  painel precisa do `ssh`, de `~/.ssh`, do `systemctl --user` e de uma porta local, e o isolamento do
  Flatpak teria de ser furado;
- a instalação por `git clone` continua, e cada pessoa escolhe;
- o painel cuida da própria atualização, **sem** `apt`, com a tela da F7 (ADR 0030 a 0032);
- o critério principal do desenho da atualização é a **segurança**.

O código em `/opt` pertence ao root. A pergunta desta ADR é: quem grava a versão nova lá?

## Opções avaliadas

| Critério | A. `/opt` gravável pela pessoa | B. Ajudante root (polkit) | **C. Híbrido (escolhida)** |
|---|---|---|---|
| Quem grava o código | a pessoa usuária | root | usuário de sistema dedicado, sem login |
| Programa malicioso rodando como a pessoa consegue… | trocar o código do painel em silêncio | pedir a atualização | só pedir "instale a versão assinada mais nova" |
| Escalada de privilégio | **sim**: código gravável pela pessoa num caminho de sistema; se o root ou outra pessoa rodar `dashboard`, roda código alterado | não pela gravação, mas um bug no ajudante vira root | não: ninguém roda com root depois da instalação |
| Processo root lendo dados da internet | não | **sim** (`git fetch` como root) | não |
| Senha para atualizar | não | sim, ou regra sem senha | não (regra do polkit estreita) |
| Integridade do `dpkg` | quebrada (arquivos alterados) | mantida | mantida (as versões ficam fora da lista do `dpkg`) |
| Volta atrás | trocar arquivos | trocar arquivos | trocar 1 link |

A opção C junta o que A e B têm de bom e corta o que têm de perigoso:

- **De A** fica a troca de versão feita pelo próprio painel, direto no `/opt`, sem `apt` e sem
  `dpkg`. **Fica de fora** a permissão de gravação da pessoa usuária: é ela que abre a escalada de
  privilégio.
- **De B** fica a autorização estreita pelo polkit (a pessoa só **pede**). **Fica de fora** o root:
  quem grava é um usuário de sistema sem privilégio, numa unidade systemd isolada, como o `_apt` do
  Debian faz para baixar pacotes.

## Decisão

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

2. **Arquivos do executor** (usuário de sistema `_server-dashboard`, fora da lista do `dpkg`):
   `/opt/server-dashboard/repo.git` (clone sem pasta de trabalho), `versoes/vX.Y.Z/` (cada versão, só
   leitura para os outros), os links `atual` e `anterior`, e `estado/` (versão disponível, log, data
   da última troca; leitura para todos, sem segredo).
3. **Dados de cada pessoa** (XDG, com as permissões de hoje, 0700/0600):
   `~/.config/server-dashboard/.env` e `~/.local/share/server-dashboard/` (`data/`, backups). O
   `server/config.js` ganha o "modo sistema", escolhido pelo lançador. O `clampPathToData` passa a
   usar a pasta de dados, não a do código.
4. **Fluxo da atualização:**
   1. O timer roda `verificar` como `_server-dashboard`: `git fetch --tags`, confere a assinatura com
      as chaves da versão **atual** e grava a versão nova em `estado/`.
   2. O painel lê `estado/` e mostra o aviso da F7.
   3. A pessoa clica em "Atualizar". O painel faz a cópia dos dados **dela** e roda
      `systemctl start server-dashboard-atualizar.service`. A unidade **não recebe parâmetro**:
      instala a versão já verificada em `estado/`.
   4. O executor confere a assinatura de novo, extrai a tag (`git archive | tar -x`) em
      `versoes/vX.Y.Z.tmp`, renomeia (operação atômica) e troca o link `atual` (operação atômica),
      guardando o anterior em `anterior`.
   5. O painel se reinicia (`systemctl --user restart`) e confere a saúde. Se falhar, roda
      `server-dashboard-voltar.service` (troca `atual` por `anterior`) e devolve os dados da cópia.
   6. Os logs do executor (`estado/`) e do painel aparecem juntos na tela de progresso.
5. **Regra do polkit:** pessoas do grupo `server-dashboard` podem só **iniciar** (`start`) só as
   unidades `server-dashboard-atualizar` e `server-dashboard-voltar`, sem senha. Nenhuma outra ação
   do systemd.
6. **Node:** o executor baixa o Node para `/opt/server-dashboard/node/` com a soma SHA-256 fixada no
   `scripts/node-runtime.sh` da versão (que veio numa tag assinada). Assim o pacote é `all` (um só
   para amd64 e arm64) e há 1 cópia do Node para todas as pessoas.
7. **Isolamento das unidades:** `User=_server-dashboard`, `NoNewPrivileges=yes`,
   `ProtectSystem=strict`, `ReadWritePaths=` só `repo.git`, `versoes`, `estado` e `node`,
   `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`,
   `RestrictAddressFamilies=AF_INET AF_INET6`, `CapabilityBoundingSet=` vazio,
   `SystemCallFilter=@system-service`, `MemoryMax` e `TimeoutStartSec`.
8. **Volta atrás manual limitada:** `voltar` só aceita a versão `anterior` e só até 24 h depois da
   troca. Motivo: impedir que um programa malicioso force uma versão velha com falha conhecida.
9. **Primeira confiança:** quem baixa o `.deb` confere o `SHA256SUMS` com `ssh-keygen -Y verify` e a
   chave publicada no README, a mesma das tags.
10. **Publicação:** o mantenedor gera o `.deb` com `npm run empacotar-deb` (reprodutível, com o
    `SOURCE_DATE_EPOCH` da tag) e assina o `SHA256SUMS`. O CI gera de novo e compara o hash. Só o
    `dpkg-deb` do próprio runner, sem action de terceiros (ADR 0017).
11. **Do clone para o `.deb`:** `dashboard instalar --importar-pasta <clone>` traz o `.env` e o
    `data/` para as pastas XDG, como o `--importar-v1` faz hoje.
12. **Desinstalar:** cada pessoa roda `dashboard desinstalar` (limpa o servidor e os dados dela). O
    `apt purge` remove `/opt/server-dashboard`, as unidades, a regra, o grupo e o usuário de sistema.
    Ele não toca nas pastas pessoais.

## Alternativas consideradas

- **A. `/opt` gravável pela pessoa** e **B. ajudante root pelo polkit:** recusadas pelos motivos da
  tabela acima.
- **Um `.deb` por arquitetura com o Node dentro:** ~30 MB cada, e trocar o Node exigiria um `.deb`
  novo. Recusada em favor do item 6.
- **Unidade `.path` no lugar do polkit:** a pessoa grava um pedido numa pasta do grupo e o systemd
  inicia o executor. Funciona sem polkit, mas a regra do polkit é mais fácil de auditar e não cria
  pasta gravável compartilhada.
- **`tar.gz` assinado no Release no lugar do `git fetch`:** baixa menos, mas cria um passo novo de
  assinatura em cada versão. O `git` reaproveita as tags assinadas que já existem e o código do
  `signedReleaseTags`.
- **Versões em `/var/opt/server-dashboard/`** (o lugar do FHS para dados variáveis de `/opt`): mais
  correto pelo padrão. Fica tudo em `/opt` porque foi o pedido; trocar depois é simples.
- **Flatpak:** recusado (veja o Contexto).

## Consequências

- Depois da instalação, nada do painel roda como root. O `git fetch` e a extração da versão rodam
  como `_server-dashboard`, numa unidade isolada. A pessoa só pede, e o pedido não leva dado nenhum.
- A integridade do `dpkg` fica mantida: as versões instaladas pelo executor ficam fora da lista dele.
- A volta atrás é a troca de 1 link, e só para a versão `anterior`, por 24 h.
- O modo clone continua igual em todas as etapas. A F9 sai em pré-versões da 2.6.0, por grupo de
  etapas (ADR 0023).
- Riscos aceitos:
  - **Grupo novo só vale no próximo login:** o `systemd --user` só enxerga o grupo
    `server-dashboard` depois de sair e entrar. A instalação avisa.
  - **1 pessoa por máquina na 1ª versão:** a instalação recusa uma 2ª pessoa com um aviso claro, e o
    README documenta o limite. Várias pessoas (uma porta e um painel por pessoa) ficam para depois.
  - **Clone e `.deb` na mesma máquina:** o `~/.local/bin/dashboard` (F4) vem antes do
    `/usr/bin/dashboard` no PATH. O `diagnosticar` avisa qual roda.
  - **Troca de chave de assinatura:** segue a regra de hoje (a chave nova precisa estar na lista da
    versão instalada).
  - **Tamanho do trabalho:** é a maior feature do roadmap. Sai em 12 etapas, uma sessão e um PR por
    etapa.
- As etapas 2 a 12 mudam o modelo de ameaças (SECURITY.md) e a referência técnica (AGENTS.md); a
  etapa 12 fecha a documentação.
