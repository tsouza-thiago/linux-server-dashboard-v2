# Roadmap — versões 2.3.0 a 2.6.0

- **Situação:** em implementação. Feita: F1 (ADR 0022). As outras seguem em planejamento.
- **Data:** 26/10/2026.
- **Issue do roadmap:** #83. Milestones 2.3.0 a 2.6.0.
- **Regra:** cada feature tem um documento em [`docs/roadmap/`](roadmap/) com o objetivo, a
  situação de hoje no código, a decisão, as etapas pequenas, os testes e os riscos. A
  decisão vira ADR só quando a feature for aprovada para implementar.

## Classificação por complexidade

Da mais simples para a mais complexa. A complexidade leva em conta os arquivos tocados, o
risco de segurança, os testes novos e o que muda para quem já usa o painel.

| Nível | O que significa |
|---|---|
| **P** | Só CSS ou 1 módulo; sem rota nova; sem risco de segurança |
| **M** | Vários arquivos ou as 8 telas; instalação e desinstalação mudam; testes novos |
| **G** | Rota nova da API, processo novo, mudança no modelo de ameaças, ADR nova |
| **GG** | Novo modo de instalação, novo formato de distribuição, mudança de caminhos de dados |

| # | Feature | Nível | Versão | Depende de | Issue | Documento |
|---|---|---|---|---|---|---|
| 1 | Animação ao passar o mouse nos botões (hover) | P | 2.3.0 | — | #84 | [f1-hover.md](roadmap/f1-hover.md) |
| 2 | Animação de clique nos botões | P | 2.3.0 | 1 (mesmos tokens) | #85 | [f2-clique.md](roadmap/f2-clique.md) |
| 3 | Transição suave na troca de telas | P | 2.3.0 | — | #86 | [f3-troca-de-tela.md](roadmap/f3-troca-de-tela.md) |
| 4 | Link simbólico: `dashboard` sem `./` e fora da pasta | P–M | 2.4.0 | — | #87 | [f4-link-simbolico.md](roadmap/f4-link-simbolico.md) |
| 5 | Autocomplete com Tab (bash) | M | 2.4.0 | 4 (para valer fora da pasta) | #88 | [f5-autocomplete.md](roadmap/f5-autocomplete.md) |
| 6 | Skeleton em tudo o que carrega | M | 2.3.0 | 3 (a entrada do conteúdo) | #89 | [f6-skeleton.md](roadmap/f6-skeleton.md) |
| 7 | Atualização pelo painel, com aviso e log | G | 2.5.0 | — | #90 | [f7-atualizacao-pelo-painel.md](roadmap/f7-atualizacao-pelo-painel.md) |
| 8 | Reconfigurar pelo painel | G | 2.5.0 | 7 (menu e executor) | #91 | [f8-reconfigurar-pela-tela.md](roadmap/f8-reconfigurar-pela-tela.md) |
| 9 | Instalação em `/opt` por pacote `.deb` | GG | 2.6.0 | 4, 5, 7 e 8 | #92 | [f9-deb-e-opt.md](roadmap/f9-deb-e-opt.md) |

A F8 é menos arriscada que a F7 (reaproveita o assistente e não acessa a internet), mas
vem depois dela porque usa o menu e o executor que a F7 cria.

## Versões (ADR 0015)

Cada feature sai num PR próprio, como pré-versão (`-rc.N`) da MINOR do tema. A MINOR estável
consolida as pré-versões. As PATCH da fila (hoje a 2.2.3) saem antes da 1ª pré-versão.

| Versão | Tema | Pré-versões previstas |
|---|---|---|
| 2.3.0 | Interface mais suave | rc.1 hover · rc.2 clique · rc.3 troca de tela · rc.4 skeleton |
| 2.4.0 | Comando no PATH | rc.1 link simbólico · rc.2 autocomplete |
| 2.5.0 | Manutenção pelo painel | atualizar: uma pré-versão por grupo de etapas (detecção, aviso, execução); depois reconfigurar |
| 2.6.0 | Pacote `.deb` e `/opt` | uma pré-versão por grupo de etapas (modo sistema, executor, pacote) |

Nenhuma destas versões quebra quem instalou por `git clone`: elas são MINOR. Se a F8 exigir
mudar o formato de `data/` para quem já usa, ela vira MAJOR (3.0.0) e este roadmap muda.

## Regras que valem para todas as features

1. As invariantes I1–I10 do [AGENTS.md](../AGENTS.md) continuam valendo. Nenhuma feature
   abre SSH para o servidor nem grava nada nele.
2. **Orçamento da página inicial:** 300 KB transferidos; hoje são 292 KB. Sobram ~8 KB
   para as features 2, 3 e 6 juntas. Cada PR de tela mede o tamanho no
   `test/e2e/telas.test.js`.
3. **CSP sem `'unsafe-inline'`:** animação só por CSS em arquivo ou pelo CSSOM. Nunca
   `style="…"` no HTML (ADR 0010).
4. **Movimento reduzido:** o `base.css` já zera durações com `prefers-reduced-motion`.
   Toda animação nova é conferida com essa opção ligada.
5. **Sem bundler e sem dependência de runtime** no backend (ADR 0003 e 0010).
6. **Testes no navegador** (ADR 0019): toda mudança de tela passa pela bateria de
   [testes-no-navegador.md](testes-no-navegador.md), que ganha os itens novos no mesmo PR.
7. **Documentação junto com o código:** README, TUTORIAL e AGENTS mudam no mesmo PR que a
   pessoa usuária ou quem desenvolve vê a mudança.
8. **Manutenção: a web é o caminho padrão.** Atualizar e reconfigurar são feitos pela
   interface por padrão, inclusive quando o comando é digitado no terminal. O modo
   terminal continua disponível (`--terminal`) e é usado sozinho quando não há tela
   gráfica. A documentação apresenta a web primeiro.

## Decisões tomadas com o mantenedor (26/10/2026)

| Tema | Decisão |
|---|---|
| Nome do comando no PATH | `dashboard` |
| Shells do autocomplete | só bash |
| Procurar versão nova | 1 vez por dia, sempre ligado (sem opção de desligar) |
| Quem dispara a atualização pela tela | qualquer sessão logada |
| Reconfigurar | também pela interface, no mesmo modelo do atualizar (F8) |
| Caminho padrão da manutenção | a web; o terminal continua com `--terminal` |
| `dashboard atualizar` no terminal | abre a tela de atualização do painel; `--terminal` faz como hoje |
| Lugar dos botões | menu de manutenção no topo (engrenagem): Atualizar e Reconfigurar |
| Formato de pacote | só `.deb` (Flatpak fica fora; motivo na F9) |
| Atualização no modo `.deb` | o próprio painel cuida, sem `apt`; desenho híbrido aprovado: usuário de sistema sem privilégio grava, a pessoa só pede pelo polkit (F9) |
| F1 | "hook" é *hover* |
| F2 | inclui o estado "aguardando" (spinner no botão) |
| F4 | sem `~/.local/bin` no PATH: pergunta e, com o sim, acrescenta um bloco marcado no arquivo de login |
| F7 e F8 | painel sem login: aviso aparece, botões desligados, mostra o comando do terminal |
| F7 | versão que muda o script de coleta: marcador "Exige reconfigurar" no CHANGELOG, aviso antes |
| F5 | sem o `bash-completion`: mesma regra da F4, no `~/.bashrc` |
| F9 | Node baixado pelo executor (SHA-256 fixado); 1 pessoa por máquina na 1ª versão |
| Agrupamento | 4 MINOR por tema (tabela acima) |
| Registro | este arquivo + 1 documento por feature; ADR quando a feature for aprovada |

## Perguntas em aberto

As 9 perguntas deste roadmap foram respondidas em 26/10/2026 (tabela acima). Nenhuma
pergunta em aberto agora. Pergunta nova que surgir entra aqui, com a feature e a proposta.

## Fluxo de trabalho

1. Cada feature tem uma issue no milestone da versão dela e no quadro do Projects.
2. Antes de implementar: revisar o documento da feature, responder as perguntas em aberto
   dela e escrever a ADR (status Aceita).
3. Implementar em PR próprio, com `npm run check`, os testes no navegador e, nas features
   7 e 8, `npm run seguranca`.
4. Ao terminar a feature, marcar a linha da tabela acima como entregue, com a versão.
