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
2. Abra cada endereço numa aba nova. Feche as abas no fim.
3. O painel real (`http://127.0.0.1:3000`) só entra para conferir uma versão instalada, e só
   para leitura: nada de digitar o token, reconhecer alertas ou criar anotações.

## O que conferir

Em todas as telas, nos cenários `normal` e `lacunas`:

- O console não tem erro nem aviso de CSP.
- Nenhum pedido sai para outro endereço além do painel.
- O tema claro e o escuro (tecla `t`) deixam todo texto legível.

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

## Como registrar

- No PR: os cenários rodados, as telas conferidas e o que falhou.
- Cada falha nova vira uma issue pelo formulário de bug, com o cenário e os passos.
