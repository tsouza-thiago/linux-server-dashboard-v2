# ADR 0006 — Motor de alertas com chave estável, histerese e debounce

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

Na V1 a chave do alerta é a mensagem, que contém o valor; cada poll cria um alerta novo (B3). Limiares são duplicados entre poller e UI.

## Decisão

Regras declarativas com chave estável por condição (ex.: `disk:/mnt/x:usage`), valor atualizado no mesmo alerta, histerese (dispara/limpa), debounce do offline (2 falhas) e limiares validados no `.env`. Índice de saúde derivado das mesmas regras. Outages em log próprio.

## Consequências

Fim do flapping e da inflação de alertas; uma única fonte de limiares.
