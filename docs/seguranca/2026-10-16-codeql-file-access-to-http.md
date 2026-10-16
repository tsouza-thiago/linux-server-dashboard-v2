# Alerta 8 do CodeQL: dado de arquivo num pedido HTTP — 16/10/2026

| # | Regra | Onde | Risco real | Decisão |
|---|---|---|---|---|
| 8 | `js/file-access-to-http` (médio) | `test-support/request.js` | **Nenhum**: código de teste, destino fixo em `127.0.0.1` | **Falso positivo**, descartado; destino travado por teste |

## O que o CodeQL viu

A regra procura dado lido de arquivo que sai num pedido de rede: é o caminho de um
vazamento (CWE-200), em que algo como uma chave ou um `.env` vai para fora.

`test-support/request.js` é o cliente HTTP dos testes de integração e de segurança. Alguns
testes mandam a ele dados que vieram de arquivo. O caso principal é a matriz de ataque
(`test/seguranca/superficie-ataque.test.js`), que lê as rotas do próprio código
(`test-support/rotas.js` lê `server/index.js` e `server/setup/web.js`) e faz um pedido a cada
uma.

## Por que não é um problema

- **Destino fixo:** os dois `http.request` do arquivo usam `host: '127.0.0.1'` escrito no
  código. A porta é a do servidor de teste que o próprio teste abriu (`listen(app)`, porta
  livre em `127.0.0.1`). Nada vai para outra máquina.
- **O dado de arquivo é o código do projeto** (nomes de rotas) ou valores de teste criados
  numa pasta temporária. Não é segredo de ninguém.
- **Não é código do painel:** `test-support/` não é carregado pelo servidor nem pela tela.
  O painel em si já tem a regra "nenhum pedido de rede para fora" (CWE-918, em
  `test/seguranca/invariantes-estaticas.test.js`).

## O que garante que continue assim

Regra nova em `test/seguranca/invariantes-estaticas.test.js`, "CWE-200: os clientes HTTP dos
testes só falam com 127.0.0.1": exige `host: '127.0.0.1'` fixo nos dois pedidos e nenhum host
vindo de parâmetro. Conferida na forma errada: com `host: destino`, a regra falha.

## Como surgiu

O alerta apareceu na análise do PR da 2.0.1, depois que `request()` passou a mandar o corpo
com `Content-Length`. O check do CodeQL no PR não reprova por alerta de nível "warning", e
ele só foi notado na conferência depois da publicação da `v2.0.1`. Por isso a análise e a
regra entram depois da versão.
