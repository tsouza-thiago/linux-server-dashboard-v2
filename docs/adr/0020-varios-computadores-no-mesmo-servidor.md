# ADR 0020 — Vários computadores no mesmo servidor: uma chave, uma linha e um sudoers por instalação

- **Status:** Aceita
- **Data:** 24/10/2026
- **Complementa:** a [ADR 0008](0008-ssh-restrito.md) (SSH restrito)

## Contexto

Até a 2.1.0, o preparo do servidor gravava o `authorized_keys` do `dashmon` inteiro, com uma
linha só, e a regra de sudo num arquivo só (`/etc/sudoers.d/dashboard`). Com 2 computadores
monitorando o mesmo servidor, a instalação mais recente apagava a linha do outro, e a coleta
dele passava a falhar com "o servidor recusou a chave do painel" (#60). A regra de sudo
também era trocada: o SMART do outro computador ficava `SEM_PERMISSAO`. O
`./dashboard desinstalar` apagava o `dashmon` inteiro, com as chaves de todos, e a dica do
`diagnosticar` ("rode `dashboard reconfigurar`") só trocava qual computador ficava sem
acesso. Duas instalações no mesmo computador dividiam a `~/.ssh/dashboard_ed25519`.

## Decisão

1. **ID da instalação:** 8 hex do SHA-256 da chave pública. Ele vem da chave, não de um
   arquivo: copiar a pasta do painel para outro computador não leva a chave (ela fica em
   `~/.ssh`), então o outro computador ganha chave e ID próprios.
2. **Rótulo legível:** o nome do computador, saneado (minúsculas, só `[a-z0-9-]`, até 24
   caracteres). O ponto vira hífen porque o `#includedir` do sudo ignora arquivo com ponto
   no nome. O rótulo só serve para leitura: dois computadores podem ter o mesmo nome, e quem
   identifica a instalação é sempre o ID.
3. **Nomes:**

   | Onde | Nome |
   |---|---|
   | Chave neste computador | `~/.ssh/dashboard-<servidor>-<id>` (e `.pub`) |
   | Comentário da linha no servidor | `dashboard@<computador>:<id>` |
   | Regra de sudo no servidor | `/etc/sudoers.d/dashboard-<computador>-<id>` |

4. **Mescla:** o preparo troca só a linha desta instalação, achada pela mesma chave (cobre
   as linhas sem ID da 2.1.0) ou pelo mesmo ID no comentário (cobre a troca do nome do
   computador). As outras linhas ficam. O passo roda num `sh -s` como root, também no modo
   manual, porque as redireções precisam de root.
5. **Sudoers por instalação:** cada instalação grava o seu arquivo e apaga só os arquivos
   do seu ID (com o `find` como root, não com um curinga do shell). A regra única da 2.1.0
   sai quando nenhuma linha sem ID sobrar no `authorized_keys`.
6. **Reconfigurar** o mesmo servidor continua com a chave desta pasta (o `IdentityFile` do
   `data/ssh/config`), inclusive a `~/.ssh/dashboard_ed25519` da 2.1.0: o ID e a linha no
   servidor não mudam. Instalação nova ou servidor novo ganham chave própria.
7. **Desinstalar** tira só a linha e o sudoers do próprio ID. O `dashmon` só sai quando não
   sobra nenhuma linha. Sem o `.pub` da chave, o painel não sabe qual linha é sua e não mexe
   no servidor.

## Consequências

- Vários computadores, com alvos diferentes, coletam do mesmo servidor sem um apagar o
  outro. Cada linha mantém o seu `command=` e o seu `from=`.
- Cada computador faz a sua coleta: com 2 painéis, o servidor recebe 2 SSH por minuto. A
  regra de 1 SSH por coleta continua valendo para cada painel.
- O nome do computador aparece no servidor (comentário e nome do sudoers). Ele só fica no
  servidor da própria pessoa e nunca vai para o repositório.
- A chave das instalações antigas mantém o nome `dashboard_ed25519` até uma instalação nova.
- A entrada no servidor só por chave SSH (servidor endurecido) fica para a #61.
