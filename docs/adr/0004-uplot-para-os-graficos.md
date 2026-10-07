# ADR 0004 — uPlot para os gráficos

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

Chart.js + plugins de zoom e anotação somam 3 dependências (~300 KB) e o eixo de categorias da V1 posiciona anotações errado (B10).

## Decisão

Usar uPlot (1 dependência, ~50 KB), feito para séries temporais, com eixo de tempo real, zoom e cursor sincronizado entre gráficos.

## Consequências

Faixas de telemetria sincronizadas ficam nativas; o arquivo do uPlot é versionado no repositório com soma SHA-256, sem `npm install` para quem só usa.
