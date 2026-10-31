# ADR 0031 — Botão Atualizar: executor fora do serviço e registro fora de `data/`

- **Status:** Aceita
- **Data:** 31/10/2026

## Contexto

A ADR 0030 trouxe o aviso de versão nova, e a troca seguiu no terminal. O botão no painel (#90, 2ª
entrega da F7) tem 3 problemas que o terminal não tem: o `dashboard atualizar` para o painel que o
disparou, a volta atrás apaga `data/`, e qualquer pedido à tela vira uma troca de código.

## Decisão

1. **O executor roda fora do serviço** (`server/atualizacao/executor.js`). Como filho do painel, ele
   morreria no `stopPanel`: o serviço não define `KillMode`, e parar mata o grupo inteiro. Com o
   serviço instalado e o systemd do usuário de pé, roda em `systemd-run --user
   --unit=server-dashboard-atualizar --collect`. Sem eles, em segundo plano, com `spawn` e
   `detached: true`, que faz o `setsid`.
2. **Sem plano B do systemd para o segundo plano.** Se o `systemd-run` falhar com o painel dentro do
   serviço, um processo solto morreria no `stopPanel` com o painel já parado. A tela mostra a falha, e
   o painel segue no ar. O `/api/atualizacao` informa o `modo` (`systemd`, `segundo-plano` ou `null`).
3. **Log e estado ficam em `.atualizacao/`, fora de `data/`** (0700, fora do git): `ultima.log`,
   `estado.json` e `trava.pid`. A volta atrás apaga `data/` e levaria o log junto. A pasta também
   sobrevive à queda do painel, e é por isso que a tela continua depois da troca.
4. **`dashboard atualizar --registro`, opção interna.** As mesmas linhas do terminal vão para o log,
   sem cor, e a 2ª fase, rodada pela versão nova, escreve no mesmo arquivo. A troca é o mesmo código nos
   2 caminhos. O git não pergunta nada, como na procura (ADR 0030, item 5).
5. **Trava com PID, nos 2 caminhos.** O terminal e o painel respeitam `trava.pid`. Vale só se o PID
   for mesmo um `dashboard atualizar`: PID reaproveitado ou processo morto não segura nada. O executor
   leva um instante para subir, então o painel marca a fase `iniciando` de forma síncrona antes de
   disparar, e 2 pedidos seguidos não passam juntos. Sem trava depois de 1 min, o executor não subiu.
6. **Invariante I11:** a tela só dispara a atualização para a versão assinada mais nova já detectada;
   nenhum dado da tela entra no comando. A versão do pedido só é comparada com a detectada (409 se
   diferente), e o comando é fixo, em lista, sem shell. O executor procura a versão de novo, com as
   assinaturas.
7. **Sem login, sem botão** (`bloqueio: 'sem-login'`, ADR 0030, item 7). O botão fica desligado e a
   tela mostra o comando do terminal. Os outros bloqueios fazem o mesmo. Antes de disparar, o painel
   confere a pasta de novo: a regra da #118 (só a pasta da instalação) não pode depender da procura
   de ontem.
8. **Leitura periódica, não SSE.** A tela lê `/api/atualizacao/registro?desde=<byte>` a cada 1 s. O
   SSE cai junto com o painel; a leitura só falha, tenta de novo e continua do mesmo byte. A sessão
   continua válida: `data/sessions.json` fica. No fim, a página recarrega para pegar a interface
   nova. O Esc não fecha o progresso, e quem recarrega a página no meio volta para ele.

## Consequências

- `.atualizacao/` entra no `.gitignore`, no `npm run check` e na lista do `segredos-osint`. O
  `desinstalar` a apaga junto com o histórico.
- Uma atualização disparada no terminal só desliga o botão: ela não escreve o registro.
- A tela de progresso depende de a versão nova ter a rota. Vale da 2.5.0 em diante.
- A conferência com `systemd-run` real e a atualização de ponta a ponta com tags assinadas ficam na
  3ª entrega. Nesta, o executor é conferido pelos argumentos e a troca, pelo `--registro` com git de
  verdade.

## Alternativas descartadas

- **`KillMode=process` no serviço:** deixaria o filho vivo, mas só nas instalações que refizessem a
  unidade, e nada no modo em segundo plano.
- **Log em `data/`:** some na volta atrás, justo quando ele mais importa.
- **Passar a versão para o `--registro`:** seria um dado da tela no comando, contra a I11. O executor
  procura sozinho a tag assinada mais nova.
