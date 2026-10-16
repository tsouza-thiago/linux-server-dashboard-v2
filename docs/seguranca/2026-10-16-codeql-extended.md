# Alertas do CodeQL na suíte *extended* — 16/10/2026

Durante a 2.0.1, o code scanning do GitHub passou da suíte `default` para a `extended`
(ADR 0014). A primeira análise do `main` (`v2.0.0`) com as regras novas abriu **5 alertas
"high"**. Nenhum permitia ler dados, executar comando ou entrar no painel. Os 5 foram
corrigidos na 2.0.1.

| # | Regra | Onde | Risco real | Decisão |
|---|---|---|---|---|
| 7 | `js/remote-property-injection` | `server/http/router.js` (`parseQuery`) | **Nenhum na prática**: o objeto da query não tem protótipo | **Endurecido**: a query recusa `__proto__`, `constructor` e `prototype` |
| 3–6 | `js/file-system-race` | 4 trechos de teste (`api-sessao`, `cli-servico`, `storage-migrate`) | **Nenhum**: código de teste, em pasta temporária | **Corrigido** no teste: modo e conteúdo lidos pelo mesmo descritor |

## Alerta 7: nome de parâmetro vindo da URL (`js/remote-property-injection`)

O `parseQuery` copiava cada parâmetro da query para um objeto, com o **nome** escolhido por
quem faz o pedido. Num objeto comum, `?__proto__[x]=1` poderia alterar o protótipo de todos
os objetos (prototype pollution, CWE-1321). O objeto já era criado com
`Object.create(null)`, sem protótipo. Nele, `__proto__` é uma chave comum, e a poluição não
acontecia.

**Mesmo assim, endurecido.** Se esse objeto um dia for copiado para um objeto comum
(`{ ...req.query }`, `Object.assign`), a proteção sumiria sem ninguém perceber. Por isso os
três nomes perigosos agora são recusados na entrada.

- **Teste:** `test/seguranca/payloads-owasp.test.js`, "a query nunca traz `__proto__`…".
- **Mutação:** "query aceitando `__proto__`/constructor" em
  `scripts/mutacao-seguranca.mjs`. Tirar o filtro faz o teste falhar.

## Alertas 3 a 6: conferir e depois ler (`js/file-system-race`)

Quatro testes conferiam a permissão de um arquivo com `statSync(caminho)` e depois liam o
conteúdo com `readFileSync(caminho)`. São dois acessos ao mesmo nome: entre eles, outro
processo poderia trocar o arquivo (TOCTOU, CWE-367). Num teste, isso não tem efeito
prático: a pasta é temporária e só o próprio teste a usa. A correção, porém, é simples.
O auxiliar `test-support/arquivos.js` (`lerComModo`) abre o arquivo uma vez e lê o modo e o
conteúdo pelo mesmo descritor.

O código de produção não tem esse padrão. As escritas do painel usam arquivo temporário +
`rename` (atômico) com modo 0600, conferido por `test/seguranca/invariantes-estaticas.test.js`.
