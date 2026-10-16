# ADR 0015 — Entregas incrementais e consolidação em versões MINOR

- **Status:** Aceita
- **Data:** 16/10/2026
- **Complementa:** a [ADR 0012](0012-distribuicao-por-git-clone-com-tag-assinada.md), que
  continua valendo para a assinatura das tags

## Contexto

A 2.0.1 juntou 31 commits e dezenas de arquivos num PR só. Foi difícil de revisar e
arriscado de publicar: um defeito em qualquer parte segurava todo o resto. Os testes manuais
da 2.0.1 acharam defeitos pequenos e independentes entre si, que podem sair um de cada vez.

## Decisão

1. **Cada entrega é um PR pequeno:** uma mudança lógica, poucos arquivos e poucos commits,
   testada e revisada antes do merge.
2. **Correção vira PATCH** (2.0.2, 2.0.3…), cada uma com tag assinada e Release próprias.
3. **Funcionalidade vira pré-versão da próxima MINOR** (2.1.0-rc.1, 2.1.0-rc.2…). Pelo
   SemVer, uma 2.0.x não traz funcionalidade. As pré-versões só chegam a quem já está numa
   pré-versão ou usa `--pre`; quem não usa fica na estável.
4. **A MINOR estável consolida** as pré-versões quando todas estiverem prontas, testadas e
   revisadas. A seção dela no CHANGELOG resume o conjunto e aponta as seções de cada
   pré-versão, que continuam lá.
5. **Correção durante as pré-versões:** as PATCH que já estão na fila saem antes da 1ª
   pré-versão. Se depois disso aparecer uma correção urgente para a estável, ela sai de um
   ramo `manutencao/X.Y` criado a partir da última tag `X.Y.Z` e vira a PATCH seguinte. O
   `main` recebe a mesma correção por merge, e ela chega na pré-versão seguinte.
6. **Histórico preservado:** merge com merge commit, sem squash e sem reescrever o `main`.
   Toda versão intermediária mantém a sua tag e a sua Release.
7. **Documentação sem código** (como esta ADR) não gera versão sozinha: entra no
   `[Não publicado]` do CHANGELOG e sai nas notas da próxima versão.

Continuam valendo: SemVer, Conventional Commits em PT-BR, Keep a Changelog e as tags
assinadas da ADR 0012.

## Consequências

- Cada versão é pequena: fácil de revisar, de testar à mão e de desfazer com o
  `./dashboard atualizar` (que volta atrás se falhar).
- Há mais tags e Releases para publicar. O roteiro de publicação do AGENTS ("Publicar uma
  versão") vale para cada uma.
- Quem usa `--pre` recebe as funcionalidades antes e ajuda a testá-las; quem não usa só as
  recebe na MINOR estável.
- O ramo de manutenção nasce de uma tag que já está no `main`, então o merge de volta não
  duplica commits. Ele só existe enquanto houver pré-versões abertas e some depois da MINOR
  estável.
