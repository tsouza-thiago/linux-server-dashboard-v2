# ADR 0045 — Unidades systemd do executor e links em `versoes/`

- **Status:** Aceita
- **Data:** 05/11/2026
- **Feature:** F9 (#92), etapa 5 de 12. Complementa a [ADR 0042](0042-modo-sistema-deb-e-executor-em-opt.md)
  (itens 1, 4 e 7) e muda o item 7 da [ADR 0044](0044-executor-atualizador-do-pacote.md) (onde ficam os links).

## Contexto

A ADR 0042 decidiu rodar o executor por 3 unidades de uso único e um timer, com `ProtectSystem=strict`
e gravação só em `repo.git`, `versoes`, `estado` e `node`. Na ADR 0044, os links `atual` e `anterior`
e o temporário `.atual.novo` ficam na própria pasta base `/opt/server-dashboard`. Então a unidade
precisaria gravar na base inteira. Com isso, o usuário `_server-dashboard` também poderia trocar o
`bin/`, o `libexec/` e o `share/` do pacote, que são do root.

## Decisão

1. **Links em `versoes/`.** O executor troca `versoes/atual` e `versoes/anterior` (alvos relativos
   `vX.Y.Z`), com o temporário `versoes/.atual.novo`. A base guarda só um link **fixo**, do pacote:
   `<base>/atual → versoes/atual`. O lançador e o `server/config.js` seguem o `<base>/atual` como
   antes (`readlink -f` resolve os 2 links). A base fica do root, e nenhuma unidade grava nela.
2. **`repo.git` criado pelo pacote**, vazio e do `_server-dashboard` (a unidade não cria pasta na
   base). O executor o inicia quando falta o `repo.git/HEAD`. As pastas `repo.git`, `versoes`,
   `estado` e `node` são criadas na instalação do pacote (etapa 9).
3. **Arquivos:** `pacote/systemd/` no repositório; `/usr/lib/systemd/system/` no pacote:
   `server-dashboard-{verificar,atualizar,voltar}.service` e `server-dashboard-verificar.timer`.
4. **Unidades:** `Type=oneshot`, `ExecStart=/opt/server-dashboard/libexec/atualizador <subcomando>`
   fixo, sem especificador, variável, `Environment=` ou outro `Exec*=`. Sem `[Install]`: só o timer
   (verificar) e o painel pelo polkit (atualizar e voltar, etapa 6) as iniciam.
5. **Gravação por unidade (`ReadWritePaths=`):** `verificar` só `repo.git` e `estado`; `atualizar` e
   `voltar` só `versoes` e `estado`. O `node` entra no `atualizar` na etapa 7.
6. **Rede:** só o `verificar` usa (`RestrictAddressFamilies=AF_INET AF_INET6`). O `AF_UNIX` não entra:
   a saída para o journal é um arquivo aberto pelo systemd antes do isolamento, não um socket novo.
   `atualizar` e `voltar` ficam sem rede (`PrivateNetwork=yes`, `IPAddressDeny=any`,
   `RestrictAddressFamilies=none`). A etapa 7 dá ao `atualizar` a rede que o download do Node pedir.
7. **Isolamento comum:** o do item 7 da ADR 0042 (`User=_server-dashboard`, `NoNewPrivileges=yes`,
   `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`,
   `CapabilityBoundingSet=` vazio, `SystemCallFilter=@system-service`, `MemoryMax=`,
   `TimeoutStartSec=`) mais `PrivateUsers=`, `PrivateIPC=`, as proteções de kernel, cgroups, relógio
   e hostname, `ProtectProc=invisible`, `ProcSubset=pid`, `RestrictNamespaces=`,
   `RestrictSUIDSGID=`, `MemoryDenyWriteExecute=`, `SystemCallFilter=~@privileged @resources`,
   `Nice=19` e `IOSchedulingClass=idle`. `UMask=0022`: o `estado/` e as versões são leitura para
   todos, sem segredo (ADR 0044).
8. **Timer:** `OnCalendar=daily`, `RandomizedDelaySec=6h` (espalha os pedidos ao GitHub) e
   `Persistent=true` (roda a procura perdida com a máquina desligada).
9. **Nota máxima** do `systemd-analyze security`: 1,5 no `verificar` e 0,5 nos outros (medido no
   systemd 259: 1,1 e 0,2). Subir a nota exige uma ADR nova.

## Consequências

- `test/unit/unidades-systemd.test.js` exige cada diretiva, roda o `systemd-analyze verify` numa raiz
  falsa (aviso também reprova) e confere a nota. Sem a ferramenta, essa parte pula; no CI, falha.
- `test/integration/atualizador.test.js` roda o executor com a base só leitura e, para cada
  subcomando, com só as pastas do `ReadWritePaths=` da unidade liberadas para gravação.
- 4 mutações novas em `scripts/mutacao-seguranca.mjs`: link trocado na base, unidade sem
  `ProtectSystem`, unidade que grava na base e unidade com parâmetro de fora.
- As unidades só rodam de verdade no pacote (etapa 9) e nos testes de ponta a ponta (etapa 11).
