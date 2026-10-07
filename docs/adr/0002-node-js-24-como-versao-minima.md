# ADR 0002 — Node.js 24 como versão mínima

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

Node 18 e 20 estão fora de suporte (out/2026). A V2 quer usar recursos nativos (test runner com cobertura, `node:http` moderno) sem polyfills.

## Decisão

`engines.node >= 24`. O instalador baixa o Node 24 oficial para dentro da pasta da ferramenta (soma SHA-256 conferida, sem sudo) quando o do sistema faltar ou for antigo.

## Consequências

Distros sem Node 24 continuam suportadas via runtime embutido. A suíte da V1 foi validada no Node 24.21 antes de começar.
