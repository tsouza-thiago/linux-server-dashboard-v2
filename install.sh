#!/usr/bin/env bash
# ============================================================
# Linux Server Dashboard — install.sh
# Configura TUDO sozinho: dependências, .env, acesso SSH e,
# opcionalmente, um serviço systemd em segundo plano.
#
# Como usar (na pasta do projeto):
#   ./install.sh                      # fluxo completo (recomendado)
#   ./install.sh --manual             # pula o assistente SSH (já configurado)
#   ./install.sh --auto               # só deps + .env + token (não-interativo)
#   ./install.sh --configure          # só o assistente SSH (ajustar servidor)
#   ./install.sh --install-service    # cria e ativa o serviço systemd
#   ./install.sh --uninstall-service  # remove o serviço systemd
#   ./install.sh --test               # roda a suíte de testes
#
# Depois: ./start.sh (ou ./start.sh --background)
# ============================================================
set -e
cd "$(dirname "$0")"

# Funções puras de validação (segurança) — espelham server/config.js
source ./install-lib.sh

ROOT="$(pwd)"
SERVICE_NAME="linux-server-dashboard"
SERVICE_UNIT="$HOME/.config/systemd/user/$SERVICE_NAME.service"
KEY=~/.ssh/dashboard_ed25519
DASH_TOKEN_GENERATED=""
MENU_NEXT=0

log()  { echo "== $*"; }
die()  { echo; echo "ERRO: $*"; echo; exit 1; }

usage() {
  cat <<'EOF'
Uso: ./install.sh [opções]

  (sem opções)   fluxo completo (deps + .env + token + SSH + menus)
  --manual       só dependências + .env (você já tem SSH configurado)
  --auto         não-interativo: deps + .env + DASH_TOKEN (sem assistente SSH)
  --configure    só o assistente SSH (trocar o servidor)
  --install-service     cria/ativa o serviço systemd (roda sempre)
  --uninstall-service   remove o serviço systemd
  --test         roda a suíte de testes
  --help         esta ajuda
EOF
}

# ------------------------------------------------------------
# 1. Node.js
# ------------------------------------------------------------
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    cat <<'EOF'
ERRO: Node.js não está instalado.

Instale a versão 18 ou mais nova. Dois caminhos fáceis:
  - https://nodejs.org (baixar e instalar o instalador do sistema), ou
  - https://github.com/nvm-sh/nvm (gerenciador de versões)

Depois de instalar, rode ./install.sh novamente.
EOF
    exit 1
  fi
  local ver
  ver=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
  if [ "$ver" -lt 18 ]; then
    die "Node.js $ver é muito antigo. Instale a versão 18 ou mais nova."
  fi
  log "Node.js $(node --version) encontrado"
}

# ------------------------------------------------------------
# 2. Dependências
# ------------------------------------------------------------
ensure_deps() {
  if [ ! -d node_modules ]; then
    log "Instalando dependências (primeira vez)..."
    npm install --no-audit --no-fund
  else
    log "Dependências já instaladas (node_modules ok)"
  fi
}

# ------------------------------------------------------------
# 3. Arquivo .env
# ------------------------------------------------------------
ensure_env() {
  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      log "Criando .env a partir de .env.example (valores padrão)..."
      cp .env.example .env
    else
      die "Faltam os arquivos do projeto (.env.example). Baixe tudo de novo."
    fi
  else
    log ".env já existe — mantendo suas configurações"
  fi
  chmod 600 .env 2>/dev/null || true
}

# ------------------------------------------------------------
# 3b. DASH_TOKEN automático (segurança por padrão)
# ------------------------------------------------------------
ensure_token() {
  local tok
  tok="$(grep -E '^DASH_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')"
  if [ -n "$tok" ]; then
    DASH_TOKEN_GENERATED="$tok"
    log "DASH_TOKEN já definido no .env (mantendo)"
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    tok="$(openssl rand -hex 16)"
  else
    tok="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  [ -z "$tok" ] && tok="$(date +%s%N | sha256sum 2>/dev/null | cut -c1-32)"
  if grep -qE '^DASH_TOKEN=' .env; then
    sed -i "s|^DASH_TOKEN=.*|DASH_TOKEN=$tok|" .env
  else
    echo "DASH_TOKEN=$tok" >> .env
  fi
  chmod 600 .env
  DASH_TOKEN_GENERATED="$tok"
  log "DASH_TOKEN gerado automaticamente (veja no resumo final)"
}

# ------------------------------------------------------------
# 4. Pasta de dados (permissões restritas)
# ------------------------------------------------------------
ensure_data() {
  mkdir -p data
  chmod 700 data
  chmod 700 data/history data/rollup 2>/dev/null || true
  chmod 600 data/history/*.ndjson data/rollup/*.ndjson data/history*.json data/alerts.json data/annotations.json data/dashboard.log 2>/dev/null || true
  log "Pasta data/ pronta (permissões restritas)"
}

# ------------------------------------------------------------
# 5. Teste SSH (sem interação)
# ------------------------------------------------------------
ssh_host() {
  grep -E '^SSH_HOST=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' '
}
test_ssh() {
  local h
  h="$(ssh_host)"
  h=${h:-seu-host}
  if is_placeholder_host "$h"; then
    return 1
  fi
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$h" 'echo ok' >/dev/null 2>&1
}

# ------------------------------------------------------------
# 6. Assistente SSH (interativo, com menus e validação)
# ------------------------------------------------------------
write_ssh_config() {
  local alias_="$1" host_="$2" user_="$3" port_="$4"
  mkdir -p ~/.ssh
  chmod 700 ~/.ssh
  if [ -f ~/.ssh/config ] && grep -qE "^Host[[:space:]]+${alias_}\$" ~/.ssh/config; then
    log "Bloco '$alias_' já existe em ~/.ssh/config — mantendo"
    return
  fi
  {
    echo ""
    echo "# Linux Server Dashboard (criado por install.sh em $(date +%Y-%m-%d))"
    echo "Host $alias_"
    echo "    HostName $host_"
    echo "    User $user_"
    echo "    Port $port_"
    echo "    IdentityFile $KEY"
    echo "    StrictHostKeyChecking accept-new"
  } >> ~/.ssh/config
  chmod 600 ~/.ssh/config 2>/dev/null || true
  log "Bloco SSH '$alias_' adicionado a ~/.ssh/config"
}

set_env_host() {
  local alias_="$1"
  if grep -qE '^SSH_HOST=' .env; then
    sed -i "s|^SSH_HOST=.*|SSH_HOST=$alias_|" .env
  else
    echo "SSH_HOST=$alias_" >> .env
  fi
  chmod 600 .env
  log ".env atualizado: SSH_HOST=$alias_"
}

wizard_ssh() {
  echo
  echo "--- Assistente SSH ---"
  echo "Vou configurar o acesso ao seu servidor."
  echo "A senha do servidor é usada apenas para copiar a chave — NUNCA fica salva."
  echo

  # Caminho alternativo: alias já existente no ~/.ssh/config
  local use_alias=""
  read -rp "Já tem um alias SSH configurado em ~/.ssh/config? [s/N] " use_alias
  case "${use_alias:-n}" in
    s|S|sim|SIM|y|Y|yes|YES)
      local alias_in=""
      while :; do
        read -rp "Nome do alias (ex.: meu-servidor): " alias_in
        if valid_alias "$alias_in"; then
          break
        fi
        echo "Alias inválido (use letras minúsculas, números, _ e -)."
      done
      if is_placeholder_host "$alias_in"; then
        die "Esse nome parece ser um placeholder. Digite o alias real."
      fi
      if ssh -o BatchMode=yes -o ConnectTimeout=5 "$alias_in" 'echo ok' >/dev/null 2>&1; then
        log "Alias '$alias_in' funciona!"
        set_env_host "$alias_in"
        return 0
      fi
      die "O alias '$alias_in' não respondeu. Teste: ssh $alias_in 'echo ok'"
      ;;
  esac

  # Caminho completo: usuário + host (+ porta). Aceita usuario@host ou separado.
  local user_="" host_="" port_="22" input_=""
  while :; do
    read -rp "Endereço do servidor (ex.: root@192.0.2.10, ou só o IP/host): " input_
    [ -z "$input_" ] && { echo "Campo vazio. Ctrl+C para cancelar."; continue; }
    case "$input_" in
      *@*)
        user_="${input_%%@*}"
        host_="${input_#*@}"
        ;;
      *)
        user_=""
        host_="$input_"
        ;;
    esac
    if [ -z "$host_" ] || ! valid_host "$host_"; then
      echo "Host inválido. Use um IP ou hostname (ex.: 192.0.2.10)."; continue
    fi
    if [ -z "$user_" ]; then
      read -rp "Usuário do servidor [root]: " user_
      user_="${user_:-root}"
    fi
    if ! valid_user "$user_"; then
      echo "Usuário inválido (letras, números, . _ -)."; user_=""; continue
    fi
    break
  done
  if is_placeholder_host "$host_"; then
    echo "Atenção: esse valor parece ser um placeholder. Confirme o IP/host real."
  fi

  read -rp "Porta SSH [22]: " port_in
  if [ -n "$port_in" ]; then
    if valid_port "$port_in"; then
      port_="$port_in"
    else
      echo "Porta inválida (1-65535). Usando 22."
    fi
  fi

  # Alias derivado do host (mesmo formato de antes)
  ALIAS_="dash-$(printf '%s' "$host_" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_')"
  ALIAS_="${ALIAS_%%_}"
  ALIAS_="${ALIAS_##_}"

  # Confirmação antes de aplicar qualquer mudança
  echo
  echo "Plano:"
  echo "  Servidor:   $user_@$host_:$port_"
  echo "  Chave SSH:  $KEY (criada se ainda não existir)"
  echo "  Alias SSH:  $ALIAS_ (em ~/.ssh/config)"
  echo "  Arquivos:   ~/.ssh/config e .env (SSH_HOST)"
  local ok_=""
  read -rp "Continuar? [S/n] " ok_
  case "${ok_:-s}" in
    n|N|nao|não|no) die "Cancelado pelo usuário." ;;
  esac

  # Chave Ed25519 (só cria se ainda não existir)
  if [ -f "$KEY" ]; then
    log "Chave SSH já existe: $KEY"
  else
    log "Gerando chave Ed25519: $KEY"
    ssh-keygen -t ed25519 -f "$KEY" -C "linux-server-dashboard" -N "" >/dev/null
  fi
  chmod 600 "$KEY" 2>/dev/null || true

  # Copiar a chave pública para o servidor (pede a senha do servidor 1x)
  log "Copiando a chave para $user_@$host_ (digite a senha quando pedir)..."
  local copout
  if ! copout="$(ssh-copy-id -o ConnectTimeout=10 -i "$KEY.pub" -p "$port_" "$user_@$host_" 2>&1)"; then
    echo
    echo "Não consegui copiar a chave automaticamente."
    echo "--- Saída do ssh-copy-id: ---"
    echo "$copout"
    echo "---"
    echo "Se a cópia automática não for possível, faça manualmente:"
    echo "  ssh-copy-id -o ConnectTimeout=10 -i $KEY.pub -p $port_ $user_@$host_"
    echo "e depois rode:  ./install.sh --configure"
    exit 1
  fi
  log "Chave copiada para o servidor"

  write_ssh_config "$ALIAS_" "$host_" "$user_" "$port_"
  set_env_host "$ALIAS_"

  # Teste final
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$ALIAS_" 'echo ok' >/dev/null 2>&1; then
    log "Conexão SSH funcionando: ssh $ALIAS_ 'echo ok' -> ok"
  else
    die "O SSH ainda não respondeu. Teste manual: ssh $ALIAS_ 'echo ok'"
  fi

  # Aviso de segurança sobre configurações frágeis
  if grep -qs 'StrictHostKeyChecking[[:space:]]*no' ~/.ssh/config 2>/dev/null; then
    echo
    echo "AVISO: seu ~/.ssh/config tem 'StrictHostKeyChecking no' (sem checagem"
    echo "de identidade do servidor — risco de ataque do meio). O bloco criado"
    echo "pelo instalador usa 'accept-new', que é seguro."
    echo
  fi
}

# ------------------------------------------------------------
# 7. Serviço systemd (opcional)
# ------------------------------------------------------------
install_service() {
  command -v node >/dev/null 2>&1 || die "Node.js não encontrado."
  command -v systemctl >/dev/null 2>&1 || die "systemctl não encontrado (use ./start.sh --background)."
  NODE_BIN="$(command -v node)"
  mkdir -p "$HOME/.config/systemd/user"
  log "Criando serviço systemd em $SERVICE_UNIT"
  cat > "$SERVICE_UNIT" <<EOF
[Unit]
Description=Linux Server Dashboard
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/server/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
  chmod 600 "$SERVICE_UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME" 2>/dev/null || systemctl --user enable "$SERVICE_NAME"
  log "Serviço ativado: linux-server-dashboard"
  log "Para o serviço continuar rodando sem login, rode:"
  echo "    loginctl enable-linger \$USER"
  echo
  log "Gerenciar:"
  echo "    systemctl --user status  linux-server-dashboard"
  echo "    systemctl --user restart linux-server-dashboard"
  echo "    systemctl --user stop    linux-server-dashboard"
}

uninstall_service() {
  if [ -f "$SERVICE_UNIT" ]; then
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$SERVICE_UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    log "Serviço systemd removido."
  else
    log "Nenhum serviço systemd instalado."
  fi
}

# ------------------------------------------------------------
# 8. Fluxo de configuração comum (default / --manual / --auto)
# ------------------------------------------------------------
run_setup() {
  local mode="$1"
  check_node
  ensure_deps
  ensure_env
  ensure_token
  ensure_data
  log "Testando conexão SSH..."
  if test_ssh; then
    log "Conexão SSH OK ($(ssh_host))."
    return 0
  fi
  if [ "$mode" = "full" ]; then
    wizard_ssh
    if test_ssh; then
      log "Conexão SSH OK ($(ssh_host))."
    else
      log "Atenção: o SSH ainda não respondeu. Teste manual: ssh $(ssh_host) 'echo ok'"
    fi
  elif is_placeholder_host "$(ssh_host)"; then
    log "AVISO: SSH_HOST ainda é o modelo '$(ssh_host)'."
    log "       Rode ./install.sh (fluxo completo) para configurar o servidor."
  else
    log "AVISO: o servidor não respondeu via SSH. Verifique rede/chave."
  fi
}

# ------------------------------------------------------------
# 9. Resumo final de segurança
# ------------------------------------------------------------
security_check() {
  local env_mode data_mode
  env_mode="$(stat -c %a .env 2>/dev/null || echo '?')"
  data_mode="$(stat -c %a data 2>/dev/null || echo '?')"
  echo "  Segurança: .env=$env_mode | data/=$data_mode (esperado: 600 / 700)"
  if grep -qs 'StrictHostKeyChecking[[:space:]]*no' ~/.ssh/config 2>/dev/null; then
    echo "  AVISO: ~/.ssh/config contém 'StrictHostKeyChecking no' global —"
    echo "         o instalador usa 'accept-new', que é seguro."
  fi
}

# ------------------------------------------------------------
# 10. Menu de próximos passos (apenas fluxos interativos)
# ------------------------------------------------------------
next_steps() {
  echo
  echo "--- Próximos passos ---"
  echo "  1) Iniciar o painel em segundo plano  (recomendado)"
  echo "  2) Rodar sempre — instalar serviço systemd"
  echo "  3) Ver o tutorial (TUTORIAL.md)"
  echo "  4) Sair"
  local next=""
  read -rp "Escolha [1-4] (Enter = 1): " next
  case "${next:-1}" in
    1)
      log "Iniciando em segundo plano..."
      ./start.sh --background
      ;;
    2)
      install_service
      ;;
    3)
      if [ -f TUTORIAL.md ]; then
        if command -v less >/dev/null 2>&1; then less TUTORIAL.md; else cat TUTORIAL.md; fi
      fi
      ;;
    4|s|sair|q|quit)
      log "OK — tudo pronto. Para iniciar depois: ./start.sh --background"
      ;;
    *)
      log "Opção inválida. Para iniciar depois: ./start.sh --background"
      ;;
  esac
}

# ------------------------------------------------------------
# Fluxo principal
# ------------------------------------------------------------
case "$1" in
  --help|-h)
    usage
    exit 0
    ;;
  --install-service)
    check_node
    ensure_deps
    ensure_env
    ensure_token
    install_service
    exit 0
    ;;
  --uninstall-service)
    uninstall_service
    exit 0
    ;;
  --configure)
    check_node
    ensure_env
    ensure_token
    wizard_ssh
    MENU_NEXT=1
    ;;
  --test)
    check_node
    ensure_deps
    log "Rodando a suíte de testes..."
    npm test
    exit 0
    ;;
  --auto)
    run_setup auto
    ;;
  --manual)
    run_setup manual
    MENU_NEXT=1
    ;;
  "")
    run_setup full
    MENU_NEXT=1
    ;;
  *)
    usage
    exit 1
    ;;
esac

# ------------------------------------------------------------
# Resumo final
# ------------------------------------------------------------
echo
echo "======================================================="
echo "  Tudo pronto!"
echo "======================================================="
if [ -n "$DASH_TOKEN_GENERATED" ]; then
  echo
  echo "  Token de acesso (DASH_TOKEN): $DASH_TOKEN_GENERATED"
  echo "  Guarde-o — o navegador pedirá uma única vez."
fi
echo
echo "  Para iniciar agora:             ./start.sh"
echo "  Para iniciar em segundo plano:  ./start.sh --background"
echo "  Para parar:                     ./stop.sh"
echo "  Para rodar sempre (systemd):    ./install.sh --install-service"
echo
echo "  Abra o navegador em:            http://localhost:3000"
echo "  Tutorial completo:              TUTORIAL.md"
security_check
echo "======================================================="
echo

# Menu de próximos passos (só fluxos interativos/manual/configure)
if [ "$MENU_NEXT" -eq 1 ]; then
  next_steps
fi