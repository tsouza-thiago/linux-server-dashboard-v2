# ADR 0021 — Instalação em servidor que só aceita chave SSH

- **Status:** Aceita
- **Data:** 24/10/2026
- **Complementa:** a [ADR 0011](0011-instalacao-assistente-no-navegador-tui-reserva.md) (instalação guiada) e a
  [ADR 0020](0020-varios-computadores-no-mesmo-servidor.md) (vários computadores)

## Contexto

Num servidor endurecido (SSH só por chave, sem senha, root sem login, chave do administrador
com passphrase e apelido no `~/.ssh/config`), a instalação não conseguia preparar o servidor
(#61):

- a mesma senha servia ao SSH e ao sudo. Com senha, o `runAdmin` desligava a chave
  (`PubkeyAuthentication=no`) e o servidor recusava;
- sem senha, a detecção não testava o sudo e mostrava "sem sudo para este usuário". O preparo
  assistido ficava bloqueado;
- o `-F /dev/null` ignorava o apelido do `~/.ssh/config` (`HostName`, `Port`, `User`,
  `IdentityFile`, `IdentityAgent`);
- sem senha, o ssh oferecia todas as chaves do agente: risco de `MaxAuthTries` e de
  banimento pelo fail2ban.

O hardening é a exceção: a entrada com senha continua o padrão.

## Decisão

1. **Uma escolha a mais no passo 2:** "Como você entra no servidor?". **Senha** é o padrão e
   fica igual às versões anteriores. **Chave SSH** pede o apelido do `~/.ssh/config`. A TUI
   pergunta o mesmo (Enter = senha) e o modo sem perguntas tem `--chave-ssh <apelido>`.
2. **O apelido é lido com `ssh -G`**, que calcula a configuração e não conecta. A tela mostra
   `HostName`, `Port`, `User`, `IdentityFile` e `IdentityAgent` para a pessoa conferir. A
   chave é a primeira `IdentityFile` que existe neste computador.
3. **A conexão continua isolada:** `-F /dev/null` com os valores do apelido explícitos,
   `-i <IdentityFile>`, `IdentitiesOnly=yes`, o `IdentityAgent` do apelido,
   `PreferredAuthentications=publickey`, `BatchMode=yes` e o `known_hosts` do painel.
   `ProxyJump` e `ProxyCommand` são recusados com mensagem clara: a coleta conecta direto,
   então a instalação também. Caminho com `%` ou `$` também é recusado (o ssh o expandiria de
   novo).
4. **A passphrase fica só no ssh-agent.** O painel compara o `ssh-add -L` com o `.pub` da
   chave. Se a chave faltar, a tela mostra `ssh-add -t 15m <chave>` e "Tentar de novo". Chave
   sem passphrase não precisa do agente (o `ssh-keygen -y -P ''` confere). O painel nunca
   pede nem recebe a passphrase.
5. **A senha do sudo é separada da senha do SSH.** A detecção usa a resposta do `sudo -n`:
   sem senha, quem "pede senha" fica `pede-senha` (antes, "sem sudo"). A senha do sudo é um
   campo próprio do passo 5, pedido só quando a detecção indica que o sudo precisa dela. Ela
   vai só pelo stdin (`sudo -S -k`) e é descartada no fim do passo 5. No modo senha, a senha
   do SSH continua servindo ao sudo.
6. **`Defaults requiretty`** quebra o `sudo -S` sem terminal. A detecção o reconhece
   (`requiretty`) e a tela indica o modo "Prefiro fazer à mão". No preparo, o erro vira
   `@@erro tty`, nunca "senha errada".
7. **Conferência do sshd, só leitura**, no começo do script do preparo, antes de qualquer
   mudança: `sshd -T -C user=dashmon,host=<IP>,addr=<IP>`. Ela avisa se `AllowUsers`,
   `AllowGroups`, `DenyUsers`, `DenyGroups`, `AuthenticationMethods`,
   `PubkeyAuthentication`, `MaxAuthTries` ou `AuthorizedKeysFile` vão barrar o `dashmon`. O
   painel nunca altera o `sshd_config`: a pessoa decide. No modo manual, a falha do teste da
   chave mostra o mesmo comando para a pessoa rodar.
8. **`./dashboard desinstalar`** também entra por chave (`--chave-ssh <apelido>`, ou o
   apelido na pergunta). O endereço continua o do painel, conferido no `known_hosts`; o
   apelido só dá o usuário, a chave e o agente. A senha pedida é só a do sudo.

## Consequências

- O painel instala num servidor que só aceita chave, sem editar o `authorized_keys` à mão.
- O `ssh -G` lê o `~/.ssh/config` inteiro da pessoa, inclusive `Match exec`. Ele é da própria
  pessoa e roda como ela, como o `ssh` dela rodaria. Só os valores do apelido passam para a
  conexão.
- A chave de coleta continua sem passphrase: o painel coleta sozinho, sem ninguém para
  digitar. Ela é protegida por `restrict`, `command=` e `from=` (ADR 0008).
- O ssh-agent precisa ter a chave durante a instalação. O `-t 15m` sugerido tira a chave do
  agente sozinho depois.
- A conferência do sshd é um aviso, não uma trava: uma regra que o painel não entende não
  impede o preparo.
