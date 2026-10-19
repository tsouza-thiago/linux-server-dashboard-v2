# Alertas do OpenSSF Scorecard — 19/10/2026

O Scorecard (ADR 0016) roda a cada push no `main` e toda segunda-feira. O resultado vai
para o code scanning. Em 19/10/2026, o mantenedor revisou os 7 alertas abertos. **Nenhum é
vulnerabilidade de código:** o Scorecard avalia as práticas do projeto. A gravidade que o
GitHub mostra ("high", "medium") é a escala padrão do Scorecard, não um risco medido aqui.

## Resumo

| # | Verificação | Nota | Decisão |
|---|---|---|---|
| 14, 15 | Pinned-Dependencies | 5 | **Corrigido** (#35): imagens do e2e de instalação presas por digest |
| 13 | Branch-Protection | 3 | **Em parte corrigido** (#36): o PR precisa estar atualizado com o `main`. O resto é descartado |
| 17 | Code-Review | 0 | **Descartado** (won't fix): limite de projeto com 1 mantenedor |
| 16 | Fuzzing | 0 | **Descartado** (won't fix): o fuzz próprio já existe, e o Scorecard não o reconhece |
| 19 | CII-Best-Practices | 0 | **Descartado** (won't fix) por enquanto: cadastro externo, sem efeito na segurança do painel |
| 18 | Maintained | 0 | **Fica aberto**: fecha sozinho quando o repositório passar de 90 dias |

## Pinned-Dependencies (#14, #15)

Os 2 Dockerfiles de `scripts/e2e-instalacao/` usavam `debian:12`, e o `rodar.sh` usava
`debian:12` e `ubuntu:24.04`, todos sem digest. Uma tag pode passar a apontar para outra
imagem; um digest não muda. O risco real era baixo: essas imagens só rodam na máquina de
quem desenvolve, nunca no CI nem na instalação. Mesmo assim, as ferramentas do
`npm run seguranca` já usavam digest (ADR 0014), e o e2e passou a seguir a mesma regra.
`test/seguranca/cadeia-suprimentos.test.js` confere isso.

## Branch-Protection (#13)

O Scorecard pede 5 itens no `main`:

1. **Ramo atualizado antes do merge** ("up-to-date branches"): **ligado** em 19/10/2026. Agora
   o PR precisa ter o `main` mais novo e passar no CI de novo. Sem isso, 2 PRs verdes
   separados podiam ir juntos para o `main` sem nunca terem rodado juntos no CI.
2. **Aprovação obrigatória** (pelo menos 1 aprovador).
3. **Revisão do CODEOWNERS obrigatória.**
4. **Descartar aprovação antiga quando chega commit novo** ("stale review dismissal").
5. **Aprovação depois do último push** ("last push approval").

Os itens 2 a 5 dependem de uma aprovação no GitHub. O projeto tem 1 mantenedor, e o GitHub
não deixa ninguém aprovar o próprio PR. Ligar esses itens bloquearia todo merge, ou exigiria
um bypass no ruleset, que tiraria a proteção que ele dá. A revisão existe: nenhum merge
acontece sem o "pode publicar" do mantenedor (ADR 0016, item 4). Ela só não é registrada como
aprovação do GitHub.

**Alternativa, se o projeto ganhar um 2º mantenedor:** ligar os itens 2 a 5 e reabrir este
alerta.

## Code-Review (#17)

"0/11 changesets aprovados": tem a mesma causa dos itens 2 a 5 acima. Cada PR passa pelo CI
obrigatório (`verificacao`, `revisao` e CodeQL) e pelo "pode publicar" do mantenedor, mas
nenhum tem a aprovação formal que o Scorecard conta. Alternativa: a mesma do 2º mantenedor.

## Fuzzing (#16)

O Scorecard só reconhece integrações específicas: OSS-Fuzz, ClusterFuzzLite e o fuzz nativo
de algumas linguagens e bibliotecas, como o `fast-check` em JavaScript. O projeto já faz
testes de propriedade próprios, sem biblioteca:

- `test/unit/collector-fuzz.test.js`: gerador pseudoaleatório com semente fixa (falha
  reproduzível) e milhares de entradas por propriedade no parser, no builder do script, nas
  taxas e no `sanitizeToken`;
- `test/seguranca/payloads-owasp.test.js`: corpus de ataques OWASP contra as rotas reais.

Trazer o `fast-check` só para o Scorecard reconhecer o fuzz contraria a regra de mínimo de
dependências (só o `playwright-core` em desenvolvimento) e não acrescenta cobertura. Se um dia
o fuzz precisar de encolhimento (shrinking) ou de geradores mais ricos, essa troca pode ser
reavaliada numa ADR.

## CII-Best-Practices (#19)

O selo da OpenSSF Best Practices (bestpractices.dev) é um questionário respondido pelo
mantenedor num site externo, com login. Ele resume práticas que o projeto já documenta
(SECURITY, CONTRIBUTING, testes, CI, versões assinadas), mas não muda a segurança do
painel. Fica descartado por enquanto. Se o mantenedor decidir cadastrar o projeto, o alerta
fecha sozinho quando o selo existir.

## Maintained (#18)

O repositório foi criado em 07/10/2026, e o Scorecard dá nota 0 a todo projeto com menos de
90 dias. Com commits e issues em dia, o alerta fecha sozinho a partir de 05/01/2027. Não há
nada a fazer.

## Como conferir

- Alertas abertos: `gh api 'repos/tsouza-thiago/linux-server-dashboard-v2/code-scanning/alerts?state=open&tool_name=Scorecard'`.
- Ruleset do `main`: `gh api repos/tsouza-thiago/linux-server-dashboard-v2/rulesets/25413020`
  (`strict_required_status_checks_policy: true`).
