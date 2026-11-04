# ADR 0040 — CI em jobs paralelos, com limite de tempo em cada etapa

- **Status:** Aceita
- **Data:** 04/11/2026

## Contexto

A ADR 0014 pôs no CI os 3 comandos da verificação (`npm run check`, `npm run test:e2e` e
`npm run seguranca`), num job só, um depois do outro. A ADR 0016 e a 0017 acrescentaram o
Dependency Review, o Scorecard, o Dependabot e as regras do GitHub. Cada push espera o job inteiro:
6 min 28 s no run #229 (04/11/2026), contra cerca de 5 min em 01/11. A mutação dos guardas foi a
etapa que mais cresceu: de 39 para 77 mutações e de 55 s para 137 s, uma rodada por vez.

O PR #127 mostrou outro problema: uma mutação fez um teste esperar 15 min de um temporizador real.
Nada avisou. A mutação não tinha limite por rodada, e o CI só tinha o teto de 40 min do job.

A auditoria da #128 (`docs/seguranca/2026-11-04-auditoria-ci.md`) mediu cada verificação e conferiu
o que cada uma pega que as outras não pegam.

## Decisão

1. **Todas as camadas da ADR 0014, 0016 e 0017 ficam.** Nenhuma verificação de segurança sai do CI.
   As que parecem repetidas (CodeQL, Semgrep e as regras estáticas; Gitleaks e o secret scanning; OSV,
   `npm audit`, Dependency Review e Dependabot) pegam coisas diferentes, e as mais caras não estão no
   caminho crítico. A análise de cada par está na auditoria.
2. **4 jobs ao mesmo tempo.** O workflow `verificação` roda `check`, `e2e`, `seguranca` e `mutacao` em
   4 máquinas. O `npm run seguranca` se divide em 2 jobs (`--pular=mutacao` e `--so=mutacao`), porque
   as ferramentas Docker e a mutação disputam os mesmos núcleos: juntas, numa máquina de 4 núcleos, o
   Semgrep foi de 20 s para mais de 100 s. Só o job da segurança baixa todo o histórico (o Gitleaks
   precisa dele). O tempo do push passa a ser o do job mais lento, não a soma.
3. **O check obrigatório continua `verificacao`.** Ele vira um job que espera os 4 (`needs`), roda
   sempre (`if: always()`) e só passa com os 4 em `success`. Assim o ruleset do `main` não muda, e um
   job pulado ou cancelado não vira verde por omissão.
4. **Limite de tempo em cada etapa**, com cerca de 3 vezes o tempo medido: `timeout-minutes` em toda
   etapa `run:` do workflow, um `limite` por etapa do `npm run seguranca` e um limite por rodada da
   mutação (`MUTACAO_LIMITE_S`, 60 s). A etapa ou rodada que passa do limite é derrubada e reprova com
   o nome dela.
5. **A mutação roda em paralelo**, até 4 rodadas ao mesmo tempo (`MUTACAO_PARALELO`), cada uma na sua
   cópia do repositório. No `npm run seguranca` sem opção (na máquina de quem desenvolve), ela corre ao
   lado das etapas Docker, que continuam uma por vez.

## Consequências

- O push no `main` e o PR esperam o job mais lento, e não os 4 somados. Os tempos antes e depois
  estão na auditoria e no PR da #128.
- Os 4 jobs gastam mais minutos de máquina somados (4 vezes o preparo, cerca de 15 s cada). O
  repositório é público e os minutos são gratuitos.
- Uma etapa presa reprova em minutos, com o nome dela. O teto do job continua como última defesa.
- O limite por rodada pode reprovar uma rodada lenta, mas correta, numa máquina muito carregada.
  Nesse caso, `MUTACAO_LIMITE_S` ou `MUTACAO_PARALELO` ajustam na hora; o padrão tem quase 6 vezes de
  folga sobre a rodada mais lenta medida.
- `test/seguranca/cadeia-suprimentos.test.js` confere os 3 comandos no CI (o `npm run seguranca` com
  as 2 metades), o limite de cada etapa, o agregador e os limites do `npm run seguranca` e da mutação.
