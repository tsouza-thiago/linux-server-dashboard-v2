# F2 — Animação de clique nos botões

- **Nível:** P · **Versão:** 2.3.0-rc.2 · **Área:** telas · **Depende de:** F1 (tokens)
- **Decidido:** inclui o estado "aguardando" (spinner no botão enquanto a ação roda).

## Objetivo

Mostrar que o clique foi recebido e, nas ações que demoram, que a ação está rodando.

## Situação hoje

- Não há estilo `:active` nos botões.
- O foco do teclado usa `:focus-visible` (`base.css` e `.input` em `components.css`).
- Existe o `.spinner` (rotação de 0,9 s) e o toast com `level === 'busy'` em
  `public/js/main.js`, mas o botão em si não muda enquanto a ação roda.
- Ações que esperam a API: "coletar agora" (`/api/poll`), reconhecer e resolver alerta,
  criar e apagar anotação, exportar relatório, entrar (login).

## Decisão proposta

1. **Pressionar:** `:active` com `transform: scale(0.97)` em ~80 ms, e volta em
   `--t-fast`. Vale para `.btn`, `.icon-btn`, `.nav-item` e `.segmented button`.
2. **Aguardando:** um utilitário em `public/js/views/common.js` marca o botão com
   `aria-busy="true"` e `disabled` enquanto a promessa da API não termina. O CSS mostra
   o spinner pequeno no lugar do ícone, sem mudar a largura do botão.
3. **Fim da ação:** o resultado continua no toast de hoje. O botão volta ao normal.
4. Com movimento reduzido: sem `scale`; o spinner vira um ponto fixo (o `base.css` já
   corta a rotação).

### Alternativas descartadas

- **Efeito "ripple"** (onda do Material Design): precisa de JavaScript por clique e de
  elemento extra; é mais chamativo do que "leve e suave".

## Etapas

1. Estilo `:active` nos seletores do item 1.
2. Utilitário `withBusy(botão, promessa)` em `common.js`, com teste unitário.
3. Usar o utilitário nas ações da lista "Situação hoje".
4. Estilo `[aria-busy="true"]` do botão (spinner, cursor, sem mudar a largura).
5. Conferir que o duplo clique não dispara a ação 2 vezes (o `disabled` impede).
6. Itens novos em [testes-no-navegador.md](../testes-no-navegador.md) e bateria no
   navegador real.

## Testes

- Unitário: `withBusy` liga e desliga `aria-busy` e `disabled`, também quando a promessa
  falha.
- e2e: clicar em "coletar agora" duas vezes seguidas faz só 1 pedido a `/api/poll`.

## Riscos

- O spinner muda a largura do botão e a linha "pula". Mitigação: largura mínima fixa
  durante o estado aguardando.
