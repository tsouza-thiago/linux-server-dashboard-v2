# ADR 0028 — Comando no PATH por link simbólico

- **Status:** Aceita
- **Data:** 30/10/2026

## Contexto

Os comandos só rodavam de dentro da pasta do projeto, com `./dashboard` (#87). O script já
resolve a própria pasta com `readlink -f`, então um link simbólico basta. Faltava decidir onde
ele fica, o que fazer com conflitos de nome, como tratar uma pasta fora do PATH e como as
mensagens citam o comando.

## Decisão

1. **Link em `~/.local/bin/dashboard`**, sem sudo, criado nos 3 modos de instalação.
   `--sem-link` pula. `/usr/local/bin` exigiria sudo e fica para o pacote `.deb` (F9).
2. **Conflitos:** link desta pasta, nada a fazer. Link de outra pasta do painel: a tela pergunta,
   com a resposta padrão "não"; no `--sem-interface`, fica como está. Outro programa: nunca é
   sobrescrito. Link quebrado que termina em `/dashboard`: é refeito, porque o destino sumiu e
   ele não roda nada. Outro `dashboard` antes no PATH: a instalação avisa qual vai rodar.
3. **PATH:** se a pasta falta, mas o arquivo de login já a cita, a instalação só explica que vale
   no próximo login. Senão, pergunta. Com o sim, faz uma cópia e acrescenta um bloco marcado no
   arquivo que o bash lê no login. O bloco é POSIX, só age se a pasta faltar e não se repete. A
   resposta padrão é "não": editar arquivo pessoal exige um sim de verdade, e o `--sem-interface`
   só edita com `--editar-profile`.
4. **`desinstalar`** remove o link só se ele aponta para esta pasta, e o bloco só nesse caso ou
   sem link. Com o link em outra pasta, os 2 ficam: a outra instalação ainda precisa deles.
5. **`reconfigurar` e `atualizar` não mexem em link que já existe.** O `reconfigurar` só oferece
   criar quando ele falta: é o caminho de quem instalou antes desta versão.
6. **Mensagens:** `out.cmd` (`server/cli/saida.js`) devolve `dashboard` quando esse nome, digitado
   agora, roda esta pasta: confere o 1º `dashboard` do PATH, e não só a existência do link.
7. **Só a CLI muda.** As telas do navegador e os logs do painel continuam com `./dashboard`. O
   serviço systemd não enxerga o PATH de login da pessoa, então o servidor não sabe o que vale no
   terminal dela. E `./dashboard` continua certo dentro da pasta, em qualquer caso.

## Consequências

- O comando vale de qualquer pasta, sem sudo, e a pessoa pode recusar cada passo.
- Com 2 pastas na máquina, o comando global vale para uma só. O `dashboard status` mostra a pasta
  que respondeu, e o `diagnosticar` avisa quando o link é de outra.
- O bloco cobre o bash e os shells que leem o `~/.profile`. Quem usa zsh ou fish precisa pôr
  `~/.local/bin` no PATH à mão; a instalação mostra o caminho completo do comando.
- Sem link não conta como aviso no `diagnosticar`: é escolha da pessoa.
