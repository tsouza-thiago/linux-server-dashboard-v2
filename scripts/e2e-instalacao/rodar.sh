#!/usr/bin/env bash
# ============================================================
# Instalação de ponta a ponta (critério de saída da F7), em contêineres:
#   A · Debian 12 limpo  → servidor Debian 12: --sem-interface, diagnosticar,
#       atualizar (tag assinada; a sem assinatura é ignorada) e desinstalar
#   B · Ubuntu 24.04 limpo → servidor Ubuntu 24.04: assistente no navegador
#       (Chromium daqui dirigindo os 6 passos) até o painel coletando
#   C · upgrade V1 → V2: a V1 (tag v1.0.0) roda de verdade e gera o data/ dela; a V2
#       importa (--importar-v1) e depois troca para a chave restrita (reconfigurar)
#
# Os "computadores" não têm Node: o ./dashboard baixa o Node 24 oficial e confere a soma.
# A release é uma cópia do HEAD com uma tag assinada por uma chave de TESTE (nada é
# publicado). Precisa de: docker, git, ssh-keygen, node e o playwright-core do npm ci.
#
#   scripts/e2e-instalacao/rodar.sh [pasta-de-saida]
#   E2E_PROXY=http://… E2E_CA=/caminho/ca.crt  só se a rede exigir proxy com CA própria
# ============================================================
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO/scripts/e2e-instalacao"
OUT="${1:-$(mktemp -d /tmp/dash-e2e-XXXXXX)}"
mkdir -p "$OUT/capturas"
PROXY="${E2E_PROXY:-}"
CHROMIUM="${CHROMIUM:-$(ls -d /opt/pw-browsers/chromium 2>/dev/null || true)}"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
PASSOU=()
FALHOU=()

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; PASSOU+=("$*"); }
falha() { printf '\033[31m✗\033[0m %s\n' "$*"; FALHOU+=("$*"); }
confere() { local desc="$1"; shift; if "$@" >>"$OUT/log.txt" 2>&1; then ok "$desc"; else falha "$desc"; fi; }
em() { local c="$1"; shift; docker exec -u ana "$c" bash -lc "$*"; }
envs=()
if [ -n "$PROXY" ]; then envs=(-e "https_proxy=$PROXY" -e "HTTPS_PROXY=$PROXY" -e "NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/proxy.crt"); fi

limpar() {
  docker rm -f e2e-srv-deb e2e-srv-ubu e2e-srv-v1 e2e-cli-deb e2e-cli-ubu e2e-cli-v1 >/dev/null 2>&1 || true
  [ -f "$OUT/gitd.pid" ] && kill "$(cat "$OUT/gitd.pid")" 2>/dev/null || true
}
trap limpar EXIT

log "Imagens (servidor e computador limpo, Debian 12 e Ubuntu 24.04)"
CTX="$OUT/contexto"
mkdir -p "$CTX"
cp "$HERE"/*.Dockerfile "$CTX/"
if [ -n "${E2E_CA:-}" ]; then cp "$E2E_CA" "$CTX/ca.crt"; else : > "$CTX/ca.crt"; fi
for base in debian:12 ubuntu:24.04; do
  t="${base%%:*}"
  # Já construída? Reaproveita (E2E_RECONSTRUIR=1 força), poupando o limite do Docker Hub.
  for papel in servidor cliente; do
    if [ -n "${E2E_RECONSTRUIR:-}" ] || ! docker image inspect "dash-e2e-$papel-$t" >/dev/null 2>&1; then
      docker build -q --network host --build-arg BASE="$base" --build-arg PROXY="$PROXY" -f "$CTX/$papel.Dockerfile" -t "dash-e2e-$papel-$t" "$CTX" >/dev/null
    fi
  done
done
ok "imagens prontas"

log "Release de teste: cópia do HEAD com tag assinada por uma chave de teste"
GIT="$OUT/git"
rm -rf "$GIT" && mkdir -p "$GIT"
ssh-keygen -q -t ed25519 -N '' -C mantenedor-teste -f "$OUT/assinatura"
git clone -q --no-hardlinks "$REPO" "$GIT/release"
cd "$GIT/release"
git config user.email teste@example.com && git config user.name "Mantenedor (teste)"
printf 'teste@example.com namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$OUT/assinatura.pub")" >> docs/allowed_signers
versao() { node -e "const f='package.json',p=JSON.parse(require('fs').readFileSync(f));p.version='$1';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"; }
assina() { git -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c user.signingkey="$OUT/assinatura" tag -s "$1" -m "$1 (e2e)"; }
versao 2.0.0-alpha.8 && git commit -qam "e2e: chave de teste" && assina v2.0.0-alpha.8
git commit -q --allow-empty -m "trabalho em andamento (sem tag)"
cd "$REPO"
git daemon --reuseaddr --export-all --base-path="$GIT" --port=9418 --listen=127.0.0.1 --detach --pid-file="$OUT/gitd.pid"
sleep 1
ok "release v2.0.0-alpha.8 assinada em git://127.0.0.1:9418/release"

servidor() { docker run -d --init --name "$1" --network host "$2" /usr/sbin/sshd -D -e -p "$3" >/dev/null; }
cliente() { docker run -d --init --name "$1" --network host "${envs[@]}" "$2" sleep infinity >/dev/null; }
identidade() { ssh-keyscan -t ed25519 -p "$1" 127.0.0.1 2>/dev/null | ssh-keygen -lf - | awk '{print $2}'; }
espera_coletas() { timeout 150 bash -c "until [ \"\$(docker exec $1 sh -c 'grep -c \"poll OK\" /home/ana/$2/data/dashboard.log 2>/dev/null || echo 0')\" -ge $3 ]; do sleep 3; done"; }

# ------------------------------------------------------------------ A · Debian 12
log "A · Debian 12 limpo → servidor Debian 12 (sem interface)"
servidor e2e-srv-deb dash-e2e-servidor-debian 2201
cliente e2e-cli-deb dash-e2e-cliente-debian
FP=$(identidade 2201)
confere "A: computador sem Node" bash -c "! docker exec e2e-cli-deb sh -c 'command -v node'"
em e2e-cli-deb "git clone -q git://127.0.0.1:9418/release linux-server-dashboard-v2 && cd linux-server-dashboard-v2 && printf 'PORT=3101\n' > .env && echo senha-de-teste | ./dashboard instalar --sem-interface --servidor 127.0.0.1 --porta 2201 --usuario maria --identidade '$FP' --senha-stdin --smart nenhum" | tee "$OUT/A-instalar.txt"
confere "A: fixou na versão assinada mais nova" grep -q "usando a versão assinada mais nova: v2.0.0-alpha.8" "$OUT/A-instalar.txt"
confere "A: assinatura conferida" grep -q "assinatura conferida" "$OUT/A-instalar.txt"
confere "A: Node 24 baixado e conferido" grep -q "baixado para .runtime/ e conferido" "$OUT/A-instalar.txt"
confere "A: servidor preparado (dashmon, chave restrita)" grep -q "servidor preparado" "$OUT/A-instalar.txt"
confere "A: 2 coletas pelo painel" espera_coletas e2e-cli-deb linux-server-dashboard-v2 2
em e2e-cli-deb "cd linux-server-dashboard-v2 && ./dashboard diagnosticar" | tee "$OUT/A-diagnosticar.txt" || true
confere "A: diagnóstico sem avisos nem erros" grep -q "nenhum aviso, nenhum erro" "$OUT/A-diagnosticar.txt"
confere "A: dashmon no servidor só com a chave restrita" docker exec e2e-srv-deb sh -c 'grep -q "^restrict,from=\"127.0.0.1\",command=" /home/dashmon/.ssh/authorized_keys'
cd "$GIT/release" && versao 2.0.0-alpha.9 && git commit -qam "e2e: alpha.9" && assina v2.0.0-alpha.9 && git tag v2.0.0-alpha.10 && cd "$REPO"
em e2e-cli-deb "cd linux-server-dashboard-v2 && ./dashboard atualizar && ./dashboard versao" | tee "$OUT/A-atualizar.txt"
confere "A: atualizou para a alpha.9 assinada (a alpha.10 sem assinatura foi ignorada)" grep -q "atualizado de v2.0.0-alpha.8 para v2.0.0-alpha.9" "$OUT/A-atualizar.txt"
confere "A: painel de volta depois de atualizar" espera_coletas e2e-cli-deb linux-server-dashboard-v2 3
em e2e-cli-deb "cd linux-server-dashboard-v2 && echo senha-de-teste | ./dashboard desinstalar --sim --limpar-servidor --usuario maria --senha-stdin" | tee "$OUT/A-desinstalar.txt"
confere "A: servidor limpo pelo desinstalar" bash -c "! docker exec e2e-srv-deb id dashmon"
confere "A: chave e configuração locais apagadas" bash -c "! docker exec e2e-cli-deb sh -c 'ls /home/ana/.ssh/dashboard_ed25519 /home/ana/linux-server-dashboard-v2/.env'"

# ------------------------------------------------------------------ B · Ubuntu 24.04
log "B · Ubuntu 24.04 limpo → servidor Ubuntu 24.04 (assistente no navegador)"
servidor e2e-srv-ubu dash-e2e-servidor-ubuntu 2202
cliente e2e-cli-ubu dash-e2e-cliente-ubuntu
em e2e-cli-ubu "git clone -q git://127.0.0.1:9418/release linux-server-dashboard-v2 && cd linux-server-dashboard-v2 && printf 'PORT=3102\n' > .env && ./dashboard versao"
docker exec -d -u ana e2e-cli-ubu bash -lc "cd linux-server-dashboard-v2 && ./dashboard instalar > /home/ana/instalar.log 2>&1"
timeout 120 bash -c "until docker exec e2e-cli-ubu grep -q 'código de uso único' /home/ana/instalar.log 2>/dev/null; do sleep 1; done"
CODE=$(docker exec e2e-cli-ubu sh -c "grep -o 'código de uso único: [A-Z0-9-]*' /home/ana/instalar.log | awk '{print \$NF}' | tr -d -")
if CHROMIUM="$CHROMIUM" node "$HERE/assistente.mjs" "http://127.0.0.1:3102/configurar#codigo=$CODE" 2202 "$OUT/capturas" > "$OUT/B-assistente.txt" 2>&1; then ok "B: 6 passos no navegador até o painel online"; else falha "B: assistente no navegador"; fi
cat "$OUT/B-assistente.txt"
docker exec e2e-cli-ubu cat /home/ana/instalar.log > "$OUT/B-instalar.txt" || true
confere "B: o terminal registrou o fim do assistente" grep -q "Tudo pronto. Pode fechar esta janela." "$OUT/B-instalar.txt"
em e2e-cli-ubu "cd linux-server-dashboard-v2 && ./dashboard diagnosticar" | tee "$OUT/B-diagnosticar.txt" || true
confere "B: diagnóstico sem erros" grep -q "nenhum erro" "$OUT/B-diagnosticar.txt"

# ------------------------------------------------------------------ C · V1 → V2
log "C · upgrade V1 → V2 (a V1 roda de verdade e gera o data/ dela)"
servidor e2e-srv-v1 dash-e2e-servidor-debian 2203
cliente e2e-cli-v1 dash-e2e-cliente-debian
git -C "$REPO" archive --format=tar --prefix=linux-server-dashboard/ v1.0.0 | docker exec -i -u ana e2e-cli-v1 tar -xf - -C /home/ana
em e2e-cli-v1 "git clone -q git://127.0.0.1:9418/release linux-server-dashboard-v2 && cd linux-server-dashboard-v2 && ./dashboard versao"
# Como a V1 deixava a máquina: chave com acesso completo (~/.ssh/dashboard_ed25519) e alias no ~/.ssh/config.
em e2e-cli-v1 "mkdir -p -m 700 .ssh && ssh-keygen -q -t ed25519 -N '' -C linux-server-dashboard -f .ssh/dashboard_ed25519 && printf 'Host dash-127_0_0_1\n  HostName 127.0.0.1\n  Port 2203\n  User maria\n  IdentityFile ~/.ssh/dashboard_ed25519\n  StrictHostKeyChecking accept-new\n' > .ssh/config && chmod 600 .ssh/config"
docker exec -i e2e-srv-v1 sh -c 'mkdir -p -m 700 /home/maria/.ssh && cat >> /home/maria/.ssh/authorized_keys && chmod 600 /home/maria/.ssh/authorized_keys && chown -R maria:maria /home/maria/.ssh' < <(docker exec e2e-cli-v1 cat /home/ana/.ssh/dashboard_ed25519.pub)
em e2e-cli-v1 "cd linux-server-dashboard && printf 'SSH_HOST=dash-127_0_0_1\nPOLL_INTERVAL=10000\nPORT=3103\nDISK_MOUNTS=/\nSERVICES=ssh\nDASH_TOKEN=token-de-teste-da-v1-123456\n' > .env && export PATH=\$HOME/linux-server-dashboard-v2/.runtime/node/bin:\$PATH && npm install --no-audit --no-fund --silent && ./start.sh --background"
confere "C: a V1 coletou 3 amostras" timeout 150 bash -c "until [ \"\$(docker exec e2e-cli-v1 sh -c 'grep -c \"poll OK\" /home/ana/linux-server-dashboard/data/nohup.log 2>/dev/null || echo 0')\" -ge 3 ]; do sleep 3; done"
em e2e-cli-v1 "\$HOME/linux-server-dashboard-v2/.runtime/node/bin/node -e \"fetch('http://127.0.0.1:3103/api/annotations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer token-de-teste-da-v1-123456'},body:JSON.stringify({text:'troquei o disco (anotação da V1)'})}).then(r=>console.log('anotação V1:',r.status))\""
em e2e-cli-v1 "cd linux-server-dashboard-v2 && ./dashboard instalar --importar-v1 /home/ana/linux-server-dashboard" | tee "$OUT/C-importar.txt"
confere "C: V1 parada" bash -c "! docker exec e2e-cli-v1 sh -c 'kill -0 \$(cat /home/ana/linux-server-dashboard/data/dashboard.pid) 2>/dev/null'"
confere "C: V2 no ar com a configuração da V1" grep -q "V2 no ar em http://127.0.0.1:3103" "$OUT/C-importar.txt"
confere "C: V2 coletando pelo alias da V1" espera_coletas e2e-cli-v1 linux-server-dashboard-v2 1
confere "C: histórico da V1 migrado (com backup)" docker exec e2e-cli-v1 sh -c 'ls /home/ana/linux-server-dashboard-v2/data/history.v1-migrado.json && ls /home/ana/linux-server-dashboard-v2/data/history/*.ndjson'
confere "C: anotação da V1 aparece na V2" em e2e-cli-v1 "\$HOME/linux-server-dashboard-v2/.runtime/node/bin/node -e \"fetch('http://127.0.0.1:3103/api/annotations',{headers:{Authorization:'Bearer token-de-teste-da-v1-123456'}}).then(r=>r.json()).then(j=>process.exit(JSON.stringify(j).includes('anotação da V1')?0:1))\""
confere "C: pasta da V1 intacta (pronta para voltar)" docker exec e2e-cli-v1 sh -c 'test -f /home/ana/linux-server-dashboard/data/history.json && grep -q dash-127_0_0_1 /home/ana/linux-server-dashboard/.env'
FP=$(identidade 2203)
ANTES=$(docker exec e2e-cli-v1 sh -c 'grep -c "poll OK" /home/ana/linux-server-dashboard-v2/data/dashboard.log')
em e2e-cli-v1 "cd linux-server-dashboard-v2 && echo senha-de-teste | ./dashboard reconfigurar --sem-interface --servidor 127.0.0.1 --porta 2203 --usuario maria --identidade '$FP' --senha-stdin --smart nenhum" | tee "$OUT/C-reconfigurar.txt"
confere "C: reconfigurado para a chave restrita (chave nova, não a da V1)" docker exec e2e-cli-v1 sh -c 'grep -q "^SSH_ACESSO=restrito" /home/ana/linux-server-dashboard-v2/.env && grep -q dashboard_v2_ed25519 /home/ana/linux-server-dashboard-v2/data/ssh/config'
confere "C: coleta pela chave restrita" espera_coletas e2e-cli-v1 linux-server-dashboard-v2 $((ANTES + 1))
em e2e-cli-v1 "cd linux-server-dashboard-v2 && ./dashboard diagnosticar" | tee "$OUT/C-diagnosticar.txt" || true
confere "C: diagnóstico sem erros depois do upgrade" grep -q "nenhum erro" "$OUT/C-diagnosticar.txt"

log "Resultado"
printf '%s passaram, %s falharam (saída em %s)\n' "${#PASSOU[@]}" "${#FALHOU[@]}" "$OUT"
for f in "${FALHOU[@]}"; do printf '  ✗ %s\n' "$f"; done
[ "${#FALHOU[@]}" -eq 0 ]
