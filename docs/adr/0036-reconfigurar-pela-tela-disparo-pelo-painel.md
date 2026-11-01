# ADR 0036 — Reconfigurar pela tela: o disparo pelo painel

- **Status:** Aceita
- **Data:** 01/11/2026

## Contexto

As ADRs 0034 e 0035 prepararam o `dashboard reconfigurar --pela-tela`, mas nada o disparava. A etapa 3
da F8 (#91) traz a rota `POST /api/reconfigurar/iniciar`. O comando recusa o que não pode fazer, mas
sem terminal essa recusa chega tarde: o navegador já espera o assistente. A F7 deixou o executor fora
do serviço e a trava da atualização (ADR 0031). Era preciso decidir o que barra antes de disparar e
como a rota convive com a atualização.

## Decisão

1. **A rota mora no `Atualizacao`.** Ela divide com o botão Atualizar o login, a trava, a pasta e o
   executor. Os 2 botões disputam a mesma pasta, e cada um precisa saber do outro.
2. **O executor é o mesmo, com outro alvo.** O comando é fixo, sem shell, e a unidade é
   `server-dashboard-reconfigurar`. Com o nome próprio, o `systemd-run` recusa um 2º disparo. A rota
   não lê nada do pedido (I11).
3. **O que barra vem antes de criar o código.** A resposta é 409 com `bloqueio`: `sem-login`, `rodando`
   (atualização em andamento), `outra-pasta` e `sem-assinatura`. Este último é novo: o comando fixo não
   leva `--sem-assinatura` e recusaria.
4. **Arquivo alterado não barra.** O `arquivos-alterados` existe porque a atualização faz `checkout`. O
   `--pela-tela` nunca troca a versão da pasta (ADR 0034) e aceita a pasta assim. Barrar aqui seria
   exigir o que o comando não exige.
5. **Depois de disparar, 1 min em que nada mais dispara.** A trava fica na memória do painel. O painel
   cai em segundos, mas nesse tempo um 2º pedido traria 2 problemas: o código novo invalidaria o que o
   1º navegador recebeu, e, em segundo plano, 2 comandos disputariam a porta. A atualização também
   espera (`rodando`): ela pararia o painel que o assistente acabou de substituir. Se o comando recusar,
   o painel fica no ar e o botão volta depois desse tempo. É o mesmo 1 min da ADR 0031.
6. **Executor que não sobe tira o código do disco.** O código só existe por esse pedido, e ninguém o
   recebeu. Criar o código antes é obrigatório: o comando lê o arquivo logo ao subir. A resposta é 503 e
   a trava de 1 min sai junto, para a pessoa tentar de novo.
7. **O código só sai na resposta do `POST`.** Ele não vai para o log do painel, para o SSE nem para o
   estado de `/api/atualizacao`. A API já responde com `no-store`.

## Consequências

- Os bloqueios só aparecem depois do clique. A etapa 4 mostra o motivo no diálogo. O `sem-login` já vem
  em `/api/atualizacao`, para o botão nascer desligado. Conferir a assinatura a cada estado custaria um
  `git verify-tag` por evento, então esse bloqueio não entra lá.
- A conferência roda `git` e `ssh-keygen` de forma síncrona, 1 vez por clique, como a `conferirPasta` do
  botão Atualizar. O limite de mutações segura o abuso.
- Um comando que sobe e recusa por outro motivo (fontes alteradas, falta de `ssh`) deixa o código no
  disco até vencer, em 5 min. É só o hash, e só o `--pela-tela` o lê. O motivo fica em
  `data/reconfigurar.log`, e a tela mostra isso na etapa 5.
- A trava de 1 min mora na memória: reiniciar o painel a apaga. Nesse caso o comando já parou o painel,
  ou recusou. Nos 2 casos não há o que proteger.

## Alternativas descartadas

- **Colocar a rota num módulo próprio:** duplicaria o login e a trava, e a atualização não veria o
  disparo.
- **Barrar enquanto `data/reconfigurar.json` existir:** um comando que recusa deixaria o botão preso por
  5 min, sem ninguém entender o motivo.
- **Trava sem prazo, até o painel reiniciar:** o mesmo problema, sem fim.
- **Mostrar `sem-assinatura` em `/api/atualizacao`:** o custo acima, por um botão que quase nunca muda.
