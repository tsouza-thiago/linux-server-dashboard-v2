# Verificação de segurança em camadas

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

As camadas são redundantes de propósito. As decisões estão nas ADRs
[0014](../adr/0014-verificacao-de-seguranca-continua.md),
[0016](../adr/0016-fluxo-no-github-issue-primeiro.md),
[0017](../adr/0017-superficie-publica-minima-no-github.md),
[0040](../adr/0040-ci-em-jobs-paralelos-com-limite-de-tempo.md),
[0041](../adr/0041-mutacao-repete-a-rodada-presa.md),
[0049](../adr/0049-pacote-deb-reprodutivel-e-primeira-instalacao.md) e
[0054](../adr/0054-zap-sem-rede-durante-a-varredura.md).

1. `test/seguranca/` roda em todo `npm run check`: regras estáticas (`invariantes-estaticas`), matriz de ataque
   gerada das rotas reais (`superficie-ataque`), corpus OWASP (`payloads-owasp`), segredos e OSINT no que vai para o
   repositório público (`segredos-osint`) e cadeia de suprimentos, com o hash dourado do script de coleta
   (`cadeia-suprimentos`).
2. `npm run seguranca` (`scripts/seguranca.mjs`): Semgrep, Gitleaks (arquivos, sem `.runtime/`, e histórico),
   ShellCheck, OSV-Scanner e OWASP ZAP (ataque ativo e autenticado a um painel de teste), em imagens Docker presas
   por digest; e a mutação dos guardas (`scripts/mutacao-seguranca.mjs`): cada proteção é quebrada numa cópia e
   algum teste precisa acusar. Achado médio ou alto só passa com análise em `docs/seguranca/excecoes.json`. Só
   algumas etapas: `--so=semgrep,shell` ou `--pular=zap` (etapas: `semgrep`, `segredos`, `shell`, `osv`, `zap`,
   `mutacao`; nome errado sai com erro). A mutação corre ao lado das etapas Docker, com até 4 rodadas em paralelo
   (ADR 0040). Cada etapa e cada rodada (60 s) têm limite de tempo; a rodada presa repete 1 vez e, se prender de
   novo, reprova com o nome da mutação e do teste (ADR 0041). `MUTACAO_PARALELO` e `MUTACAO_LIMITE_S` ajustam os 2.
   A imagem de cada etapa Docker é baixada antes, com limite próprio (150 s) e 1 repetição, fora do limite da
   etapa (ADR 0054). O ZAP roda sem rede (`-silent`): valem os add-ons da imagem e o `pscanrulesBeta` de URL e
   SHA-256 fixos (`ZAP_BETA`, cache em `.seguranca/cache/`); cada regra beta precisa aparecer na saída. Partida e
   varredura passiva têm até 1 min cada, a ativa até 2 min. A saída do ZAP, com a hora de cada fase, fica em
   `.seguranca/zap.log`; se a etapa falhar, as últimas linhas vão para o log.
3. CI no GitHub (ADRs 0014 e 0040, `.github/workflows/seguranca.yml`), a cada push no `main` e a cada PR:
   `npm run check`, `npm run test:e2e` com `E2E_OBRIGATORIO=1` (sem navegador, falha em vez de pular) e
   `npm run seguranca`, em 4 jobs ao mesmo tempo (a mutação num só dela). O job `verificacao` (o check obrigatório)
   só passa com os 4 verdes; toda etapa tem `timeout-minutes`. O job `check` também gera o `.deb` 2 vezes e compara
   (ADR 0049); `.github/workflows/pacote.yml` confere o `.deb` de cada Release contra o `SHA256SUMS` assinado.
   Decisões e tempos: `docs/seguranca/2026-11-04-auditoria-ci.md`. Actions presas por SHA, permissão só de leitura,
   sem segredos.
4. Ferramentas do GitHub (ADRs 0016 e 0017): Dependency Review em todo PR (reprova vulnerabilidade moderada ou pior
   e licença incompatível), OpenSSF Scorecard (`scorecard.yml`; alertas sem correção em
   `docs/seguranca/2026-10-19-scorecard.md`), Dependabot semanal com 14 dias de espera, secret scanning com push
   protection. Só actions do GitHub e a `ossf/scorecard-action`, presas por SHA; PR de fora só roda o CI com
   aprovação; o PR só entra no `main` atualizado.
