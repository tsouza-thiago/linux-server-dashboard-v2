# ADR 0017 — Superfície pública mínima no GitHub

- **Status:** Aceita
- **Data:** 19/10/2026
- **Substitui:** o item 10 da [ADR 0016](0016-fluxo-no-github-issue-primeiro.md) (Wiki
  desligada)

## Contexto

Em 19/10/2026, uma auditoria olhou tudo o que o projeto deixa público: os arquivos, o
histórico, as tags e cada recurso do GitHub. Não achou segredo, mas achou superfície sem uso:
o repositório da V1 ainda público, ramos já mesclados, artefatos das Actions que qualquer
conta logada baixa, a política das Actions aceitando qualquer action, o CI de fork rodando
sem aprovação para quem já contribuiu, o quadro do Projects público e a Wiki sem regra de
edição. O mantenedor também decidiu manter a Wiki ligada, ao contrário do item 10 da ADR
0016. A instalação é `git clone` com tag assinada (ADR 0012): a assinatura só protege quem
clona o repositório certo, então uma página falsa com o endereço de um fork contornaria essa
proteção.

## Decisão

1. **Wiki ligada, editada só por colaboradores** ("Restrict editing to collaborators only").
   Ela só aponta para os documentos do repositório (README, TUTORIAL, AGENTS, SECURITY e
   ADRs), que continuam a referência e são conferidos pelo `test/unit/docs.test.js`.
2. **Actions:** o repositório só aceita actions do GitHub e a `ossf/scorecard-action`, todas
   presas por SHA completo. A regra vale na configuração do GitHub, além do teste
   `test/seguranca/cadeia-suprimentos.test.js` que confere os workflows.
3. **PR de fora:** o CI só roda com a aprovação do mantenedor, para qualquer colaborador
   externo.
4. **Retenção:** logs e artefatos das Actions ficam 30 dias.
5. **Ramos:** só o `main` e os ramos com PR aberto. O ramo é apagado depois do merge.
6. **Quadro do Projects privado.** As issues, os PRs, as Releases e as Discussions
   continuam públicos.
7. **Repositório da V1 privado.** Todo o histórico dele já está aqui, na tag `v1.0.0` (ADR
   0001), e o `--importar-v1` lê uma pasta local.
8. **O histórico não é reescrito.** O que ele já expõe (registrado na
   [linha de base](../seguranca/2026-10-16-linha-de-base.md)) é de baixa gravidade.
   Reescrevê-lo mudaria o SHA das tags assinadas e quebraria o `./dashboard atualizar` de
   toda instalação, e os commits antigos continuariam no GitHub pelas refs dos PRs (ADRs
   0001, 0012 e 0015).
9. **Documentos de decisão e de segurança continuam públicos** (ADRs, AGENTS, SECURITY,
   CHANGELOG, `docs/seguranca/`): eles não revelam nada que o código não revele, e o
   Scorecard, os testes e o fluxo dependem deles. Fixtures e exemplos usam valores
   sintéticos, nunca cópia do servidor real.

## Consequências

- Uma action nova num PR é recusada pelo GitHub antes de rodar, mesmo que o teste deixe
  passar.
- Cada PR externo espera um clique do mantenedor para rodar o CI.
- Log de CI com mais de 30 dias não existe mais. Para investigar uma falha, guarde o log na
  hora.
- Quem visita o repositório não vê o quadro. O andamento de cada issue aparece nela mesma e
  no milestone.
- Estas opções ficam na configuração do GitHub, fora do repositório. Para conferir:
  `gh api repos/tsouza-thiago/linux-server-dashboard-v2/actions/permissions` (e
  `…/selected-actions`, `…/fork-pr-contributor-approval`,
  `…/artifact-and-log-retention`). A opção da Wiki só aparece em Settings → Features.
