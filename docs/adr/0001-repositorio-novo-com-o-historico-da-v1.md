# ADR 0001 — Repositório novo com o histórico da V1

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

A V2 é uma reformulação completa. O mantenedor quer preservar a V1 intacta e, ao mesmo tempo, manter a rastreabilidade de tudo o que veio antes. O GitHub não permite fork de um repositório da própria conta para a mesma conta.

## Decisão

Criar `tsouza-thiago/linux-server-dashboard-v2` (público) com todo o histórico da V1 e a tag `v1.0.0` no último commit dela. O repositório original não recebe nenhuma mudança.

## Consequências

Histórico e autoria preservados; a V1 continua utilizável como está. O histórico importado já era público, então nada novo é exposto. A partir da V2 só IPs de documentação (RFC 5737) aparecem no repositório.
