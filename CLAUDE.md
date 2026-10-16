# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A referência técnica única do projeto é o AGENTS.md (regras obrigatórias, arquitetura,
configuração, script de coleta, formato da amostra, persistência, API, alertas,
verificação de segurança e como publicar uma versão). Ele é importado abaixo; não duplique
o conteúdo dele aqui.

@AGENTS.md

## Complementos para o Claude Code

- Escreva código, comentários, mensagens de commit e documentação em **PT-BR**, como o
  resto do repositório. Todo arquivo de código tem um cabeçalho dizendo o que faz, e cada
  bloco não trivial tem um comentário explicando o porquê.
- **Um teste só:** `node --test test/unit/config.test.js` ou, por nome,
  `node --test --test-name-pattern="trecho do nome" test/unit/config.test.js`.
- Os testes usam só `node:test`. A integração sobe o app com `createApp(deps)` de
  `server/index.js` (dependências injetáveis) e usa os auxiliares de `test-support/`.
- `test/unit/docs.test.js` também confere links e âncoras deste arquivo.
- O frontend não tem build: ES modules nativos em `public/js/` servidos como estão
  (`core/` estado, API, SSE, roteador por hash e o template `html`; `views/` as 8 telas;
  `charts/` o uPlot). Não introduza bundler nem dependência de runtime no backend.
- Para mexer em fixtures do parser, use `npm run capturar-amostra` (gera a versão anônima);
  nunca cole saída real do servidor nos testes.
- Removeu ou mudou código de segurança? Se o `scripts/mutacao-seguranca.mjs` disser que uma
  mutação está "desatualizada", ajuste o trecho dela no mesmo commit; nunca a apague para
  passar.
