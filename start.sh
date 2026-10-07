#!/usr/bin/env bash
# ============================================================
# Linux Server Dashboard — start.sh
# Inicia o painel de monitoramento do servidor.
#
# Como usar (na pasta do projeto):
#   ./start.sh                    # primeiro plano (terminal preso)
#   ./start.sh --background       # segundo plano (libera o terminal)
#   ./start.sh --status           # mostra se está rodando em segundo plano
#
# Depois abra o navegador em: http://localhost:3000
# Para parar: Ctrl+C neste terminal, ou ./stop.sh em outro.
# ============================================================
set -e
cd "$(dirname "$0")"

BACKGROUND=0
STATUS=0
for arg in "$@"; do
  case "$arg" in
    --background|-b) BACKGROUND=1 ;;
    --status|-s) STATUS=1 ;;
    --help|-h)
      echo "Uso: ./start.sh [--background] [--status]"; exit 0 ;;
  esac
done

echo "== Linux Server Dashboard =="

# 1. Node.js instalado e versão mínima?
if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: Node.js não encontrado. Instale o Node.js 18+ (veja install.sh)."
  exit 1
fi
VER=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "$VER" -lt 18 ]; then
  echo "ERRO: Node.js $VER é muito antigo. Instale o Node.js 18+."
  exit 1
fi
echo "Node.js: $(node --version)"

# 2. Dependências instaladas (primeira vez)?
if [ ! -d node_modules ]; then
  echo "Instalando dependências (primeira vez)..."
  npm install
fi

# 3. Arquivo .env criado?
if [ ! -f .env ] && [ -f .env.example ]; then
  echo "Criando .env a partir de .env.example (valores padrão)..."
  cp .env.example .env
fi

# 4. Permissões restritas (segurança)
mkdir -p data
chmod 700 data
chmod 600 .env 2>/dev/null || true
chmod 700 data/history data/rollup 2>/dev/null || true
chmod 600 data/history/*.ndjson data/rollup/*.ndjson data/history*.json data/alerts.json data/annotations.json data/dashboard.log data/nohup.log data/dashboard.pid 2>/dev/null || true

# 5. Porta
PORT=$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
PORT=${PORT:-3000}
case "$PORT" in
  ''|*[!0-9]*)
    echo "ERRO: PORT no .env não é um número válido ('$PORT'). Use 1-65535."
    exit 1
    ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "ERRO: PORT fora do intervalo (1-65535): $PORT."
  exit 1
fi

# 5b. Status (--status): não exige porta livre
if [ "$STATUS" -eq 1 ]; then
  if [ -f data/dashboard.pid ]; then
    PID=$(cat data/dashboard.pid)
    if kill -0 "$PID" 2>/dev/null; then
      echo "Rodando em segundo plano (PID $PID) — http://localhost:$PORT"
      echo "Para parar: ./stop.sh"
    else
      echo "Arquivo de PID existe mas o processo não está rodando (PID $PID)."
      echo "Remova data/dashboard.pid ou inicie com ./start.sh --background"
    fi
  else
    echo "O painel não está rodando em segundo plano."
    echo "Inicie com: ./start.sh  ou  ./start.sh --background"
  fi
  exit 0
fi

# 5c. Porta livre?
if ! node -e "const n=require('net'),s=n.createServer();s.on('error',()=>{process.exit(1)});s.listen(${PORT},'127.0.0.1',()=>s.close(()=>process.exit(0)))"; then
  echo "ERRO: a porta $PORT já está em uso."
  echo "       Se for outro painel seu, pare-o com ./stop.sh."
  echo "       Ou mude a porta no .env (PORT=3001)."
  exit 1
fi

# 6. Servidor acessível via SSH? (aviso apenas — o painel se recupera sozinho)
SSH_HOST=$(grep -E '^SSH_HOST=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
SSH_HOST=${SSH_HOST:-seu-host}
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_HOST" 'echo ok' >/dev/null 2>&1; then
  echo "AVISO: o servidor não respondeu via SSH."
  echo "       Se o SSH_HOST ainda não foi configurado, rode:  ./install.sh"
  echo "       O painel inicia mesmo assim e mostra 'Servidor inacessível'."
  echo "       Teste manual: ssh $SSH_HOST 'echo ok'"
fi

# 7. Iniciar
if [ "$BACKGROUND" -eq 1 ]; then
  echo "Iniciando em segundo plano... PID salvo em data/dashboard.pid"
  nohup node server/index.js > data/nohup.log 2>&1 &
  echo $! > data/dashboard.pid
  chmod 600 data/nohup.log data/dashboard.pid 2>/dev/null || true
  echo "Painel rodando em http://localhost:$PORT"
  echo "Para parar: ./stop.sh   |   logs: tail -f data/nohup.log"
  exit 0
fi

echo "Iniciando... abra http://localhost:$PORT no navegador."
echo "Para parar: Ctrl+C neste terminal, ou ./stop.sh em outro."
echo
exec node server/index.js