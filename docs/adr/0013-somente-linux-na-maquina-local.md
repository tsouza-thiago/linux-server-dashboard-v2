# ADR 0013 — Somente Linux na máquina local

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

Suportar macOS/Windows multiplica casos de teste e caminhos de inicialização.

## Decisão

V2.0 suporta Debian, Ubuntu, Mint e Fedora, com início automático via systemd do usuário.

## Consequências

Outros sistemas podem entrar depois sem mudar a arquitetura.
