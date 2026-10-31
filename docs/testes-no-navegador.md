# Testes no navegador

Roteiro da bateria completa de testes no navegador real ([ADR 0019](adr/0019-testes-no-navegador.md)).
Quem conduz é o agente, pela extensão Claude in Chrome, no navegador do mantenedor. A
suíte (`npm run check`, `npm run test:e2e`) confere o código; este roteiro confere o que a
pessoa vê: números iguais entre as telas, legendas, estados e textos.

## Quando rodar

- **Mudança de tela:** as telas afetadas, num painel de teste.
- **Bateria completa:** antes de cada versão publicada (`PATCH`, pré-versão e `MINOR`) e
  quando o mantenedor pedir.

## Como preparar

1. Suba os painéis de teste, um por cenário, cada um numa porta:

   ```bash
   npm run painel-teste -- --cenario=normal --porta=3943
   npm run painel-teste -- --cenario=lacunas --porta=3944
   npm run painel-teste -- --cenario=offline --porta=3945
   npm run painel-teste -- --cenario=vazio --porta=3946
   ```

   Cada um usa dados semeados numa pasta temporária, sem token e sem SSH (a coleta usa a
   fixture anonimizada). Ctrl+C encerra e apaga os dados.

   Mudou a tela do assistente de instalação? Suba também o assistente de teste, com servidor,
   ssh e systemd falsos (código `ACD-347`):

   ```bash
   npm run painel-teste -- --assistente --porta=3947
   ```
2. Abra cada endereço numa aba nova. Feche as abas no fim.
3. O painel real (`http://127.0.0.1:3000`) só entra para conferir uma versão instalada, e só
   para leitura: nada de digitar o token, reconhecer alertas ou criar anotações.

## O que conferir

A bateria roda só no desktop, numa janela de navegador comum: o painel e o assistente não
são feitos para celular, então não há teste em largura de celular.

Em todas as telas, nos cenários `normal` e `lacunas`:

- O console não tem erro nem aviso de CSP.
- Nenhum pedido sai para outro endereço além do painel.
- O tema claro e o escuro (tecla `t`) deixam todo texto legível.
- **Hover (ADR 0022 e 0024), nos 2 temas, nas 8 telas, no login e no assistente:** todo botão
  sobe 2 px com sombra e ganha fundo e borda com a cor de destaque, sem tremer com o mouse na
  borda de baixo. O item do menu mostra a barra, o fundo e o ícone na cor de destaque. Os botões
  em grupo (períodos e filtros) e os da lista de eventos trocam de fundo sem subir. Links,
  títulos de coluna e `summary` ganham sublinhado com a cor de destaque. As opções do assistente
  ganham fundo ou borda. Botão desligado não responde. O texto continua legível no hover.
- **Clique (ADR 0025), nos 2 temas, nas 8 telas, no login e no assistente:** o botão que sobe no
  hover desce e encolhe enquanto o mouse está apertado, com um anel fino no lugar da sombra, e
  soltar na borda ainda conta como clique. Botões em grupo, os da lista de eventos e o menu só
  escurecem o fundo. Botão desligado não responde. Com "reduzir movimento", nada se move.
- **Troca de tela (ADR 0026), nos 2 temas:** menu, atalhos 1–8 e link com `#/tela` trocam de tela
  com uma entrada curta (esmaecer e 4 px), sem corte seco. O login entra igual. Com 1–8 apertados
  em sequência rápida, fica só a última tela e a animação não acumula. A tela não pisca com uma
  amostra nova nem ao trocar o período ou o tema. Depois da entrada, o gráfico continua com a
  largura certa, e o cursor e o zoom acompanham o mouse.
- **Esqueleto (ADR 0027), nos 2 temas:** com a rede lenta (limitação de rede do navegador), as 8
  telas sobem com blocos no formato final, e o conteúdo entra sem a tela pular. Sem limitação, nada
  pisca. Ao trocar o período com a rede lenta, o gráfico fica com os dados velhos, esmaecido, com
  uma faixa fina no topo, e o botão do período responde na hora. Em Relatórios, o resumo velho fica
  até os blocos aparecerem. Rede e Armazenamento guardam o espaço do que carrega depois.
- **Aguardando (ADR 0025):** em "Coletar agora", "Reconhecer", "Resolver", "Salvar", "Remover" e
  "Entrar", o botão mostra o spinner e fica desligado até a resposta, sem mudar a largura, e o
  duplo clique faz só 1 pedido. Com "reduzir movimento", o spinner vira um ponto fixo.
  Todo contêiner e gráfico sob o mouse ganha destaque, mais fraco que o dos botões: cartão ou
  painel sobe 1 px com sombra e borda suaves, painel de tabela e bloco principal ganham borda e
  sombra sem subir, cada faixa de telemetria ganha fundo sem subir, e o anel de saúde ganha um
  halo. O cursor, o zoom e a dica do gráfico continuam funcionando. O foco
  por teclado (Tab) aparece sem o mouse. Com "reduzir movimento" ligado, nada se desloca e o
  fundo continua mudando. Na janela da extensão, leia o estilo depois de uma captura.

| Tela | O que conferir |
|---|---|
| Visão geral | Anel de saúde com o motivo; "Disponibilidade 90 d" igual à de Eventos; indicadores com valor ou "—", nunca 0 inventado; telemetria desenhada |
| Recursos | Gráficos de CPU, memória, pressão e temperatura no período escolhido; zoom com a roda do mouse e duplo clique para voltar |
| Armazenamento | As 4 pastas com tamanho e uso iguais aos de `/api/status`; previsão de lotação; SMART por disco |
| Rede | Vazão agora, volume do dia e erros; a interface `enp0s7` no subtítulo |
| Processos & serviços | O serviço `smbd` ativo; a lista de processos da última coleta; a busca (tecla `/`) |
| Eventos | Faixa de 90 dias: dia sem coleta cinza ("sem dados"), dia com queda vermelho; a legenda tem os 4 estados; filtros e contagens batem com a lista |
| Relatórios | 7, 30 e 90 dias: um dia por linha; "sem dados" e 0% batem com a faixa de Eventos; o cartão de disponibilidade bate com a Visão geral no mesmo período; os links de CSV e JSON baixam |
| Ajuda | Configuração ativa igual à do painel; a frase da disponibilidade; os atalhos funcionam |

Por cenário:

- **`lacunas`:** a disponibilidade conta só o tempo medido (ADR 0018). O dia inteiro em
  queda aparece vermelho em Eventos e com 0% nos Relatórios; os dias sem coleta aparecem
  "sem dados" nas duas telas.
- **`offline`:** a faixa de status diz "OFFLINE" com o motivo; a queda em andamento aparece
  em Eventos; a saúde vai a 0.
- **`vazio`:** nenhuma tela quebra; aparecem os textos de "sem dados" e de 1º uso.
- **Ao vivo (`normal`):** em até 1 min chega uma amostra nova pelo tempo real (SSE), sem
  recarregar a página.

No assistente (`--assistente`), nos 2 temas:

- **Senha:** endereço `192.0.2.10`, usuário `maria`, senha `certa`; os 6 passos até
  "Abrir o painel", no modo assistido e no modo à mão.
- **Modo à mão:** o servidor falso não recebe os blocos colados, e só o modo assistido cria o
  `dashmon`. Rode o assistido, depois "Prefiro fazer à mão" no passo 5: os 4 "Testar" passam
  e os blocos ficam "4 de 4". Sem o assistido, o "Testar" diz que o usuário não existe.
- **Chave SSH:** apelido `com-salto` mostra o erro do ProxyJump; `meu-servidor` mostra
  endereço, porta, usuário, chave e agente. No passo 3 não há campo de senha; o 1º
  Conectar mostra o `ssh-add -t 15m …` e "Tentar de novo"; o 2º conecta. No passo 5 aparece
  o campo "Senha de maria para o sudo" (`certa`), com a nota de que não é a passphrase.
- **Comando e autocomplete:** no passo 6, "Pôr `~/.local/bin` no PATH" e "Autocomplete com Tab"
  começam desligados e somem quando "Comando `dashboard` no terminal" é desligado. O assistente de
  teste roda sempre como se faltasse o pacote `bash-completion`.

## Como registrar

- No PR: os cenários rodados, as telas conferidas e o que falhou.
- Cada falha nova vira uma issue pelo formulário de bug, com o cenário e os passos.
