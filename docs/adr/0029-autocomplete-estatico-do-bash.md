# ADR 0029 — Autocomplete estático do bash

- **Status:** Aceita
- **Data:** 30/10/2026

## Contexto

Comandos e opções do `dashboard` eram digitados à mão (#88). Faltava decidir como o bash descobre
as sugestões, como a lista fica igual ao código, onde o arquivo fica e o que fazer em quem não tem o
pacote `bash-completion`.

## Decisão

1. **Arquivo estático** `scripts/completar.bash`, sem chamar a CLI. O `./dashboard` garante o Node
   antes de rodar, o que custaria dezenas de ms a cada Tab. Só bash: zsh e fish ficam fora, e o
   arquivo isolado deixa outro shell entrar depois sem mexer nele.
2. **Sincronia por teste:** `test/unit/autocomplete.test.js` roda o arquivo num bash de verdade e
   compara os comandos com `COMMAND_NAMES` e as opções com o que o código lê. Quais opções recebem
   valor sai do `parseFlags`. Comando ou opção nova sem autocomplete reprova o `npm run check`.
3. **Nada do `~/.ssh/config` é executado.** O `compgen -W` expandiria `$(...)` escrito no arquivo,
   por isso os apelidos são filtrados em bash puro. E só passam nomes `[A-Za-z0-9_.-]`: o Tab cola a
   sugestão na linha, e um `$(...)` colado rodaria no Enter. Sem aspas, curingas nem negação. O
   `Include` fica de fora: a 1ª versão lê só o arquivo principal.
4. **Instalação por link**, na pasta que o `bash-completion` consulta sozinho
   (`BASH_COMPLETION_USER_DIR` ou `XDG_DATA_HOME`, senão `~/.local/share`), sem sudo e com as regras
   de conflito da ADR 0028. O link acompanha o `atualizar`, sem nenhum passo a mais.
5. **Junto com o comando:** o `--sem-link` e a chave desligada pulam os 2, e `dashboard` de outro
   programa também pula o autocomplete, para não sugerir opções a ele.
6. **Sem o pacote,** a instalação pergunta e, com o sim, acrescenta no `~/.bashrc` um bloco marcado
   que carrega o link, com as garantias do bloco do PATH. A resposta padrão é "não", e é uma pergunta
   separada: o sim para o arquivo de login não vale para o `~/.bashrc`. No `--sem-interface`, a única
   forma de dizer sim às 2 é o `--editar-profile`. Sem o sim, a instalação e o `diagnosticar`
   mostram a linha `source`.
7. **`desinstalar`** remove o link só se ele aponta para esta pasta. O bloco do `~/.bashrc` segue a
   regra do bloco do PATH: com o comando em outra pasta, fica.
8. **O `diagnosticar` não conta aviso aqui:** o painel funciona igual sem o autocomplete.

## Consequências

- O Tab responde na hora e funciona em `dashboard` e em `./dashboard`, com o pacote ou sem ele.
- A presença do pacote é conferida pelo arquivo dele, não pelo shell em uso. Num Debian com a carga
  comentada no `~/.bashrc`, o painel acha que o Tab vale, e não vale em terminal que não é de login.
  O TUTORIAL explica o que fazer.
- O bash só carrega o link num terminal novo.
