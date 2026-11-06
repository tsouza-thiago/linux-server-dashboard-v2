# Roadmap — versões 2.3.0 a 2.6.0

- **Situação:** concluído. As 11 features foram entregues entre a 2.2.3 e a 2.6.0. A 2.6.0
  saiu em 06/11/2026.
- **Data:** 26/10/2026 (plano) e 06/11/2026 (conclusão).
- **Issue do roadmap:** #83 (fechada). Milestones 2.3.0 a 2.6.0 (fechados).
- **Regra:** cada feature tem um documento em [`docs/roadmap/`](roadmap/) com o objetivo, a
  situação de hoje no código, a decisão, as etapas pequenas, os testes e os riscos. A
  decisão virou ADR quando a feature foi aprovada para implementar.

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
| 1 | Animação ao passar o mouse nos botões (hover) — **entregue na 2.2.3** | P | 2.2.3 | — | #84 | [f1-hover.md](roadmap/f1-hover.md) |
| 2 | Animação de clique nos botões — **entregue na 2.3.0** | P | 2.3.0 | 1 (mesmos tokens) | #85 | [f2-clique.md](roadmap/f2-clique.md) |
| 3 | Transição suave na troca de telas — **entregue na 2.3.0** | P | 2.3.0 | — | #86 | [f3-troca-de-tela.md](roadmap/f3-troca-de-tela.md) |
| 4 | Link simbólico: `dashboard` sem `./` e fora da pasta — **entregue na 2.4.0** | P–M | 2.4.0 | — | #87 | [f4-link-simbolico.md](roadmap/f4-link-simbolico.md) |
| 5 | Autocomplete com Tab (bash) — **entregue na 2.4.0** | M | 2.4.0 | 4 (para valer fora da pasta) | #88 | [f5-autocomplete.md](roadmap/f5-autocomplete.md) |
| 6 | Skeleton em tudo o que carrega — **entregue na 2.3.0** | M | 2.3.0 | 3 (a entrada do conteúdo) | #89 | [f6-skeleton.md](roadmap/f6-skeleton.md) |
| 7 | Atualização pelo painel, com aviso e log — **entregue na 2.5.0** | G | 2.5.0 | — | #90 | [f7-atualizacao-pelo-painel.md](roadmap/f7-atualizacao-pelo-painel.md) |
| 8 | Reconfigurar pelo painel — **entregue na 2.5.0** | G | 2.5.0 | 7 (menu e executor) | #91 | [f8-reconfigurar-pela-tela.md](roadmap/f8-reconfigurar-pela-tela.md) |
| 9 | Instalação em `/opt` por pacote `.deb` — **entregue na 2.6.0** | GG | 2.6.0 | 4, 5, 7 e 8 | #92 | [f9-deb-e-opt.md](roadmap/f9-deb-e-opt.md) |
| 10 | Hover mais visível em clicáveis, contêineres e gráficos — **entregue na 2.2.4** | M | 2.2.4 | 1 | #100 | [f10-hover-mais-visivel.md](roadmap/f10-hover-mais-visivel.md) |
| 11 | README e TUTORIAL ilustrados com prints e elementos gráficos — **entregue na 2.4.0** | M | 2.4.0 | 6 (prints da interface final) | #106 | [f11-documentacao-ilustrada.md](roadmap/f11-documentacao-ilustrada.md) |

A F8 era menos arriscada que a F7 (reaproveita o assistente e não acessa a internet), mas
veio depois dela porque usa o menu e o executor que a F7 criou.

## Versões (ADR 0015 e 0023)

Cada feature saiu em PR próprio. As versões subiram conforme os milestones, e mudança pequena
saiu direto na versão estável, sem pré-versão (ADR 0023, de 30/10/2026). A pré-versão ficou para
as features de nível G e GG. A F1 saiu na 2.2.3.

| Versão | Tema | Pré-versões (plano) |
|---|---|---|
| 2.2.4 | Hover mais visível | nenhuma |
| 2.3.0 | Interface mais suave | nenhuma: clique, troca de tela e skeleton saem juntos |
| 2.4.0 | Comando no PATH | nenhuma: link simbólico e autocomplete saem juntos; a F11 é só documentação e sai nas notas desta versão |
| 2.5.0 | Manutenção pelo painel | atualizar: uma pré-versão por grupo de etapas (detecção, aviso, execução); depois reconfigurar |
| 2.6.0 | Pacote `.deb` e `/opt` | uma pré-versão por grupo de etapas (modo sistema, executor, pacote) |

Nenhuma destas versões quebrou quem instalou por `git clone`: todas saíram como MINOR (ou
PATCH, na 2.2.3 e na 2.2.4). Nenhuma mudou o formato de `data/`.

## Regras que valem para todas as features

1. As invariantes I1–I11 do [AGENTS.md](../AGENTS.md) continuam valendo. Nenhuma feature
   abre SSH para o servidor nem grava nada nele.
2. **Orçamento da página inicial:** 450 KB transferidos (293 KB no início do roadmap). Cada
   PR de tela mede o tamanho no `test/e2e/telas.test.js`.
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
| F10 (30/10/2026) | a F1 ficou fraca: animação mais visível e hover em todo clicável, antes da F2 |
| F11 (30/10/2026) | pedido do mantenedor: README e TUTORIAL com prints das telas e outros elementos gráficos; sai nas notas da 2.4.0, com até 200 KB por print e 3 MB em `docs/img/` |

## Perguntas em aberto

As 9 perguntas deste roadmap foram respondidas em 26/10/2026 (tabela acima). O roadmap está
concluído e não tem pergunta em aberto. O próximo roadmap terá um arquivo próprio.

## Fluxo de trabalho

O fluxo que este roadmap seguiu (vale também para o próximo):

1. Cada feature teve uma issue no milestone da versão dela e no quadro do Projects.
2. Antes de implementar: revisar o documento da feature, responder as perguntas em aberto
   dela e escrever a ADR (status Aceita).
3. Implementar em PR próprio, com `npm run check`, os testes no navegador e, nas features
   7, 8 e 9, `npm run seguranca`.
4. Ao terminar a feature, marcar a linha da tabela acima como entregue, com a versão.
