# ADR 0046 — Regra do polkit e grupos do pacote

- **Status:** Aceita
- **Data:** 05/11/2026
- **Feature:** F9 (#92), etapa 6 de 12. Complementa a [ADR 0042](0042-modo-sistema-deb-e-executor-em-opt.md)
  (itens 2 e 5) e a [ADR 0045](0045-unidades-systemd-do-executor.md) (item 4).

## Contexto

A ADR 0042 decidiu que pessoas do grupo `server-dashboard` podem só iniciar as unidades
`server-dashboard-atualizar` e `server-dashboard-voltar`, sem senha, e que o executor roda como o
usuário de sistema `_server-dashboard`. Faltava decidir o texto da regra, como o pacote cria o grupo e
o usuário, e como testar os 2 sem root.

## Decisão

1. **Regra:** `pacote/polkit/50-server-dashboard.rules` no repositório;
   `/usr/share/polkit-1/rules.d/50-server-dashboard.rules` no pacote. Ela devolve `YES` só quando as 4
   condições valem juntas: ação `org.freedesktop.systemd1.manage-units`, pessoa no grupo
   `server-dashboard`, unidade `server-dashboard-atualizar.service` ou `server-dashboard-voltar.service`
   (nome exato) e verbo `start`. Em qualquer outro caso ela não devolve nada, e vale o padrão do polkit
   (senha do administrador). A regra não usa `polkit.spawn` nem outro `Result`.
2. **Sem `subject.local` nem `subject.active`:** o painel roda no `systemd --user`, fora de uma sessão
   de login, e o polkit o vê como inativo. Exigir sessão ativa barraria o pedido do próprio painel.
3. **ES5:** o polkit roda as regras em Duktape ou SpiderMonkey, conforme a versão. A regra usa só ES5.
4. **Grupos por `sysusers.d`:** `pacote/sysusers/server-dashboard.conf` no repositório;
   `/usr/lib/sysusers.d/server-dashboard.conf` no pacote, aplicado pelo `systemd-sysusers` na
   instalação (etapa 9). Ele cria o grupo `server-dashboard`, vazio, e o usuário `_server-dashboard`,
   com grupo próprio de mesmo nome, `/usr/sbin/nologin`, pasta pessoal `/` e senha travada. O executor
   não entra no grupo `server-dashboard`. Os números (UID e GID) são escolhidos na instalação, na faixa
   de sistema, e nunca ficam fixos no código. Motivo: o arquivo é declarativo, é o formato que o
   Debian usa para isso, e dá para testar sem root (`systemd-sysusers --root`).
5. **Quem entra no grupo:** a pessoa entra na instalação do modo sistema, com root. O comando exato e o
   aviso de "entre de novo na sessão" ficam para as etapas 9 e 10. O `apt purge` remove o usuário e o
   grupo (ADR 0042, item 12), porque o `systemd-sysusers` só cria.

## Alternativas consideradas

- **`adduser --system` no `postinst`:** funciona, mas só dá para testar com root, e o texto fica
  espalhado no script.
- **Conferir a regra com o `pkcheck`:** o `pkcheck` pergunta ao polkitd do sistema, que só lê regras
  das pastas do root. Sem root não dá para instalar a regra, e um polkitd próprio precisa do barramento
  do sistema. Fica o `pkaction`, que só lê: ele confirma que a ação existe e que o padrão dela pede a
  senha do administrador.

## Consequências

- `test/unit/polkit-e-grupo.test.js` roda a regra num `vm` com um `polkit` falso e confere cada
  combinação de ação, unidade, verbo e grupo (só 4 liberam). Ele aplica o `sysusers.d` numa raiz falsa
  e lê `passwd`, `group` e `shadow`. Sem o `systemd-sysusers`, essa parte pula; no CI, falha. Sem o
  `pkaction`, a parte dele pula.
- 5 mutações novas em `scripts/mutacao-seguranca.mjs`: outro verbo, outra unidade, outra ação, sem
  conferir o grupo e o executor no grupo do polkit.
- A regra e o grupo só valem de verdade no pacote (etapa 9) e nos testes de ponta a ponta (etapa 11).
