# ADR 0007 — Sessão por cookie no lugar do token na URL

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

A V1 envia o token na URL do SSE (`?token=`) e o pede via `prompt()`.

## Decisão

Token trocado uma vez por cookie de sessão HttpOnly + SameSite=Strict (30 dias, renovado com o uso), tela de login, "Sair" e "encerrar todas as sessões". Link de uso único ao fim da instalação.

## Consequências

SSE autenticado sem expor o token; mantém Host check, CSRF, CSP e comparação timing-safe.
