# Como contribuir

Obrigado pelo interesse no Server Dashboard. A referência técnica única do projeto é o
[AGENTS.md](AGENTS.md): regras obrigatórias, arquitetura, comandos e como publicar uma
versão. Este arquivo só resume o caminho de uma contribuição.

## Antes de começar

- **Vulnerabilidade** não vai em issue pública: siga o [SECURITY.md](SECURITY.md).
- **Dúvida ou ideia em aberto:** use as Discussions do repositório.
- **Bug, funcionalidade ou tarefa:** abra uma issue pelo formulário do tipo. Sem dado
  real: nada de `.env`, token, IP ou nome da sua rede.

As regras do projeto valem para toda mudança: 1 SSH por coleta, servidor só leitura, nada
instalado no servidor, dado ausente é `null` e o painel escuta só em `127.0.0.1`.

## Caminho de uma mudança

Ele segue as ADRs [0015](docs/adr/0015-entregas-incrementais-e-consolidacao-em-versoes-minor.md)
(entregas pequenas) e [0016](docs/adr/0016-fluxo-no-github-issue-primeiro.md) (issue
primeiro):

1. **Issue** com rótulos e o milestone da versão. Correção sai como PATCH; funcionalidade,
   na versão do milestone (ADR 0023). Só mudança grande usa pré-versão.
2. **Ramo** a partir do `main`, um por issue.
3. **Teste que falha** antes da mudança, depois a mudança. Os testes usam só `node:test`.
4. **`npm run check`** antes de cada commit (Node 24). Conforme a mudança, rode também
   `npm run test:e2e`, `npm run soak` ou `npm run seguranca` (veja o AGENTS). Mudou a tela?
   Confira no navegador, num painel de teste (`npm run painel-teste`), pelo roteiro de
   [docs/testes-no-navegador.md](docs/testes-no-navegador.md).
5. **Commits** em Conventional Commits, em PT-BR, com o CHANGELOG `[Não publicado]` e a
   documentação no mesmo commit.
6. **PR** pelo template, com `Closes #N`. O merge acontece com o CI verde, por merge
   commit, depois da revisão do mantenedor. As versões são tags assinadas (ADR 0012).
