# shellcheck shell=bash
# Node.js do painel (ADR 0002, Q18): usa o Node 24+ do sistema ou, se faltar ou for antigo,
# baixa o Node 24 oficial para dentro da pasta (.runtime/node), sem sudo, e confere a soma
# SHA-256 fixada abaixo antes de extrair. Lido pelo ./dashboard (não executa nada sozinho).

NODE_VERSION="24.21.0"
NODE_MIN_MAJOR=24
# SHASUMS256.txt de https://nodejs.org/dist/v24.21.0/ (tarballs .tar.gz)
NODE_SHA256_x64="6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"
NODE_SHA256_arm64="724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"
NODE_DIST="${DASHBOARD_NODE_DIST:-https://nodejs.org/dist}"

# Versão principal de um binário do Node (0 se não roda).
node_major() {
  "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

# Arquitetura no nome do pacote oficial (vazio = sem pacote oficial para esta máquina).
node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "" ;;
  esac
}

# Baixa uma URL para um arquivo com o que existir na máquina: curl, wget ou python3.
download_file() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$out" "$url"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$url" "$out"
  else
    echo "sem curl, wget ou python3 para baixar o Node.js" >&2
    return 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Baixa, confere e instala o Node em "$1/.runtime/node". Nada é extraído se a soma não bater.
install_node_runtime() {
  local root="$1" arch expected name tmp got
  arch="$(node_arch)"
  if [ -z "$arch" ]; then
    echo "esta máquina ($(uname -m)) não tem pacote oficial do Node.js; instale o Node.js ${NODE_MIN_MAJOR} pela sua distribuição" >&2
    return 1
  fi
  if [ "$arch" = x64 ]; then expected="$NODE_SHA256_x64"; else expected="$NODE_SHA256_arm64"; fi
  expected="${DASHBOARD_NODE_SHA256:-$expected}"
  name="node-v${NODE_VERSION}-linux-${arch}"
  mkdir -p "$root/.runtime"
  chmod 700 "$root/.runtime"
  tmp="$(mktemp -d "$root/.runtime/baixando.XXXXXX")"
  if ! download_file "$NODE_DIST/v${NODE_VERSION}/${name}.tar.gz" "$tmp/node.tar.gz"; then
    rm -rf "$tmp"
    echo "não consegui baixar o Node.js ${NODE_VERSION} (sem internet?)" >&2
    return 1
  fi
  got="$(sha256_of "$tmp/node.tar.gz")"
  if [ "$got" != "$expected" ]; then
    rm -rf "$tmp"
    echo "o Node.js baixado não confere com a soma SHA-256 esperada; nada foi instalado" >&2
    return 1
  fi
  tar -xzf "$tmp/node.tar.gz" -C "$tmp"
  rm -rf "$root/.runtime/node"
  mv "$tmp/$name" "$root/.runtime/node"
  rm -rf "$tmp"
}

# Escolhe o Node: o da pasta (se já foi baixado), senão o do sistema (24+), senão baixa.
# Define NODE_BIN e NODE_ORIGEM (pasta | sistema | baixado).
ensure_node() {
  local root="$1" sys
  if [ -x "$root/.runtime/node/bin/node" ] && [ "$(node_major "$root/.runtime/node/bin/node")" -ge "$NODE_MIN_MAJOR" ]; then
    NODE_BIN="$root/.runtime/node/bin/node"; NODE_ORIGEM=pasta; return 0
  fi
  sys="$(command -v node 2>/dev/null || true)"
  if [ -n "$sys" ] && [ "$(node_major "$sys")" -ge "$NODE_MIN_MAJOR" ]; then
    NODE_BIN="$sys"; NODE_ORIGEM=sistema; return 0
  fi
  echo "Node.js ${NODE_MIN_MAJOR} não encontrado: baixando o oficial para .runtime/ (sem sudo)..." >&2
  install_node_runtime "$root" || return 1
  NODE_BIN="$root/.runtime/node/bin/node"; NODE_ORIGEM=baixado
}
