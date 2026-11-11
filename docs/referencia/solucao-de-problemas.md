# Solução de problemas (para quem desenvolve)

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

Comece pelo `./dashboard diagnosticar` (o TUTORIAL cobre quem usa). Coleta lenta ou parada: `data/dashboard.log` e
`journalctl --user -u server-dashboard`. Histórico vazio: `data/history/` e as permissões de `data/` (veio da V1?
`npm run migrar-v1 -- --verificar`). Suíte vermelha só na sua máquina: rode num clone sem `.env` e com o Node 24. e2e
pulado: instale o `playwright-core` (`npm ci`) e um Chromium, ou aponte um com `CHROMIUM=<caminho>`.
