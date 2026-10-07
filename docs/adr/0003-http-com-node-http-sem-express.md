# ADR 0003 — HTTP com `node:http`, sem Express

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

O Express 4 traz ~70 pacotes transitivos e 4 alertas do `npm audit` (1 crítico). A API do painel é pequena e local.

## Decisão

Servidor HTTP próprio sobre `node:http` com roteador mínimo, servidor de estáticos com lista de tipos permitidos e as proteções de `security.js` portadas 1:1 (testes de caracterização primeiro).

## Consequências

Backend com zero dependências de runtime; superfície de ataque menor; mais código próprio, coberto por testes de integração em porta efêmera.
