#!/bin/sh
# Ajudante de senha do SSH (SSH_ASKPASS) usado só pela instalação: devolve a senha que o
# assistente recebeu e repassou em memória, pela variável de ambiente deste processo.
# Nada é gravado em disco. Ver server/setup/remoto.js.
printf '%s\n' "$DASHBOARD_SENHA_SSH"
