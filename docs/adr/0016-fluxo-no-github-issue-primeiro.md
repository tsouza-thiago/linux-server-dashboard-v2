# ADR 0016 — Fluxo no GitHub: issue primeiro e as ferramentas gratuitas da plataforma

- **Status:** Aceita
- **Data:** 19/10/2026
- **Complementa:** a [ADR 0014](0014-verificacao-de-seguranca-continua.md) (verificação
  contínua) e a [ADR 0015](0015-entregas-incrementais-e-consolidacao-em-versoes-minor.md)
  (entregas pequenas)

## Contexto

Até a 2.0.5, o plano de cada entrega ficava num arquivo de notas fora do repositório, e os
defeitos achados nos testes manuais só existiam num relatório local. Nada disso aparecia
para quem olhasse o projeto, nem ligava o defeito ao PR que o corrigiu e à versão que o
publicou. O repositório é público, e o GitHub oferece de graça issues, milestones, quadro de
projeto, discussões, regras de proteção, reporte privado de vulnerabilidade e verificações
automáticas que o projeto ainda não usava.

## Decisão

1. **Issue primeiro.** Toda mudança (bug, funcionalidade, tarefa, documentação) começa numa
   issue aberta pelo formulário do tipo dela. A issue diz o problema, a evidência e o que é
   "pronto". Exceções: os PRs do Dependabot (o PR já é a proposta) e o commit de versão, que
   vai no PR da última issue da versão.
2. **Rótulos** em 4 famílias: tipo (`tipo:bug`, `tipo:funcionalidade`, `tipo:tarefa`,
   `tipo:docs`, `tipo:seguranca`), área (coleta, armazenamento, telas, instalação, CI…),
   prioridade (alta, média, baixa) e semver (`semver:patch`, `semver:minor`,
   `semver:major`), que diz em que versão a mudança pode sair (ADR 0015).
3. **Milestone por versão** (2.0.6, 2.1.0…). A issue planejada vai para o milestone da
   versão em que deve sair, e a Release cita as issues fechadas.
4. **Um PR por issue** (ADR 0015), com o corpo pelo template e `Closes #N`. O merge só
   acontece com os checks obrigatórios verdes, por merge commit, depois do "pode publicar"
   do mantenedor. Com a autorização dada, o auto-merge do GitHub faz o merge quando o CI
   termina.
5. **Quadro no GitHub Projects** com as colunas A fazer, Em andamento, Em revisão e
   Publicado, que mostra o estado de cada issue.
6. **Discussions** para dúvidas e ideias ainda abertas. O que for decidido vira issue.
7. **Segurança:** vulnerabilidade é informada só pelo reporte privado (Security Advisories),
   nunca em issue pública. Os achados das ferramentas (CodeQL, Scorecard, Dependabot) ficam
   no code scanning e nos alertas do GitHub; a análise de cada descarte continua em
   `docs/seguranca/` (ADR 0014).
8. **Proteções no GitHub:** o `main` só muda por PR com os checks obrigatórios, sem
   force-push nem exclusão; as tags `v*` podem ser criadas, mas não movidas nem apagadas
   (o instalador confia nelas, ADR 0012). Squash e rebase ficam desligados (ADR 0015).
9. **Automação gratuita no CI:** Dependabot de versões (Actions e npm, mantendo os SHAs
   fixos), Dependency Review em todo PR e OpenSSF Scorecard.
10. **O repositório é a fonte única da documentação:** a Wiki fica desligada; AGENTS,
    README, TUTORIAL, SECURITY e as ADRs continuam sendo a referência.

## Consequências

- Cada defeito tem uma história pública e rastreável: issue → PR → versão → Release.
- Abrir uma issue antes de cada PR custa alguns minutos; em troca, a decisão fica registrada
  antes do código, como já pedia o planejamento das entregas.
- As regras de proteção valem também para o mantenedor: nada entra no `main` sem PR e CI
  verde, e uma tag publicada não pode ser trocada por engano.
- O quadro do Projects exige o escopo `project` no token do `gh`, liberado uma vez pelo
  mantenedor.
- Bug conhecido sem correção continua como teste `todo`, agora com o número da issue no
  nome do teste.
