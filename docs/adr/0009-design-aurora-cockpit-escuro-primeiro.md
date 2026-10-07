# ADR 0009 — Design "Aurora + Cockpit", escuro primeiro

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

O mantenedor pediu um visual moderno e robusto; três direções foram comparadas em pranchetas.

## Decisão

Tema escuro padrão e referência de todas as decisões de cor; claro derivado dos mesmos tokens. Geist + Geist Mono servidas localmente; brilho só nos dados; status com cor + ícone + texto; cores de série validadas para daltonismo e contraste nos dois temas; texto >= 4,5:1.

## Consequências

Tokens e regras documentados no plano (seção 3) viram `public/css/tokens.css` na F6.
