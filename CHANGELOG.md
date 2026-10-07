# Changelog

Todas as mudanças relevantes deste projeto ficam registradas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto
usa [Versionamento Semântico](https://semver.org/lang/pt-BR/). A V2 é publicada em
pré-versões `2.0.0-alpha.N` (uma por fase do plano), depois `beta`, `rc` e `2.0.0`.

## [Não publicado]

### Adicionado
- Plano da V2 (`docs/PLANO_V2.md`) e registros de decisão `docs/adr/0001`–`0013`.
- Este changelog.
- `npm run check`: sintaxe JS e shell, `.env`/`data/` fora do git, testes com cobertura e
  `npm audit` — obrigatório antes de cada commit. `npm run test:unit` e `npm run test:integration`.

### Segurança
- Dependências transitivas do Express atualizadas (`npm audit fix`): `proxy-addr` 2.0.8,
  `qs` 6.16.0, `body-parser` 1.20.8, `express` 4.22.3 — zera os 4 alertas (1 crítico, 3 moderados).
  O Express sai de vez na F4 (ADR 0003).

### Alterado
- Suíte reorganizada em `test/unit` (171) e `test/integration` (25).
- Exemplos e testes usam só IPs de documentação (RFC 5737).

## [1.0.0] — 2026-09-13

Última versão da V1, importada sem alterações como base da V2
(repositório de origem: `tsouza-thiago/linux-server-dashboard`).

### Funcionalidades
- Coleta por 1 comando SSH por minuto, somente leitura, sem instalar nada no servidor.
- Painel local (127.0.0.1) com 9 telas, temas claro/escuro, gráficos com zoom e anotações.
- Alertas com ciclo de vida (novo → reconhecido → resolvido) e auto-resolução.
- Exportação CSV (protegida contra fórmulas) e JSON.
- Instalador com assistente SSH, `DASH_TOKEN` automático e serviço systemd de usuário.
- Proteções: Host check, CSRF com cookie, CSP, rate limit, token timing-safe, sanitização
  anti-injeção do comando SSH, permissões 0700/0600, erros sem stack trace.

### Problemas conhecidos
Documentados no plano da V2 (seção 2.2, B1–B12), entre eles: alerta SMART falso sem root,
rede zerada com contadores grandes, alerta duplicado a cada coleta e reescrita completa do
histórico a cada minuto.

[Não publicado]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tsouza-thiago/linux-server-dashboard-v2/releases/tag/v1.0.0
