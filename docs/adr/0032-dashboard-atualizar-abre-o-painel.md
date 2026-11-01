# ADR 0032 — `dashboard atualizar` abre o painel, e o `--pre` passa pelo dono da pasta

- **Status:** Aceita
- **Data:** 01/11/2026

## Contexto

A ADR 0031 trouxe o botão Atualizar, com log ao vivo e volta atrás visível. O comando do terminal
seguia por outro caminho, sem nada disso. A F7 decidiu que a web é o caminho padrão (#90, 3ª entrega).
Isso traz 3 perguntas: como o terminal abre o diálogo certo, o que acontece onde a web não serve, e
como o `--pre` chega ao executor sem que a tela entre no comando (I11).

## Decisão

1. **O comando só abre a tela.** `dashboard atualizar` passa pelas mesmas conferências da pasta (#118)
   e abre o link de uso único do `dashboard abrir`, com o fragmento `#/visao-geral?atualizar=1`. Quem
   troca de versão continua sendo o clique em **Atualizar agora**.
2. **O fragmento fica no navegador.** O `/entrar` redireciona para `/`, sem fragmento, e o navegador
   mantém o do pedido (RFC 9110). O servidor não muda: não há destino de redirecionamento para validar,
   nem superfície nova. A tela lê o pedido, limpa o endereço e pede a procura. Recarregar a página não
   abre o diálogo de novo.
3. **A tela procura antes de mostrar.** Quem rodou o comando quer a versão de agora, não a da última
   procura. Sem versão nova, o menu fica aberto, com a versão instalada. A trava de 1 procura por minuto
   continua valendo: acima dela, a tela usa o que já sabe.
4. **`--terminal` e a queda sozinha para o terminal.** Sem `DISPLAY` nem `WAYLAND_DISPLAY`, com o painel
   parado, sem login ou sem navegador, o comando avisa e segue no terminal. Sem login, a tela só
   mandaria a pessoa de volta: o botão fica desligado. Por isso o diálogo mostra `./dashboard atualizar
   --terminal` nos bloqueios: o comando sem a opção abriria a mesma tela.
5. **`--pre` pela tela é uma liberação do dono da pasta.** O comando do executor é fixo (I11), e a tela
   não pode pedir pré-versão. O `dashboard atualizar --pre` grava `.atualizacao/pre.json` (0600) com um
   prazo de 30 min. A procura e o executor leem esse arquivo. Só quem escreve na pasta cria o arquivo,
   ele vence sozinho e sai depois de 1 troca. No terminal, o `--pre` continua valendo só para aquele
   comando.
6. **Marcador "Exige reconfigurar".** A versão que muda o script de coleta sobe o `COLLECTOR_VERSION` e
   traz a linha `**Exige reconfigurar o acesso ao servidor.**` no CHANGELOG. O recorte das novidades
   procura a linha em todas as seções da faixa, mesmo nas cortadas pelo teto, e a tela avisa antes de
   atualizar. Só vale com `SSH_ACESSO=restrito`: no acesso direto, o painel envia o script novo.
7. **O passo a passo depende do `hashMismatch`, não da atualização.** A Visão geral não precisa saber
   como a versão chegou: uma atualização pelo terminal não escreve o registro. O aviso vale também para
   quem mudou o `.env` à mão. O terminal avisa no fim da troca.

## Consequências

- Scripts que rodam `dashboard atualizar` numa sessão com tela precisam passar `--terminal`.
- `test/integration/atualizacao-ponta-a-ponta.test.js` roda o `./dashboard` de verdade numa pasta
  temporária, com `HOME` próprio, e entra em todo `npm run check`. Ele acrescenta ~20 s à suíte.
- O cenário D de `scripts/e2e-instalacao/rodar.sh` confere o `systemd-run --user` e o segundo plano,
  na atualização que dá certo e na que volta atrás. O systemd roda num contêiner sem `--privileged`.
- As tags de versão seguem presas a `v2.*` (`RELEASE_TAG`). Uma V3 precisa mudar essa conferência
  antes da 1ª tag.

## Alternativas descartadas

- **Parâmetro de destino no `/entrar`:** seria um redirecionamento a validar, sem ganho sobre o
  fragmento.
- **`--pre` na URL ou no pedido:** seria um dado da tela no comando, contra a I11.
- **Saber pelo `.atualizacao/estado.json` que a versão acabou de mudar:** a troca pelo terminal não o
  escreve, e o aviso precisaria de outra regra para quem mudou o `.env`.
