# ADR 0018 — Disponibilidade só sobre o tempo medido

- **Status:** Aceita (mantenedor, 20/10/2026)
- **Data:** 20/10/2026
- **Substitui:** a regra de disponibilidade da [ADR 0006](0006-motor-de-alertas.md)
  ("Outages em log próprio": a janela da disponibilidade começa no 1º dado conhecido)
- **Issue:** #24

## Contexto

Hoje a disponibilidade de `/api/outages` vai do 1º dado conhecido até agora. Todo o tempo
dentro dessa janela conta como "no ar", menos as quedas registradas. O tempo em que **nenhum
painel estava coletando** (máquina desligada, painel parado) também conta como "no ar". Na
instalação do mantenedor, deu 99,96% em 8 dias quase sem medida. Em Eventos, a faixa de 90
dias pinta esses dias de verde ("sem problemas").

O painel já guarda o que precisa para saber quando estava medindo:

- as amostras brutas das últimas 72 h (`data/history/`, 1 por coleta);
- os agregados de 5 min por 90 dias (`data/rollup/`, com `n` amostras por balde);
- as quedas (`data/outages.ndjson`): o painel estava rodando e o servidor não respondia.

## Decisão

1. **Tempo medido** é a soma das faixas de 5 min (as mesmas dos agregados) que têm pelo
   menos 1 amostra, bruta ou agregada, **ou** que tocam uma queda registrada. Uma queda é
   tempo medido: o painel estava rodando e tentando coletar.
2. **Disponibilidade** = 100 − (tempo fora do ar ÷ tempo medido × 100), no intervalo pedido.
   Sem tempo medido no intervalo, a disponibilidade é `null` ("sem dados"), nunca 100%.
3. `/api/outages` passa a devolver também `monitored`: a lista dos intervalos medidos
   `[{ from, to }]` no período pedido, com as faixas vizinhas já juntadas. O campo
   `uptime` ganha `monitoredMs`, e `windowMs` continua (o período pedido). Os campos de hoje
   continuam iguais.
4. **Telas** (Visão geral, Eventos e Relatórios) usam a mesma regra, a partir de
   `monitored`:
   - um dia **sem nenhum tempo medido** aparece como **"sem dados"** (cinza) na faixa de
     90 dias de Eventos e no relatório por dia;
   - um dia medido só em parte é avaliado só na parte medida (queda → crítico, alerta de
     atenção → atenção, senão sem problemas);
   - a disponibilidade de 90 d da Visão geral, a de Eventos e a dos Relatórios saem da
     mesma conta.
5. A Ajuda explica a regra em 1 frase: "a disponibilidade conta só o tempo em que o painel
   estava medindo".

## Consequências

- A disponibilidade deixa de ser inflada pelo tempo sem coleta. Com pouca medida, ela pode
  cair ou ficar "sem dados", e isso é o certo.
- A granularidade é de 5 min: uma coleta isolada conta 5 min de tempo medido. É a mesma
  resolução dos agregados de 90 dias; mais fino que isso só existiria nas últimas 72 h.
- **Limite conhecido:** se o painel parar **durante** uma queda, o tempo até ele voltar
  continua contado como queda (o registro só tem o início e o fim). É o mesmo comportamento
  de hoje. Resolver isso exige gravar as tentativas, e fica fora desta decisão.
- Nada muda no formato de `data/`, na configuração nem no acesso ao servidor: sai como
  funcionalidade, na `2.1.0-rc.1` (ADR 0015).
- Os testes cobrem: uma lacuna no histórico não entra na disponibilidade, o dia sem medida
  aparece como "sem dados", e as 3 telas dão o mesmo número.
