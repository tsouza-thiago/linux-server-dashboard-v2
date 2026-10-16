# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A referência técnica única do projeto é o AGENTS.md (regras obrigatórias, arquitetura,
configuração, script de coleta, formato da amostra, persistência, API e alertas). Ele é
importado abaixo; não duplique o conteúdo dele aqui.

@AGENTS.md

## Complementos para o Claude Code

- Escreva código, comentários, mensagens de commit e documentação em **PT-BR**, como o
  resto do repositório.
- **Antes de cada commit:** `npm run check` (`scripts/check.mjs`): sintaxe JS e shell,
  `.env`/`data/` fora do git, testes com cobertura e `npm audit`. Para no primeiro erro.
- **Um teste só:** `node --test test/unit/config.test.js` ou, por nome,
  `node --test --test-name-pattern="trecho do nome" test/unit/config.test.js`.
- Os testes usam só `node:test`. A integração sobe o app com `createApp(deps)` de
  `server/index.js` (dependências injetáveis) e usa os auxiliares de `test-support/`
  (HTTP/SSE, `sshd` real, instalação falsa). O e2e pula sozinho sem Chromium.
- `test/unit/docs.test.js` confere a documentação contra o código: links e âncoras de
  **todo** `.md` do repositório (inclusive este), arquivos citados, subcomandos e opções do
  `./dashboard`, variáveis e rotas. Ao mudar comando, variável, rota ou arquivo, atualize o
  AGENTS.md no mesmo commit, ou o teste falha.
- O frontend não tem build: ES modules nativos em `public/js/` servidos como estão
  (`core/` estado, API, SSE, roteador por hash e o template `html`; `views/` as 8 telas;
  `charts/` o uPlot). Não introduza bundler nem dependência de runtime no backend.
- Para mexer em fixtures do parser, use `npm run capturar-amostra` (gera a versão anônima);
  nunca cole saída real do servidor nos testes.
