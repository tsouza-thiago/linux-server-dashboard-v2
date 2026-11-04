# Auditoria do CI — 04/11/2026 (#128)

A auditoria mediu cada fluxo do CI e decidiu, item por item, se ele fica, melhora ou sai. O foco
é o tempo que cada push espera. A regra: nenhuma camada de segurança das ADRs 0014, 0016 e 0017
sai sem análise, e toda mudança de decisão vira ADR (aqui, a [ADR 0040](../adr/0040-ci-em-jobs-paralelos-com-limite-de-tempo.md)).

## Resumo

- **Nada sai.** Cada verificação pega algo que as outras não pegam, e as mais caras não estão no
  caminho crítico do push.
- **O job `verificacao` vira 4 jobs ao mesmo tempo** (`check`, `e2e`, `seguranca` e `mutacao`), mais
  um job que junta o resultado com o mesmo nome do check obrigatório.
- **A mutação roda em paralelo** (até 4 rodadas), num job só dela no CI.
- **Toda etapa tem limite de tempo:** no workflow, em cada etapa do `npm run seguranca` e em cada
  rodada da mutação. A etapa presa reprova com o nome dela (o problema do PR #127).

## Tempos

Medidos no CI do GitHub (`ubuntu-24.04`, 4 núcleos). "Antes" é o run #229 do `verificação`
(04/11/2026, push do merge do PR #146, job 126684509124), com 1 job. "Depois" é o run 41890439275, do
PR #147, com os 4 jobs ao mesmo tempo.

| Etapa | Antes (1 job) | Depois (4 jobs ao mesmo tempo) |
|---|---|---|
| Preparo (código, Node 24, `npm ci`) | 8 s, 1 vez | 7 a 8 s em cada job |
| `npm run check` | 32 s | 35 s (job `check`: 45 s) |
| Chromium | 9 s | 8 s |
| `npm run test:e2e` | 1 min 50 s | 1 min 45 s (job `e2e`: 2 min 4 s) |
| `npm run seguranca` sem a mutação | 1 min 30 s, dentro do comando | 1 min 26 s (job `seguranca`: 1 min 36 s) |
| Dentro dela: Semgrep · Gitleaks · ShellCheck · OSV · ZAP | 20 · 5 · 1 · 7 · 56 s | 22 · 3 · 1 · 7 · 52 s |
| Mutação, 77 mutações | 137 s, uma por vez | 85 s, 4 em paralelo (job `mutacao`: 1 min 38 s) |
| Job `verificacao` (junta os 4) | — | 2 s |
| **Workflow `verificação`** | **6 min 28 s** | **2 min 13 s** |

O caminho crítico agora é o job `e2e`: os jobs `seguranca` e `mutacao` terminam cerca de 25 s antes
dele.

Os outros fluxos rodam ao mesmo tempo que o `verificação` e não aumentam a espera:

| Fluxo | Quando | Tempo (04/11) |
|---|---|---|
| CodeQL (configuração padrão, suíte estendida, JavaScript e Actions) | todo PR e push no `main`, e toda semana | 53 s (o maior dos 2 jobs) |
| Dependency Review (`dependencias.yml`, job `revisao`) | todo PR | 4 s |
| Scorecard (`scorecard.yml`) | push no `main` e toda segunda | 33 s |
| Dependabot | toda segunda, abre PR | sem tempo de CI próprio; o PR dele roda o CI normal |

**Por PR** (o que a pessoa espera): o mais lento dos fluxos, o `verificação`. Antes, 6 min 28 s;
depois, 2 min 13 s (−66%). **Por push no `main`:** o mesmo, com o Scorecard e o CodeQL ao lado. Em
minutos de máquina somados, o `verificação` foi de 6 min 28 s para cerca de 6 min 5 s (os 4 jobs mais
o que junta): o preparo repetido custa menos que o tempo que a mutação ganhou.

Medição local (8 núcleos presos a 4 com `taskset -c 0-3`, para imitar o CI): a mutação sequencial
levou 177 s; com 2 rodadas, 115 s; com 4, 100 s. Mais de 4 não ajuda: cada `node --test` já roda os
arquivos dele em paralelo, e as rodadas passam a disputar os mesmos núcleos.

## Decisão por item

### Workflow `verificação` (`seguranca.yml`) — melhora

- **Antes:** 1 job, os 3 comandos um depois do outro. O tempo era a soma.
- **Depois:** 4 jobs ao mesmo tempo, cada um na sua máquina. O tempo é o do mais lento. O
  `npm run seguranca` vira 2 jobs: `--pular=mutacao` (as ferramentas Docker) e `--so=mutacao`. Juntas
  numa máquina de 4 núcleos, as 2 metades disputam a CPU: na medição local, o Semgrep foi de 20 s para
  110 s e o Gitleaks, de 5 s para 53 s. Só o job `seguranca` baixa todo o histórico (o Gitleaks precisa dele); os outros baixam só o último commit.
- **O check obrigatório não muda de nome.** O ruleset do `main` exige `verificacao` e `revisao`. O
  job `verificacao` agora espera os 4 (`needs`), roda sempre (`if: always()`) e só passa com os 4 em
  `success`. Sem o `always()`, um job vermelho deixaria o `verificacao` "pulado", e o GitHub conta
  check pulado como aprovado.
- **Limite em toda etapa** (`timeout-minutes`, cerca de 3 vezes o medido). Antes, só o teto de 40 min
  do job.

### `npm run check` — fica

27 a 32 s, quase todo nos testes com cobertura (729 testes). Ele é a 1ª camada da ADR 0014 e o que
roda antes de cada commit. O `npm audit --omit=dev` leva 0,7 s e hoje não acha nada, porque o painel
não tem dependência de runtime (`cadeia-suprimentos` já reprova uma dependência nova). Ele fica: custa
menos de 1 s e é a camada que audita uma dependência de runtime, se uma entrar um dia por decisão.

### `npm run test:e2e` — fica, em job próprio

1 min 50 s, quase todo no `telas.test.js` (47 testes um depois do outro; o maior, o hover das 8
telas nos 2 temas, leva 38 s). Ele é a única camada que olha a tela num navegador real (CSP sem erro
de JS, anti-XSS na tela, orçamento de 450 KB). Dividir o arquivo em partes para rodar em paralelo
mexeria em testes que medem animação e hover, sensíveis a carga de CPU. Com os jobs paralelos, o e2e
virou o caminho crítico; a divisão fica como a próxima melhora possível, se o tempo voltar a pesar.

### `npm run seguranca` — melhora

- **Mutação** (137 s, a etapa mais pesada): melhora. As rodadas correm em paralelo, até 4, cada uma
  na sua cópia do repositório. Cada rodada tem limite de 60 s (a mais lenta levou 10,5 s com 4 ao
  mesmo tempo); a que passa dele é derrubada com todos os processos dela e reprova com o nome da
  mutação e o comando para reproduzir. O controle (a rodada sem mutação) tem 3 vezes o limite. As
  mutações desatualizadas são conferidas antes de tudo, sem rodar teste.
- **As etapas Docker** continuam uma por vez (disputam o mesmo daemon e a rede). No CI, ficam num job
  e a mutação em outro; na máquina de quem desenvolve, o `npm run seguranca` sem opção roda as 2
  metades ao mesmo tempo. Cada uma ganhou limite próprio; o teto do ZAP caiu de 20 para 5 min, e o da
  varredura ativa, de 10 para 3 min (ela leva menos de 1 min).
- Nenhuma ferramenta sai; a sobreposição é analisada abaixo.

### CodeQL — fica

53 s por PR, ao lado do `verificação` (não aumenta a espera). O ruleset reprova o PR com alerta de
segurança alto ou de erro.

### Dependabot e Dependency Review — ficam

O Dependabot não gasta tempo de CI no push; o Dependency Review leva 4 s e é check obrigatório.

### Scorecard — fica

33 s, só no `main` e toda segunda, ao lado do `verificação`.

## Verificações que parecem repetidas

### CodeQL, Semgrep e as regras estáticas (`invariantes-estaticas`)

| | Pega | Não pega |
|---|---|---|
| CodeQL | fluxo de dados entre funções e arquivos (dado do pedido chegando a `spawn`, a arquivo, a HTML) | as regras do projeto (I1–I11); padrões que não são fluxo |
| Semgrep | padrões OWASP por regra (`p/owasp-top-ten`, `p/nodejs`, `p/xss`…), roda igual na máquina de quem desenvolve | fluxo entre arquivos (a versão gratuita olha cada função) |
| Regras estáticas | o que só vale aqui: só `127.0.0.1`, `spawn` sem shell, `BatchMode` no SSH, 0600, nada de `style=`, CSP | qualquer coisa fora da lista do projeto |

O CodeQL só roda no GitHub, depois do push. O Semgrep e as regras estáticas rodam antes do commit. As
3 ficam.

### Gitleaks e o secret scanning do GitHub

O secret scanning (com push protection) barra no push os segredos de provedores conhecidos (GitHub,
AWS…). O Gitleaks roda antes do commit, tem regras genéricas (chave privada, token de alta entropia) e
varre todo o histórico a cada vez, inclusive o que entrou antes do secret scanning ser ligado. Custa
5 s. Os 2 ficam.

### OSV-Scanner, `npm audit`, Dependency Review e Dependabot

| | Quando | O que olha |
|---|---|---|
| `npm audit --omit=dev` | `npm run check`, antes do commit | dependências de runtime (hoje nenhuma) |
| OSV-Scanner | `npm run seguranca`, antes do commit e no CI | todo o `package-lock.json`, com a base OSV (mais fontes que o registro do npm) |
| Dependency Review | só no PR | o que o PR muda: vulnerabilidade moderada ou pior e licença incompatível com a MIT; inclui as actions |
| Dependabot | toda segunda e nos alertas | o que já está no `main` e ficou vulnerável depois; propõe a atualização |

Só o Dependency Review olha licença. Só o Dependabot avisa de uma falha nova numa versão que já
estava no `main`. O OSV e o `npm audit` são os únicos que rodam na máquina de quem desenvolve. Todos
ficam; os 2 do CI somam 8 s.

## Depois do merge: a rodada que travou ao acaso

No 1º push no `main` com os jobs paralelos (merge do PR #147), 1 rodada da mutação passou do limite de
60 s, e o job `mutacao` reprovou. Repetido, o job passou. Na máquina do mantenedor, o travamento
apareceu em 1 de cerca de 10 execuções da mutação inteira, e nunca com a mesma rodada sozinha. O log
do CI não dizia qual mutação nem qual teste. A [ADR 0041](../adr/0041-mutacao-repete-a-rodada-presa.md)
resolve as 2 coisas: cada teste ganha `--test-timeout`, o nome do teste preso vai para o log, e a
rodada presa repete 1 vez antes de reprovar.

## O que ficou de fora

- **Dividir o e2e em partes paralelas:** descrito acima, fica para quando o tempo do e2e pesar.
- **Rodar os arquivos de cada rodada da mutação num processo só** (`--test-isolation=none`): gasta
  menos CPU (3,0 contra 4,9 s por rodada), mas tira o isolamento entre os arquivos de teste. Com os
  jobs paralelos, a mutação deixou de ser o caminho crítico, então o risco não compensa.
- **Cache do `npm ci`:** a única dependência é o `playwright-core`, e o `npm ci` leva cerca de 1 s.
