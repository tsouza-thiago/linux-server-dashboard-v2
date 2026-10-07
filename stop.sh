#!/usr/bin/env bash
# ============================================================
# Linux Server Dashboard — stop.sh
# Para o painel de monitoramento com segurança.
#
# Como usar (na pasta do projeto):
#   ./stop.sh
#
# O histórico fica salvo em data/history/ e data/rollup/ — nada se perde.
# O servidor monitorado não é afetado.
# ============================================================
cd "$(dirname "$0")"

PORT=$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
PORT=${PORT:-3000}

PID=""

# 1. PID file (usado pelo ./start.sh --background)
if [ -f data/dashboard.pid ]; then
  PID=$(cat data/dashboard.pid 2>/dev/null | tr -d ' ')
  rm -f data/dashboard.pid
  if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
    PID=""
  fi
fi

# 2. Encontrar o processo do painel (node server/index.js)
if [ -z "$PID" ]; then
  PID=$(pgrep -f "node server/index.js" | head -1)
fi

# 3. Fallback: quem está escutando na porta do painel?
if [ -z "$PID" ] && command -v lsof >/dev/null 2>&1; then
  PID=$(lsof -t -i ":$PORT" 2>/dev/null | head -1)
fi

if [ -z "$PID" ]; then
  echo "O painel não está rodando (nada a parar)."
  exit 0
fi

echo "Parando Linux Server Dashboard (PID $PID)..."
kill "$PID" 2>/dev/null

# Aguarda até 5 segundos para o encerramento limpo
for _ in 1 2 3 4 5; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Serviço parado. O histórico foi preservado (data/history/)."
    exit 0
  fi
  sleep 1
done

echo "Encerramento lento — forçando..."
kill -9 "$PID" 2>/dev/null
echo "Serviço parado (forçado)."