# ADR 0010 — Frontend em ES modules nativos, sem bundler

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

Bundlers e transpiladores adicionam dependências e passos de build; o painel é pequeno.

## Decisão

ES modules nativos servidos como estão; template `html` com escape automático de toda interpolação (HTML cru só via `raw()` explícito).

## Consequências

Sem build; anti-XSS deixa de depender de disciplina manual.
