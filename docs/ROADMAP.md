# Roadmap

O roadmap 2.3.0–2.6.0 (issue #83) está concluído desde 06/11/2026. Não há roadmap aberto. O
próximo terá um arquivo próprio. O histórico de cada feature está no CHANGELOG e nas ADRs.

## Níveis de complexidade

| Nível | O que significa |
|---|---|
| **P** | Só CSS ou 1 módulo; sem rota nova; sem risco de segurança |
| **M** | Vários arquivos ou as 8 telas; instalação e desinstalação mudam; testes novos |
| **G** | Rota nova da API, processo novo, mudança no modelo de ameaças, ADR nova |
| **GG** | Novo modo de instalação, novo formato de distribuição, mudança de caminhos de dados |

## Features entregues

| Feature | Nível | Versão | ADR |
|---|---|---|---|
| Hover nos botões e hover mais visível | P, M | 2.2.3 e 2.2.4 | [0022](adr/0022-animacao-de-interface-so-com-css.md), [0024](adr/0024-hover-visivel-em-tudo-o-que-e-clicavel.md) |
| Clique, troca de tela e skeleton | P, M | 2.3.0 | [0022](adr/0022-animacao-de-interface-so-com-css.md), [0025](adr/0025-clique-e-estado-aguardando.md), [0026](adr/0026-entrada-de-tela-so-quando-ela-muda.md), [0027](adr/0027-esqueleto-no-formato-final-so-em-espera-longa.md) |
| Comando no PATH, autocomplete e docs ilustradas | P–M | 2.4.0 | [0028](adr/0028-comando-no-path-por-link-simbolico.md), [0029](adr/0029-autocomplete-estatico-do-bash.md) |
| Atualizar e reconfigurar pelo painel | G | 2.5.0 | [0030](adr/0030-atualizacao-pelo-painel.md) a [0039](adr/0039-dashboard-reconfigurar-abre-o-painel.md) |
| Pacote `.deb` e `/opt` | GG | 2.6.0 | [0042](adr/0042-modo-sistema-deb-e-executor-em-opt.md) a [0050](adr/0050-importar-desinstalar-e-purge-no-pacote.md) |
