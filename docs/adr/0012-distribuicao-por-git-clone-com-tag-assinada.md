# ADR 0012 — Distribuição por `git clone` com tag assinada

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

O mantenedor prefere manter a distribuição por `git clone`.

## Decisão

Tags de release assinadas com chave SSH do mantenedor (`allowed_signers` versionado) e conferidas pelo instalador; dependências de runtime (uPlot, fontes) versionadas com soma SHA-256; nada de `npm install` para quem só usa.

## Consequências

Exige `git` na máquina (o README traz o comando de 1 linha da distro). As releases da V2 passam a ser assinadas a partir da F7; `v1.0.0` é uma tag anotada sem assinatura.
