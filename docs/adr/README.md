# Registros de decisão (ADRs)

Cada decisão relevante da V2 tem um registro curto: contexto, decisão e consequências.
Uma ADR aceita não é editada; se a decisão mudar, uma nova ADR a substitui.

| ADR | Título | Status |
|---|---|---|
| [0001](0001-repositorio-novo-com-o-historico-da-v1.md) | Repositório novo com o histórico da V1 | Aceita |
| [0002](0002-node-js-24-como-versao-minima.md) | Node.js 24 como versão mínima | Aceita |
| [0003](0003-http-com-node-http-sem-express.md) | HTTP com `node:http`, sem Express | Aceita |
| [0004](0004-uplot-para-os-graficos.md) | uPlot para os gráficos | Aceita |
| [0005](0005-historico-ndjson.md) | Histórico NDJSON: 72 h brutas + 90 dias agregados | Aceita |
| [0006](0006-motor-de-alertas.md) | Motor de alertas com chave estável, histerese e debounce | Aceita; a regra da disponibilidade foi substituída pela 0018 |
| [0007](0007-sessao-por-cookie-no-lugar-do-token-na-url.md) | Sessão por cookie no lugar do token na URL | Aceita |
| [0008](0008-ssh-restrito.md) | SSH restrito: usuário dedicado, comando forçado e sudo só para `smartctl -H` | Aceita |
| [0009](0009-design-aurora-cockpit-escuro-primeiro.md) | Design "Aurora + Cockpit", escuro primeiro | Aceita |
| [0010](0010-frontend-em-es-modules-nativos-sem-bundler.md) | Frontend em ES modules nativos, sem bundler | Aceita |
| [0011](0011-instalacao-assistente-no-navegador-tui-reserva.md) | Instalação: assistente no navegador + TUI reserva | Aceita |
| [0012](0012-distribuicao-por-git-clone-com-tag-assinada.md) | Distribuição por `git clone` com tag assinada | Aceita |
| [0013](0013-somente-linux-na-maquina-local.md) | Somente Linux na máquina local | Aceita |
| [0014](0014-verificacao-de-seguranca-continua.md) | Verificação de segurança contínua (local e no GitHub) | Aceita |
| [0015](0015-entregas-incrementais-e-consolidacao-em-versoes-minor.md) | Entregas incrementais e consolidação em versões MINOR | Aceita; os itens 3 e 4 foram substituídos pela 0023 |
| [0016](0016-fluxo-no-github-issue-primeiro.md) | Fluxo no GitHub: issue primeiro e as ferramentas gratuitas da plataforma | Aceita; o item 10 foi substituído pela 0017 |
| [0017](0017-superficie-publica-minima-no-github.md) | Superfície pública mínima no GitHub | Aceita |
| [0018](0018-disponibilidade-so-sobre-o-tempo-medido.md) | Disponibilidade só sobre o tempo medido | Aceita |
| [0019](0019-testes-no-navegador.md) | Testes no navegador no fluxo de trabalho | Aceita |
| [0020](0020-varios-computadores-no-mesmo-servidor.md) | Vários computadores no mesmo servidor: uma chave, uma linha e um sudoers por instalação | Aceita |
| [0021](0021-instalacao-em-servidor-so-com-chave.md) | Instalação em servidor que só aceita chave SSH | Aceita |
| [0022](0022-animacao-de-interface-so-com-css.md) | Animação de interface só com CSS e propriedades baratas | Aceita; os itens 3 e 4 foram substituídos pela 0024 |
| [0023](0023-versoes-por-milestone-sem-pre-versao-em-mudanca-pequena.md) | Versões por milestone, sem pré-versão em mudança pequena | Aceita |
| [0024](0024-hover-visivel-em-tudo-o-que-e-clicavel.md) | Hover visível em clicáveis, contêineres e gráficos | Aceita |
| [0025](0025-clique-e-estado-aguardando.md) | Clique e estado "aguardando" nos botões | Aceita |
| [0026](0026-entrada-de-tela-so-quando-ela-muda.md) | Entrada de tela só quando ela muda | Aceita |
