# ADR 0051 — O serviço escreve só em `data/` e `.atualizacao/painel/`; a procura usa um espelho

- **Status:** Aceita
- **Data:** 06/11/2026

## Contexto

Na instalação por clone com o serviço systemd de usuário (2.5.0), o botão "Atualizar agora" falhou
sem aviso na tela e o "Procurar agora" disse sempre "sem acesso" (#181). A unidade (`server/setup/local.js`)
tem `ProtectSystem=strict` e `ProtectHome=read-only`, e o `ReadWritePaths` só listava `data/`. O painel
precisava gravar em `.atualizacao/` (ADR 0031) e o `git fetch --tags` precisava gravar no `.git` (ADR 0030).
Os dois davam erro. A rota não tratava a exceção: virava 500 e a tela ficava parada. O painel de teste não
pega isso, porque não roda dentro da unidade. No pacote `.deb` (modo sistema), `.atualizacao/` também fica
fora do `data/`, então o botão quebrava do mesmo jeito.

## Decisão

1. **Menor privilégio.** O serviço escreve só em `data/` e em `.atualizacao/painel/` (duas linhas
   `ReadWritePaths`; a do `painel/` leva o prefixo `-`, para a falta da pasta não derrubar o serviço). A
   `.atualizacao/` em si e o `.git` continuam somente leitura.
2. **Quem grava cada arquivo.**
   - Executor (`dashboard atualizar --registro`, fora do sandbox), em `.atualizacao/`: `ultima.log`,
     `estado.json`, `trava.pid` e `pre.json`. São os arquivos em que ele confia para decidir algo. Um painel
     comprometido não cria o `pre.json` (liberar pré-versão) nem a trava.
   - Painel, em `.atualizacao/painel/`: `pedido.json` (o pedido da tela e, se o executor não subir, a
     falha) e `espelho.git`.
   - Nenhum arquivo precisa da escrita dos dois lados. O executor, ao pegar a trava, zera o log e grava
     um `inicio` novo no `estado.json`; enquanto esse `inicio` for mais velho que o do `pedido.json`, a
     tela mostra o pedido (`iniciando`, a falha ou "interrompida" depois de 1 min). A tela só lê.
3. **A procura usa um espelho.** O fetch das tags vai para um repositório bare em
   `.atualizacao/painel/espelho.git`, criado vazio, com `core.hooksPath=/dev/null`, `--no-tags` e o refspec
   `+refs/tags/*:refs/tags/*` da URL do `origin` do clone (lida da configuração, sem escrever nela). A
   tag assinada mais nova e o CHANGELOG saem do espelho, com a lista de chaves do clone (a da versão
   instalada). O espelho **só alimenta o aviso da tela**.
4. **O executor nunca usa o espelho.** Na troca, o `dashboard atualizar` faz o fetch e confere a
   assinatura de novo no `.git` real, como antes (ADR 0012). Um espelho adulterado, no pior caso, mostra
   um aviso falso; a troca recusa o que não tem assinatura válida. Uma regra estática
   (`test/seguranca/registro-e-espelho.test.js`) falha se o código do executor citar o espelho.
5. **Falha visível.** Se `.atualizacao/painel/` não aceitar escrita, a rota
   `POST /api/atualizacao/iniciar` responde 503 com `motivo: "sem-escrita"` e um texto que manda rodar
   `./dashboard atualizar` no terminal; a tela o mostra e o botão volta. Nada de 500 sem texto.
6. **Como chega a quem já instalou.** `installService` cria `.atualizacao/painel/` e regrava a unidade;
   o `dashboard atualizar` (fase 2) e o `reconfigurar` o chamam. Quem está na 2.5.0 ou na 2.6.x faz a 1ª
   troca pelo terminal (`./dashboard atualizar --terminal`); a partir daí o botão funciona. No pacote
   `.deb`, a mesma unidade de usuário é gerada por `installService`.

## Alternativas recusadas

- **Escrita no `.git` inteiro.** Um painel comprometido poderia plantar hooks e configuração que o git
  roda depois, fora do sandbox.
- **`.atualizacao/` inteira com escrita.** Deixaria o painel criar o `pre.json` e a trava.
- **Procura fora do serviço (`systemd-run`).** Seguro, mas exige esperar o fim, passar o resultado por
  arquivo e tratar concorrência, além de rodar sem isolamento. O espelho dá a mesma garantia com menos código.
- **Desligar o hardening.** Piora a segurança de todos para consertar um caminho.

## Consequências

- O 1º "Procurar agora" depois da correção baixa o histórico de tags para o espelho (alguns MB).
- Teste que pega o bug: a unidade gerada precisa cobrir os caminhos que o painel grava
  (`test/seguranca/registro-e-espelho.test.js`); a procura não pode mexer no `.git` do clone e a rota
  responde 503 sem a pasta (`test/integration/atualizacao.test.js`).
