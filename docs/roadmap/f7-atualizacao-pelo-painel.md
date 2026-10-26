# F7 — Atualização pelo painel, com aviso e log

- **Nível:** G · **Versão:** 2.5.0 · **Áreas:** telas, instalação, segurança
- **Vale para:** instalação por `git clone` (ADR 0012). O modo `.deb` usa a mesma tela com
  outro executor (F9).
- **Decidido:** procurar versão nova 1 vez por dia, sempre ligado; qualquer sessão logada
  pode atualizar.
- **Decidido também (26/10/2026):**
  1. Painel sem login (`DASH_TOKEN` vazio): o aviso de versão nova aparece, mas o botão
     fica desligado e mostra o comando do terminal. Sem login não há sessão, e qualquer
     programa da máquina poderia pedir a atualização.
  2. Versão que muda o script de coleta: aviso antes, por um marcador no CHANGELOG (item 9
     da decisão).

## Objetivo

1. Avisar na tela quando há versão nova, com as novidades dela.
2. Atualizar com 1 botão, sem abrir o terminal.
3. Mostrar o log da atualização ao vivo e o resultado (atualizado ou voltou atrás).

## Situação hoje

- `./dashboard atualizar` (`server/cli/atualizar.js`): `git fetch --tags`, escolhe a tag
  assinada mais nova pela lista de chaves **da versão instalada**, faz cópia de `data/`
  em `.backups/`, troca de versão (`git checkout --detach`), a versão nova liga o painel
  (`--pos-atualizacao`) e confere a saúde; se falhar, volta o código e os dados.
- O painel não acessa a internet. A única conexão que ele abre é o SSH da coleta.
- O serviço systemd do painel não define `KillMode`; vale o padrão `control-group`:
  parar o serviço mata **todos** os processos filhos dele.
- `restoreData()` apaga `data/` e copia de volta o backup.

## Decisão proposta

1. **Procurar versão nova** (`server/atualizacao/`, módulo novo):
   - 1 vez por dia, com o 1º teste ~5 min depois de o painel ligar e um atraso aleatório
     de até 1 h (não juntar todas as instalações no mesmo minuto).
   - `git fetch --quiet --tags origin` com teto de 2 min e prioridade baixa (`nice`).
   - A lista de versões sai da mesma função do CLI (`signedReleaseTags`): só tag
     **assinada** e mais nova que a instalada. Pré-versão só para quem já está numa.
   - Resultado em memória e em `data/atualizacao.json` (última verificação, versão nova).
   - Não interfere na coleta (I1): não usa SSH nem a trava de coleta.
2. **Novidades:** `git show <tag>:CHANGELOG.md`, recortando as seções entre a versão
   instalada e a nova. Sem API do GitHub e sem HTML de fora: o texto passa pelo template
   `html` (escapado).
3. **Rotas novas** (todas com sessão, CSRF, cabeçalhos e limite de mutações):

   | Rota | Método | Faz |
   |---|---|---|
   | `/api/atualizacao` | GET | `{instalada, nova, novidades, verificadoEm, modo, bloqueio}` |
   | `/api/atualizacao/verificar` | POST | procura agora (no máximo 1 vez por minuto) |
   | `/api/atualizacao/iniciar` | POST | `{versao}` igual à versão nova detectada; senão 409 |
   | `/api/atualizacao/registro` | GET | `?desde=<byte>` → pedaço novo do log + estado |

   `bloqueio` diz por que não dá para atualizar: arquivos alterados na pasta, atualização
   já rodando, pasta sem git, painel sem login.
4. **Menu de manutenção no topo** (decidido): um botão com ícone de engrenagem no
   cabeçalho, ao lado do período, abre um menu com "Atualizar" (F7) e "Reconfigurar"
   (F8), a versão instalada, a data da última verificação e "Procurar agora". Com versão
   nova, a engrenagem ganha um ponto de destaque.
5. **Aviso (a "msgbox"):** faixa no topo, discreta, com "Versão X disponível · Ver
   novidades · Atualizar". "Ver novidades" abre um `<dialog>` com o texto do item 2 e o
   botão "Atualizar agora". O SSE ganha o evento `atualizacao` para o aviso aparecer sem
   recarregar. Fechar o aviso esconde **aquela** versão até a próxima; o menu continua
   mostrando.
6. **Executor fora do serviço:** o `iniciar` não roda o `atualizar` como filho do painel
   (ele morreria junto no `stopPanel`, item "Situação hoje"). Ele usa:
   - serviço systemd: `systemd-run --user --unit=server-dashboard-atualizar --collect
     <pasta>/dashboard atualizar --registro`;
   - segundo plano: `spawn` com `detached: true` e `setsid`.
   Os argumentos vão em lista, sem shell. Nada que vem da tela entra no comando: a versão
   do pedido só é comparada com a detectada.
7. **Log e estado fora de `data/`:** pasta nova `.atualizacao/` (0700, no `.gitignore` e no
   `npm run check`), com `ultima.log` e `estado.json` (`fase`, `alvo`, `inicio`, `fim`,
   `resultado`). Motivo: a volta atrás apaga `data/` e perderia o log. Um arquivo de trava
   com PID impede 2 atualizações ao mesmo tempo. O log tem as mesmas linhas do terminal,
   sem cor e sem segredo.
8. **Tela de progresso:** o navegador lê `/api/atualizacao/registro` a cada 1 s.
   Quando o painel cai (troca de versão), a tela mostra "reiniciando o painel…" e tenta de
   novo. A sessão continua válida (`data/sessions.json` fica). No fim, mostra o resultado
   e recarrega a página para carregar a interface nova. Leitura periódica foi escolhida no
   lugar do SSE porque sobrevive à queda do painel no meio da atualização.
9. **Mudança no script de coleta:** no modo restrito, versão nova com outro script deixa
   o `authorized_keys` desatualizado (`hashMismatch`) e a coleta para até o
   `./dashboard reconfigurar`, que pede a senha do administrador do servidor. Decidido:
   - o CHANGELOG da versão traz a linha "**Exige reconfigurar o acesso ao servidor.**";
   - o aviso e o diálogo mostram isso antes de atualizar;
   - depois de atualizar, a Visão geral mostra o passo a passo se a 1ª coleta der
     `hashMismatch` (o `diagnosticar` já detecta).
10. **Compatibilidade:** a tela de progresso depende de a versão **nova** ter a rota
   `/api/atualizacao/registro`. Funciona de 2.5.0 em diante. Até a 2.4.x, atualizar pelo
   terminal.
11. **Web é o caminho padrão** (decidido): `dashboard atualizar` passa a abrir o painel já
    logado no menu de manutenção, com o diálogo de atualização aberto (link de uso único,
    como o `dashboard abrir`). `dashboard atualizar --terminal` faz tudo no terminal, como
    hoje. Sem tela gráfica (sem `DISPLAY` nem `WAYLAND_DISPLAY`, ex.: sessão SSH) ou com o
    painel parado, o comando avisa e segue no terminal sozinho. `--pre` vale nos 2 modos.

## Segurança

| Ameaça | Proteção |
|---|---|
| Site de fora dispara a atualização | CSRF de 2 camadas, Host check, sessão obrigatória |
| Versão maliciosa | só tag assinada, conferida com as chaves da versão **instalada** (ADR 0012) |
| Voltar para versão velha (downgrade) | só versão mais nova que a instalada; a volta atrás só acontece sozinha, pela falha da nova |
| Injeção pelo pedido | nenhum texto da tela vira argumento; `spawn` com lista, sem shell |
| 2 atualizações ao mesmo tempo | trava com PID; `iniciar` responde 409 |
| Vazamento no log | o log é escrito pelo `atualizar`, que não imprime segredos; teste confere que o `DASH_TOKEN` não aparece |
| Acesso à internet | só `git fetch` para o `origin` do clone; registrado no SECURITY.md |

Invariante nova proposta, **I11**: "A tela só dispara a atualização para a versão
assinada mais nova já detectada; nenhum dado da tela entra no comando."

## Etapas

1. Refatorar `atualizar.js`: separar "procurar versão" (função reutilizável) e a escrita
   em arquivo (`--registro`), sem mudar o comportamento no terminal.
2. Pasta `.atualizacao/`, trava, permissões, `.gitignore`, `npm run check` e tabela de
   Persistência do AGENTS.
3. Verificação diária + `GET /api/atualizacao` + `POST /verificar` + evento SSE.
4. Novidades a partir do CHANGELOG da tag.
5. Menu de manutenção no topo, aviso e diálogo de novidades.
6. `POST /iniciar` + executor fora do serviço (systemd-run e setsid).
7. Tela de progresso com o log, a reconexão e o recarregamento.
8. Marcador "Exige reconfigurar" (CHANGELOG, aviso e Visão geral).
9. Segurança: testes da matriz de ataque (as rotas novas entram sozinhas), mutações novas
   no `mutacao-seguranca.mjs` (tirar a sessão da rota, aceitar versão da tela), ZAP
   autenticado, SECURITY.md e ADR.
10. Ponta a ponta: repositório local com tags assinadas por uma chave de teste
    (`test-support/`), atualização que dá certo e atualização que volta atrás.
11. `dashboard atualizar` abre a web por padrão; `--terminal` e a volta sozinha para o
    terminal sem tela gráfica; ajuda da CLI, autocomplete (F5), README, TUTORIAL e AGENTS.

## Testes

- Unitário: recorte do CHANGELOG; escolha da versão; estado e trava.
- Integração: as 4 rotas com e sem sessão, com versão errada (409), com trava (409).
- e2e no navegador: aviso → diálogo → progresso → recarregar, com o painel de teste.
- Bateria no navegador real antes da 2.5.0.

## Riscos

- `systemd-run --user` indisponível (sem sessão do systemd do usuário): cai no modo
  `setsid`. Testar nos contêineres do `e2e-instalacao`.
- GitHub fora do ar: a verificação falha em silêncio e tenta no dia seguinte; a Ajuda
  mostra a data e o erro da última tentativa.
- Interface velha no navegador depois da troca: o recarregamento do item 8 e os
  arquivos com `ETag` resolvem.
