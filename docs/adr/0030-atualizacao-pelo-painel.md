# ADR 0030 — Atualização pelo painel: procura diária em processo à parte

- **Status:** Aceita
- **Data:** 31/10/2026

## Contexto

Atualizar exige abrir o terminal, e o painel não avisa que há versão nova (#90, F7). O plano está em
[docs/roadmap/f7-atualizacao-pelo-painel.md](../roadmap/f7-atualizacao-pelo-painel.md). Ele sai em 3
entregas. Esta ADR registra o que a 1ª decide, porque muda o que o painel faz sozinho: até a 2.4.x, a
única conexão que ele abria era o SSH da coleta.

## Decisão

1. **O painel procura versão nova 1 vez por dia, sempre ligado.** A única saída nova é
   `git fetch --quiet --tags origin`, para o `origin` do próprio clone. Sem API do GitHub e sem
   telemetria: o projeto não fica sabendo de nada que o `git fetch` já não mostre ao GitHub. Sem
   internet, a procura falha em silêncio e tenta no dia seguinte; o menu mostra a última tentativa.
2. **A procura roda em processo à parte** (`server/atualizacao/procurar.js`, com `nice -n 19`). O
   fetch leva até 2 min e as conferências de assinatura são síncronas: dentro do painel, seguram o
   laço de eventos e o SSE. O processo também não pesa no orçamento de RAM do painel: sobe, responde
   em JSON e sai. Teto de 150 s, acima dos 2 min do git dentro dele.
3. **Só tag assinada, com a lista de chaves da versão instalada** (ADR 0012), pela mesma função do
   `dashboard atualizar` (`newestSignedTag`). Ela confere só as tags acima da instalada e para na
   1ª válida: a verificação diária custa 1 conferência, não uma por versão publicada.
4. **Agenda:** ~5 min depois de ligar, com até 1 h de atraso aleatório, e a próxima conta da última
   verificação guardada em `data/atualizacao.json`. Reiniciar o painel não adianta a procura. O
   "Procurar agora" aceita 1 pedido por minuto.
5. **Nada de pergunta:** `GIT_TERMINAL_PROMPT=0` e `ssh -o BatchMode=yes`, sem stdin. Quem clonou por
   SSH com chave protegida vê "sem acesso", nunca uma janela de senha aberta por um serviço.
6. **Novidades vêm do CHANGELOG da tag** (`git show <tag>:CHANGELOG.md`), recortadas entre a versão
   instalada e a nova, com teto de 32 KB. O texto vai para a tela como texto, pelo template `html`.
7. **Sem login, o aviso aparece e a atualização não** (`bloqueio: 'sem-login'`): sem sessão, qualquer
   programa da máquina poderia pedir a troca de versão.
8. **Só quem chama de verdade é o `startServer`.** O `createApp` sem `procurarVersao` não sai da
   máquina: os testes, o painel de teste e o ZAP nunca fazem `git fetch`.

## Consequências

- O SECURITY.md ganha uma ameaça para essa saída. O limite de 1 SSH por coleta (I1) não muda: a
  procura não usa SSH do servidor nem a trava de coleta, e o servidor não participa (I2).
- A procura traz tags para o `.git` da instalação. É a única escrita dela, e o `dashboard atualizar`
  já fazia o mesmo.
- Uma entrega seguinte acrescenta o botão que dispara a troca de versão, o executor fora do serviço
  e o log ao vivo, com a invariante I11 do plano. Até lá, a tela mostra o comando do terminal.

## Alternativas descartadas

- **API de releases do GitHub:** mais um formato, limite de uso sem token, e HTML de fora. As tags
  assinadas já são a fonte de verdade.
- **Procura dentro do processo do painel, com `spawn` só no fetch:** a conferência de assinatura
  teria de ser reescrita em assíncrono, e aí o CLI e o painel teriam 2 caminhos para a mesma decisão
  de segurança.
