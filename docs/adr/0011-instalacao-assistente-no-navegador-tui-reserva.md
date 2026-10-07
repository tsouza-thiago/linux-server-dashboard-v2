# ADR 0011 — Instalação: assistente no navegador + TUI reserva

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

A instalação da V1 exige conhecimento técnico (IP, interface, discos, colar linhas no servidor).

## Decisão

Comando único no terminal que abre um assistente de 6 passos no navegador (boas-vindas, servidor, conectar, o que monitorar, preparar servidor, pronto), com detecção automática e preparação do servidor assistida ou manual. TUI no terminal com os mesmos passos. Comando `dashboard` substitui install/start/stop.

## Consequências

Leigos conseguem instalar; o assistente só existe durante a 1ª configuração, protegido por código de uso único.
