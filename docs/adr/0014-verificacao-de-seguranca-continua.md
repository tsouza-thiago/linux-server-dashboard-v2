# ADR 0014 — Verificação de segurança contínua (local e no GitHub)

- **Status:** Aceita
- **Data:** 16/10/2026
- **Substitui:** a parte "CI fora, por ora" da decisão D9 do plano da V2 (tag `v2.0.0`)

## Contexto

Até a 2.0.0, a verificação dependia de quem fazia o commit lembrar de rodar o
`npm run check`. No GitHub só rodava o CodeQL padrão. A 2.0.1 remove código legado, e uma
remoção descuidada pode tirar uma proteção sem ninguém notar. O projeto segue
"security by design": cada proteção precisa de um teste que acuse a sua falta, e essa
conferência precisa rodar sempre, não só quando alguém lembra.

## Decisão

A verificação de segurança tem camadas redundantes, e todas rodam no computador e no
GitHub:

1. **Testes nativos em `test/seguranca/`**, dentro do `npm run check`: regras estáticas,
   matriz de ataque gerada das rotas, payloads do OWASP, segredos e OSINT, e cadeia de
   suprimentos.
2. **`npm run seguranca`**: Semgrep (regras OWASP), Gitleaks, ShellCheck, OSV-Scanner e
   OWASP ZAP, em imagens Docker presas por digest, mais a mutação dos guardas. Achado médio
   ou alto só passa com análise em `docs/seguranca/excecoes.json`.
3. **CI no GitHub** (`.github/workflows/seguranca.yml`), a cada push no `main` e a cada PR:
   `npm run check`, `npm run test:e2e` (sem navegador, falha) e `npm run seguranca`. As
   actions ficam presas por SHA, com permissão só de leitura e sem segredos.
4. **CodeQL** do GitHub, como antes.

Ferramentas externas e o CI só existem no desenvolvimento: o painel continua sem
dependência de runtime e sem nada instalado no servidor.

## Consequências

- Todo PR mostra se a segurança continua de pé, antes do merge.
- Rodar `npm run seguranca` em casa exige Docker. Sem ele, as ferramentas externas são
  puladas e a mutação roda assim mesmo. No CI, a falta de Docker é erro.
- Atualizar uma ferramenta ou uma action é um commit consciente: muda o digest/SHA, e
  `test/seguranca/cadeia-suprimentos.test.js` confere que nada ficou solto.
