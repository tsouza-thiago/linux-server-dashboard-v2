# ADR 0041 — Mutação: a rodada presa repete 1 vez e diz qual teste prendeu

- **Status:** Aceita
- **Data:** 04/11/2026
- **Complementa:** a [ADR 0040](0040-ci-em-jobs-paralelos-com-limite-de-tempo.md) (decisão 4, limite de tempo por rodada da mutação)

## Contexto

A ADR 0040 deu a cada rodada da mutação um limite de 60 s: a rodada que passa dele reprova. No 1º push
no `main` depois dela (merge do PR #147), 1 das 77 rodadas passou do limite, e o job `mutacao`
reprovou. A mesma execução, repetida, passou. Na máquina do mantenedor, o travamento apareceu em 1 de
cerca de 10 execuções da mutação inteira (4 rodadas em paralelo), e nunca em 8 execuções seguidas da
mesma rodada sozinha. O log do CI também não dizia qual mutação nem qual teste travou: o detalhe
ficava só em `.seguranca/mutacao.txt`, que some com a máquina do CI.

## Decisão

1. **Cada teste tem limite** (`--test-timeout`), 10 s abaixo do limite da rodada. O teste que prende
   a rodada falha antes, e o nome dele sai do relatório (`testesPresos`). Um teste derrubado por tempo
   conta como rodada presa, nunca como mutação acusada: ele não falhou por uma asserção.
2. **A rodada presa repete 1 vez.** Se prender de novo, reprova com o nome da mutação, o do teste
   preso (ou o do último teste que terminou) e o comando para reproduzir. É o caso de um teste que
   espera um temporizador real (PR #127): ele prende sempre.
3. **Se passar na repetição**, o resultado da 2ª vez vale, e a linha `▲ travou 1 vez e passou na
   repetição` traz o nome do teste. O travamento raro vira issue, em vez de deixar o CI vermelho ao
   acaso.
4. **O log do CI mostra as linhas de falha da mutação** (sobreviveu, desatualizada, passou do limite,
   travou 1 vez), e não só a linha do total.

## Consequências

- Um travamento fixo continua reprovando, agora em até 2 vezes o limite da rodada (2 min no padrão).
- Um travamento raro não reprova, mas aparece no log com o nome do teste.
- `test/unit/mutacao-seguranca.test.js` confere que o teste derrubado pelo `--test-timeout` sai com o
  nome, e o que falhou por asserção, não.
