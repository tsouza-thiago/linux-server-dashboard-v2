# ADR 0034 — Reconfigurar pela tela: assistente em processo à parte e volta garantida

- **Status:** Aceita
- **Data:** 01/11/2026

## Contexto

O `dashboard reconfigurar` exige um terminal aberto até o fim, e cancelar deixa o painel parado. A F8
(#91) leva a reconfiguração para a tela. A F7 já trouxe o menu de manutenção e o executor fora do
serviço (ADR 0031). Sem terminal, ninguém religa o painel, então desistir precisa devolver o painel
sozinho.

O planejamento partia de uma premissa errada: que o `.env` e o `data/ssh/` só mudam no último passo.
O código mostra outra coisa. O `known_hosts` muda no passo 3 (`conectar`). O `.env` e o
`data/ssh/config` mudam a cada teste de coleta do passo 5 (`testarColeta`).

## Decisão

1. **O assistente continua em processo à parte.** As rotas dele recebem a senha do administrador. Ficam
   num processo que só vive durante a reconfiguração, e a superfície do painel não cresce.
2. **`dashboard reconfigurar --pela-tela`, opção interna.** O comando é fixo e não lê nenhuma outra
   opção (I11). Ela só vale no `reconfigurar` e sem `--terminal`, `--sem-interface` ou `--importar-v1`;
   fora disso, sai com código 2.
3. **O código vem por arquivo, com hash.** `data/reconfigurar.json` (0600) guarda só o SHA-256 e o prazo
   (5 min). O painel entrega o código puro só ao navegador que pediu. O comando tira o arquivo do disco
   ao ler, e o assistente aceita o código 1 vez. São 128 bits, em hexadecimal: ninguém digita este código.
4. **Tudo o que pode recusar vem antes de parar o painel:** conferência da versão, atualização em
   andamento e código válido. Quem recusa aqui deixa o painel no ar.
5. **Um clique na tela nunca troca a versão da pasta.** O `instalar` fixa a tag assinada sozinho quando
   acha a pasta fora dela. Pela tela, o `preflight` roda sem `reexec`: ele só recusa.
6. **Desistir sempre devolve o painel.** Cancelar pela rota do assistente, receber `SIGTERM`, ficar
   15 min parado ou não conseguir subir o assistente restaura a configuração e liga o painel. Os 15 min
   substituem a 1 h do terminal, porque a coleta está parada.
7. **A configuração anterior fica na memória do processo.** `guardarConfiguracao` copia o `.env`, o
   `data/ssh/config` e o `data/ssh/known_hosts` antes do assistente, depois de parar o painel. Sem
   cópia em disco, nenhum segredo sobra numa pasta depois do fim.
8. **`POST /api/configurar/cancelar` só existe pela tela** e exige a sessão do assistente. No terminal,
   quem cancela é o Ctrl+C.
9. **Sem terminal, a saída vai para `data/reconfigurar.log`** (0600, só a última vez). Ela nunca traz o
   código nem a senha.

## Consequências

- Até a etapa 3 da F8, nada dispara o `--pela-tela`. A opção fica fora do autocomplete e da ajuda.
- Cancelar depois do preparo não desfaz o que mudou **no servidor**: o `authorized_keys` já tem o script
  novo. Se os alvos mudaram, o painel anterior acusa `hashMismatch`, com o passo a passo da ADR 0032.
- Um `kill -9` no assistente deixa o painel parado e a configuração como estava no momento. A etapa 2
  da F8 trata a volta quando o painel novo não sobe; o `dashboard iniciar` continua resolvendo à mão.
- A pasta sem tag assinada não reconfigura pela tela: o comando fixo não leva `--sem-assinatura`. A
  etapa 3 precisa mostrar isso como bloqueio, antes de o painel disparar.

## Alternativas descartadas

- **Rotas do assistente dentro do painel:** aumentam a superfície e põem a senha do administrador no
  processo do painel.
- **Mudar o assistente para gravar só no fim:** o teste de coleta do passo 5 usa o `data/ssh/config` e o
  `known_hosts` novos, e o `dashboard reconfigurar` do terminal depende disso.
- **Passar o código na linha de comando:** seria dado da tela no comando, contra a I11, e apareceria em
  `/proc/<pid>/cmdline`.
- **Reaproveitar o `data/entrar.json`:** o código dele abre o painel, e este abre o assistente. Um
  arquivo só misturaria 2 permissões diferentes.
