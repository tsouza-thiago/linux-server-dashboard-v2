# ADR 0025 — Clique e estado "aguardando" nos botões

- **Status:** Aceita
- **Data:** 30/10/2026
- **Complementa:** a [ADR 0024](0024-hover-visivel-em-tudo-o-que-e-clicavel.md) (hover)

## Contexto

Nenhum botão respondia ao clique, e as ações que esperam a API não mostravam que estavam rodando
(#85). O plano da F2 previa `scale(0.97)` também no menu e nos botões em grupo, mas ele é anterior
à ADR 0024, que tira o deslocamento desses elementos. O botão também já está 2 px acima no hover.

## Decisão

1. **Só o botão que sobe se move.** No `:active`, ele sai da altura do hover e fica em `--press`
   (`scale(0.97)`), em `--t-press` (80 ms), e volta em `--t-fast`. Assim o clique parece descer.
2. **Anel no lugar da sombra:** `inset 0 0 0 1px currentColor`. Com "reduzir movimento", o anel é
   o único sinal do botão, sem deslocamento.
3. **Grupo, `.event-list`, `.btn-link` e `.nav-item` não se movem:** o fundo passa a
   `--hover-bg-strong`. Desligado não responde.
4. **Faixa do clique:** no `:active`, a `::after` cobre o que o botão deixou ao descer e encolher.
   Sem ela, soltar o mouse na borda cai fora do botão e o clique se perde.
5. **Aguardando:** `withBusy(botão, promessa)` em `views/common.js` marca `aria-busy` e `disabled`
   até a promessa terminar e devolve o foco a quem estava nele. O CSS apaga o texto e põe o
   spinner por cima, sem mudar a largura. Com "reduzir movimento", ele vira um ponto fixo.
6. **Usam o `withBusy`:** coletar agora, reconhecer, resolver, salvar e remover anotação e entrar.
   Exportar **não** usa: os relatórios são links com `download`, e o navegador não avisa quando o
   arquivo termina. Esperar exigiria baixar tudo para a memória da aba.

## Consequências

- O custo em bytes continua sendo só o CSS.
- O teste `e2e: clique` confere o deslocamento, o que não se move, a borda e o duplo clique.
