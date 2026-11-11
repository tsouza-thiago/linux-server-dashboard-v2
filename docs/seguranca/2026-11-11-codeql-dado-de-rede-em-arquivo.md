# Alertas 29 e 30 do CodeQL: corrida e dado de rede em arquivo — 11/11/2026

| # | Regra | Onde | Risco real | Decisão |
|---|---|---|---|---|
| 29 | `js/file-system-race` | `scripts/seguranca.mjs`, `arquivoFixado` | Baixo: cache do dono, em pasta 0700 | **Corrigido**: lê direto, sem `existsSync` antes |
| 30 | `js/http-to-file-access` | `scripts/seguranca.mjs`, `arquivoFixado` | **Nenhum**: só grava o que bate com o SHA-256 fixo | **Falso positivo**, descartado; escrita travada por teste |

## O que o CodeQL viu

O PR da #202 (ADR 0054) fez o `npm run seguranca` baixar as regras passivas beta do ZAP
(`pscanrulesBeta-beta-50.zap`) e guardá-las em `.seguranca/cache/`. A função `arquivoFixado`:

1. conferia se o arquivo do cache existia (`existsSync`) e depois o lia: entre as 2 chamadas, o
   arquivo poderia mudar (alerta 29);
2. gravava em disco o corpo de uma resposta da rede (alerta 30): é o caminho de quem grava um
   arquivo que um atacante escolheu (CWE-912).

## Alerta 29: corrigido

A função lê o arquivo direto, num `try`. Faltar é só um erro de leitura, e o conteúdo lido é o
mesmo que passa pela conferência do hash. Não há mais conferência separada da leitura.

## Alerta 30: por que não é um problema

- **O conteúdo é fixo.** O buffer só é gravado se o SHA-256 dele for igual ao escrito no código
  (`ZAP_BETA.sha256`). Qualquer outro conteúdo, venha de onde vier, é descartado. É a mesma garantia
  das imagens Docker presas por digest.
- **O destino é fixo.** O caminho é `.seguranca/cache/` + o nome escrito no código, numa pasta 0700,
  com o arquivo em 0600. Nada da resposta entra no caminho.
- **Não é código do painel.** `scripts/seguranca.mjs` roda só na máquina de quem desenvolve e no CI.
  O painel continua sem nenhum pedido de rede para fora além da procura de versão (ADR 0030).

## O que garante que continue assim

O teste "A03: o ZAP roda sem rede e o add-on beta é preso por SHA-256", em
`test/seguranca/cadeia-suprimentos.test.js`, exige que `arquivoFixado` tenha uma escrita só, logo
depois de `if (res.ok && confere(buf))`, que o hash seja comparado ao fixo e que não haja `existsSync`.
Conferido na forma errada: com `if (res.ok)`, o teste falha.
