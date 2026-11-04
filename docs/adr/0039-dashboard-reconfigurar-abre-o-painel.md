# ADR 0039 — Reconfigurar pela tela: o `dashboard reconfigurar` abre o painel

- **Status:** Aceita
- **Data:** 04/11/2026

## Contexto

A etapa 7 da F8 (#91) liga o comando do terminal ao fluxo da tela, como a ADR 0032 fez com o
`dashboard atualizar`. Até aqui, o `dashboard reconfigurar` parava o painel e subia o assistente
direto, sem o Cancelar, sem a volta da configuração anterior e sem o motivo na tela (ADR 0034 a 0037).
A decisão 5 do planejamento diz: com o painel rodando, o padrão abre o painel no menu de manutenção;
sem ele, continua o assistente no navegador, e `--terminal` abre o TUI. Faltava decidir quando o
comando abre a tela, como ela abre o diálogo e o que acontece quando a tela recusaria o clique.

## Decisão

1. **O comando só abre a tela.** `dashboard reconfigurar`, sem nenhuma opção, abre o link de uso único
   do `dashboard abrir` com o fragmento `#/visao-geral?reconfigurar=1` e sai com 0. Ele não para o
   painel, não cria o código do assistente e não roda as conferências da instalação: quem faz isso é o
   `reconfigurar --pela-tela`, depois do clique em **Reconfigurar agora** (ADR 0036).
2. **O fragmento fica no navegador**, como na ADR 0032: o `/entrar` não muda. A tela lê o pedido,
   limpa o endereço, busca o estado de `/api/atualizacao` e abre o diálogo do item Reconfigurar, o mesmo
   da engrenagem. Uma troca de versão sendo acompanhada tem a preferência. Recarregar a página não abre o
   diálogo de novo.
3. **Qualquer opção segue pelo caminho de hoje.** `--terminal`, `--sem-interface`, `--sem-link`,
   `--sem-assinatura` e `--pre` não chegam ao comando do executor, que é fixo (I11). Com qualquer uma,
   o comando para o painel e abre o assistente daqui, como antes. Não há opção nova.
4. **O caminho de hoje também vale quando a tela não serviria:** sem `DISPLAY` nem `WAYLAND_DISPLAY`,
   sem login, com o painel parado ou sem resposta, sem navegador, e quando a rota recusaria o clique
   (`outra-pasta` ou `sem-assinatura`, pela mesma `bloqueioDaReconfiguracao` da rota). O comando diz o
   motivo numa linha e segue. Sem essa conferência, o diálogo mandaria a pessoa rodar o comando no
   terminal, e o comando abriria o mesmo diálogo.
5. **A conferência do painel é uma só.** `motivoSemPainel` (`server/cli/servico.js`) serve ao
   `atualizar` e ao `reconfigurar`, com os mesmos textos.

## Consequências

- Scripts que rodam `dashboard reconfigurar` numa sessão com tela e com o painel no ar precisam de uma
  opção (`--terminal` ou `--sem-interface`) para não abrir o navegador.
- O bloqueio `rodando` (troca ou reconfiguração em andamento) continua só na tela: o diálogo mostra o
  motivo e pede para esperar.
- Os textos que mandam rodar `./dashboard reconfigurar` (sem login, Visão geral, novidades) continuam
  certos: nesses casos, o comando segue pelo caminho de hoje ou abre o fluxo da tela.

## Alternativas descartadas

- **Abrir o assistente direto, com o código do `--pela-tela`:** o terminal dispararia a parada da
  coleta sem o clique, e o código sairia do painel por outro caminho além da resposta do `POST`.
- **Uma opção nova para forçar o assistente sem o painel:** o fluxo da tela é o mesmo assistente, com o
  Cancelar e a volta garantida; quem não quer a tela tem o `--terminal`.
- **Só abrir o menu, sem o diálogo:** a pessoa já pediu para reconfigurar; o menu seria um clique a mais.
