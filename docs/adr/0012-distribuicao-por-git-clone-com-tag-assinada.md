# ADR 0012 — Distribuição por `git clone` com tag assinada

- **Status:** Aceita
- **Data:** 07/10/2026

## Contexto

O mantenedor prefere manter a distribuição por `git clone`.

## Decisão

Tags de release assinadas com chave SSH do mantenedor (`allowed_signers` versionado) e conferidas pelo instalador; dependências de runtime (uPlot, fontes) versionadas com soma SHA-256; nada de `npm install` para quem só usa.

## Consequências

Exige `git` na máquina (o README traz o comando de 1 linha da distro). As releases da V2 passam a ser assinadas a partir da F7; `v1.0.0` é uma tag anotada sem assinatura.

## Como publicar uma release assinada (a partir da F7)

A interface do GitHub cria tags **leves, sem assinatura** — o instalador as ignora. A tag
de cada release é criada e assinada pelo mantenedor, na própria máquina, com a chave SSH
listada em `docs/allowed_signers`:

```bash
git fetch origin && git checkout <commit do merge>
git -c gpg.format=ssh -c user.signingkey=~/.ssh/id_ed25519.pub tag -s v2.0.0-alpha.N -m "v2.0.0-alpha.N"
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=docs/allowed_signers verify-tag v2.0.0-alpha.N
git push origin v2.0.0-alpha.N
```

Depois, no GitHub, a release é criada **escolhendo a tag já existente**. Trocar a chave
exige um commit em `docs/allowed_signers` assinado/feito antes da tag nova: quem já tem o
painel instalado só aceita a versão nova se a chave dela estiver na lista da versão
instalada.
