# ADR 0023 — Versões por milestone, sem pré-versão em mudança pequena

- **Status:** Aceita
- **Data:** 30/10/2026
- **Substitui:** os itens 3 e 4 da
  [ADR 0015](0015-entregas-incrementais-e-consolidacao-em-versoes-minor.md) (pré-versão para
  toda funcionalidade e consolidação na MINOR)

## Contexto

Pela ADR 0015, toda funcionalidade saía como pré-versão, e a MINOR estável só repetia o que as
pré-versões já traziam. A F1 (#84) mostrou o custo: uma animação de CSS exigiu a 2.3.0-rc.1, e
quem usa a estável não a recebeu. Em 30/10/2026 o mantenedor decidiu que isso não faz sentido
para mudança pequena.

## Decisão

1. **Mudança pequena não usa pré-versão.** Ela sai direto numa versão estável.
2. **As versões sobem conforme os milestones.** O milestone diz o que entra em cada versão.
3. **A pré-versão fica para mudança grande** (níveis G e GG do `docs/ROADMAP.md`), quando vale
   testar antes de chegar a todos. O suporte a `--pre` continua.
4. **Mudança pequena pode sair numa PATCH**, se é o milestone aberto mais próximo, mesmo sendo
   funcionalidade. É um desvio consciente do SemVer, decidido pelo mantenedor para entregas
   sem risco de quebra.
5. A F1 sai na 2.2.3, estável e Latest, com o mesmo código da 2.3.0-rc.1. Essa pré-versão
   continua publicada.

Continuam valendo da ADR 0015: PR pequeno, PATCH para correção, ramo `manutencao/X.Y`,
histórico preservado e documentação sem código fora de versão própria. As tags assinadas da
ADR 0012 também continuam valendo.

## Consequências

- Cada entrega pequena chega logo a quem usa a versão estável.
- A estável deixa de ter a etapa de teste real que a pré-versão dava. A bateria no navegador
  (ADR 0019) continua obrigatória antes de cada versão.
- Quem instalou a 2.3.0-rc.1 fica nela até sair a 2.3.0: pelo SemVer, ela é mais nova que a
  2.2.3.
- As features 2, 3 e 6 continuam no milestone 2.3.0 e saem juntas, sem pré-versão.
