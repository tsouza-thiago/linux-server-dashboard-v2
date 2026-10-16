# Linha de base de segurança da 2.0.1 — 16/10/2026

Antes de limpar código legado na 2.0.1, a `v2.0.0` passou por uma varredura completa. Uma
remoção descuidada pode tirar uma proteção sem ninguém perceber. Por isso a rede de
segurança foi montada e validada **antes** de qualquer remoção. Este documento registra o
que as ferramentas acharam na base, a análise de cada achado e a decisão tomada.

- **Base:** `v2.0.0` (`8828ae4`), mais os testes herméticos do primeiro commit da 2.0.1.
- **Como repetir:** `npm run check` (testes nativos) e `npm run seguranca` (ferramentas).
- **Exceções aceitas:** `docs/seguranca/excecoes.json`, cada uma com motivo e teste.

## Resumo

| Ferramenta | Versão (imagem presa por digest) | O que examina | Resultado na base |
|---|---|---|---|
| `test/seguranca/` (nativo) | Node 24 | regras estáticas, matriz de ataque, payloads OWASP, OSINT, cadeia de suprimentos | 62 testes; 1 brecha achada (CSV, abaixo) |
| Semgrep | 1.180.0 | 117 arquivos com `p/owasp-top-ten`, `p/nodejs`, `p/javascript`, `p/xss`, `p/command-injection`, `p/secrets` | 0 achados |
| Gitleaks | 8.30.1 | arquivos + 84 commits de todos os ramos | 0 segredos |
| ShellCheck | 0.11.0 | 4 scripts shell | 2 avisos, falso positivo (abaixo) |
| OSV-Scanner | 2.7.0 | `package-lock.json` | 0 vulnerabilidades |
| OWASP ZAP | 2.17.0 | varredura passiva e ativa da API autenticada (~2.500 pedidos, ~2.170 com 2xx) | 0 médio/alto real; 1 alto falso positivo; 5 baixos |
| Mutação | — | 21 guardas quebrados de propósito | 21/21 acusados |

Nenhum achado permitia ler dados, executar comando ou entrar no painel sem credencial.

---

## Achados e decisões

### 1. CSV: TAB e CR no início da célula (formula injection) — **corrigido na 2.0.1**

O `csvEscape` (`server/csv.js`) prefixava com `'` as células que começam com `=`, `+`, `-`
ou `@`. A orientação do OWASP (CSV Injection) inclui também **TAB (0x09)** e **CR
(0x0D)**: o Excel e o LibreOffice ignoram esses caracteres e interpretam o resto como
fórmula. Além disso, um `\r` no meio do valor não colocava a célula entre aspas.

**Risco real: baixo.** As colunas de texto do CSV são `host` e `kernel`, e esses valores
vêm do servidor monitorado. O modelo de ameaças (SECURITY, ameaça 13) trata a resposta do
servidor como não confiável: um servidor comprometido poderia plantar uma fórmula no
relatório de quem o monitora.

**Decisão:** corrigir. O teste veio antes do conserto, em
`test/seguranca/payloads-owasp.test.js`.

### 2. OWASP ZAP 40018 "SQL Injection" (alto) — **falso positivo, exceção analisada**

O ZAP comparou `GET /api/annotations` com as condições `AND 1=1` e `AND 1=2` e viu
respostas diferentes. A diferença vem do estado: entre uma comparação e outra, os `POST`
da varredura criaram anotações, e a lista cresceu. O painel não tem banco de dados nem SQL.
Os dados ficam em NDJSON/JSON em `data/`.

**Decisão:** exceção em `excecoes.json`. A premissa "não existe SQL" passa a ser conferida
por `test/seguranca/invariantes-estaticas.test.js` (CWE-89). Se um dia entrar SQL, o teste
cai e a exceção precisa ser revista. O `ts` da anotação já era validado (`Date.parse`);
mesmo assim, a 2.0.1 passa a gravá-lo em ISO canônico.

### 3. OWASP ZAP 90004 "Cross-Origin-Embedder-Policy ausente" (baixo) — **endurecido na 2.0.1**

O painel já mandava `Cross-Origin-Opener-Policy: same-origin` e
`Cross-Origin-Resource-Policy: same-origin`. Faltava o
`Cross-Origin-Embedder-Policy: require-corp`. Como o painel só carrega recursos da própria
origem, o cabeçalho não quebra nada e completa o isolamento entre origens.

### 4. Respostas da API sem `Cache-Control: no-store` — **endurecido na 2.0.1**

Este achado veio da análise do item 3, não de um alerta. As respostas JSON da API (sessão,
telemetria, configuração) e as do assistente de instalação, que incluem o token de acesso
no fim, podiam ficar no cache de disco do navegador. O OWASP ASVS (V8, dados sensíveis)
pede `no-store` para elas.

### 5. ZAP: os outros baixos e informativos — **sem ação**

- *Unexpected Content-Type*: o OpenAPI gerado declara JSON, mas `/` devolve HTML e o
  export devolve CSV. É o esperado.
- *Client Error response*: os 404 e 401 que a própria varredura provoca. É o esperado.
- *Non-Storable Content* e *Session Management Response*: informativos. Descrevem os
  cookies `dash_csrf` e `dash_session`, que são HttpOnly e SameSite.

### 6. ShellCheck SC2034 em `scripts/node-runtime.sh` — **falso positivo, explicado no código**

O ShellCheck diz que `NODE_BIN` e `NODE_ORIGEM` não são usadas. O arquivo é uma biblioteca
carregada pelo `./dashboard` com `.`, e é o `./dashboard` que lê as duas variáveis. Uma
diretiva comentada no próprio script explica isso. Sem exceção no JSON.

### 7. Matriz de ataque: `DELETE` com corpo respondia 400 sem cabeçalhos — **erro do cliente de teste**

O cliente HTTP dos testes mandava o corpo do `DELETE` sem `Content-Length`. O parser do
Node lia esses bytes como uma segunda requisição inválida e respondia 400 antes de o
painel agir. Um navegador sempre enquadra o corpo, então o painel não tinha falha. O
cliente de teste foi corrigido.

---

## OSINT: o que o repositório público revela

O repositório é público. Qualquer pessoa, ou robô, pode ler todos os arquivos e todo o
histórico. O que foi conferido:

| Item | Onde | Situação | Decisão |
|---|---|---|---|
| Chaves privadas, tokens, senhas | arquivos e histórico | nenhum (Gitleaks + `segredos-osint`) | — |
| IP da rede local | 2 endereços `192.168.x` em 22 trechos de commits antigos da V1 | só no histórico; os arquivos atuais usam IPs de documentação | o histórico não é reescrito (ADR 0001 / D0). São endereços privados, não roteáveis pela internet. O risco é baixo: revelam só a faixa da rede doméstica |
| IP privado e MAC nos arquivos atuais | 2 testes da anonimização (`capturar-amostra`) | de propósito: o teste confere que a anonimização os troca | lista de exceção no teste, com motivo |
| E-mail pessoal do mantenedor | metadados de 22 commits e de 4 tags | público por natureza do git | a partir da 2.0.1, commits e tags usam o e-mail *noreply* do GitHub (configuração local do repositório). O histórico não é reescrito |
| Caminhos da pasta pessoal | arquivos | só nomes genéricos dos testes (`ana`, `maria`, `dashmon`) | regra no `segredos-osint` |
| Hostname, IP e dados do servidor real | arquivos | ausentes: as fixtures vêm do `npm run capturar-amostra` (anônimo) e `data/` nunca é versionada | — |

---

## Como a rede de testes foi validada

Um teste que nunca falha não protege nada. O `scripts/mutacao-seguranca.mjs` quebra 21
proteções, uma por vez, numa cópia do repositório, e exige que algum teste **falhe por
asserção**. Antes, uma rodada de controle sem mutação precisa passar. Três exemplos das
proteções quebradas:

- tirar o Host check, o CSRF ou o login;
- escutar em `0.0.0.0`, aceitar o token na URL ou pôr `unsafe-inline` na CSP;
- mudar uma letra do script de coleta.

Na primeira versão, a rodada de controle revelou um falso "21/21": os testes novos ainda não
estavam no git e não entravam na cópia. Toda mutação "morria" por arquivo ausente. A cópia
e a varredura OSINT passaram a incluir os arquivos novos ainda não commitados, e a mutação
só conta como acusada quando um teste falha de verdade.
