# ADR 0008 — SSH restrito: usuário dedicado, comando forçado e sudo só para `smartctl -H`

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

O SMART exige root; a V1 falha em silêncio (ou gera alerta falso, B1) sem ele. Uma chave sem restrição dá shell completo.

## Decisão

Usuário `dashmon` sem senha; chave com `restrict,command="<coleta>"` e opção `from="<IP local>"`; sudoers com cada disco listado explicitamente (sem curinga) e validado por `visudo -c`. SMART checado 1x por hora. Hash da configuração na saída detecta linha desatualizada.

## Consequências

Mesmo com a chave vazada, ela só roda a coleta. Configuração feita uma vez, assistida ou manual, sempre exibida antes e reversível.
