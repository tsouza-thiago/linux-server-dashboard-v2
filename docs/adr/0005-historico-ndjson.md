# ADR 0005 — Histórico NDJSON: 72 h brutas + 90 dias agregados

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

A V1 reescreve ~6,8 MB de JSON a cada minuto (~10 GB/dia no SSD local, B7) e a amostragem por passo esconde picos (B8).

## Decisão

Arquivos NDJSON append-only (1 por dia) para as amostras brutas de 72 h e agregados de 5 min (mín/máx/média) por 90 dias; `/api/history` agrega por balde no servidor.

## Consequências

Escrita de ~1,5 KB por minuto; picos preservados; uptime e ETA de 90 dias passam a ter dados. Migração idempotente da `data/` da V1, com backup.
