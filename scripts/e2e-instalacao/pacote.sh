# shellcheck shell=bash
# ============================================================
# Cenário E do rodar.sh: o pacote .deb de ponta a ponta (F9, ADR 0042 a 0050).
#   E1 · Debian 12 com systemd: apt install, painel da pessoa (serviço de usuário), botão
#        Atualizar pela regra do polkit, versão quebrada que volta sozinha, desinstalar e purge
#   E2 · Ubuntu 24.04 sem systemd: apt install, painel em segundo plano, executor rodado à mão
#        (verificar, atualizar e voltar), desinstalar e purge
#
# Só roda dentro do rodar.sh (usa log, ok, confere, em, cliente, versao, assina…).
# O pacote sai do npm run empacotar-deb, de uma cópia do HEAD com a chave de TESTE no
# docs/allowed_signers (o pacote leva essa lista como as chaves de partida). As versões 2.90.x
# ficam acima de qualquer versão real.
#
# Sem rede para as versões: o executor só aceita https ou file, e o git recusa buscar num
# repositório de outro dono. As tags vão então por um git bundle, numa pasta montada só para
# leitura em /srv/e2e, e o remote do repo.git aponta para ele antes da 1ª procura (o executor
# só grava o endereço do GitHub quando cria o repo.git). O Node vem do nodejs.org, como na
# instalação de verdade.
# ============================================================

log "E · pacote .deb: instalar, atualizar, voltar, desinstalar e apt purge"
OFERTA="$OUT/oferta"
mkdir -p "$OFERTA" && chmod 755 "$OFERTA"
rm -rf "$GIT/pacote"
git clone -q --no-hardlinks "$REPO" "$GIT/pacote"
git -C "$GIT/pacote" tag -l | xargs -r git -C "$GIT/pacote" tag -d >/dev/null
git -C "$GIT/pacote" config user.email teste@example.com && git -C "$GIT/pacote" config user.name "Mantenedor (teste)"
printf 'teste@example.com namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$OUT/assinatura.pub")" >> "$GIT/pacote/docs/allowed_signers"

# oferta: todas as tags num bundle novo (troca por rename: o executor nunca lê um pela metade).
oferta() {
  git -C "$GIT/pacote" bundle create "$OFERTA/.versoes.bundle" --tags 2>/dev/null
  chmod 644 "$OFERTA/.versoes.bundle" && mv -f "$OFERTA/.versoes.bundle" "$OFERTA/versoes.bundle"
}
# pacote_tag <versão> [quebrada]: commit e tag assinada; "quebrada" faz o painel sair ao ligar.
pacote_tag() {
  (cd "$GIT/pacote" && { [ "${2:-}" != quebrada ] || printf 'process.exit(1);\n' > server/index.js; } &&
    versao "$1" && git commit -qam "e2e: pacote $1" && assina "v$1")
  oferta
}
pacote_tag 2.90.0
if node "$REPO/scripts/empacotar-deb.mjs" --repo "$GIT/pacote" --ref v2.90.0 --saida "$OFERTA" >> "$OUT/log.txt" 2>&1; then
  chmod 644 "$OFERTA"/*.deb
  ok "E: pacote server-dashboard_2.90.0_all.deb gerado da tag de teste"
else
  falha "E: pacote gerado da tag de teste"
fi

raiz() { docker exec -u root "$1" bash -c "$2"; }
# O executor como o postinst o roda: usuário _server-dashboard, a partir de /.
executor() { raiz "$1" "cd / && runuser -u _server-dashboard -- /opt/server-dashboard/libexec/atualizador $2"; }
# apt install como depois de um "sudo": o postinst põe a conta do SUDO_USER no grupo.
apt_instala() {
  raiz "$1" "apt-get update -qq && SUDO_USER=ana DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /srv/e2e/server-dashboard_2.90.0_all.deb" > "$OUT/E-$1-apt.txt" 2>&1
}
# origem <contêiner>: o repo.git do executor busca as tags no bundle de teste.
origem() {
  raiz "$1" "cd / && runuser -u _server-dashboard -- env -i PATH=/usr/bin:/bin HOME=/nonexistent sh -c 'git init -q --bare /opt/server-dashboard/repo.git && git -C /opt/server-dashboard/repo.git remote add origin /srv/e2e/versoes.bundle'"
}
# instala_painel <contêiner> <porta do painel> <porta SSH> <identidade>: a pessoa instala o painel.
instala_painel() {
  em "$1" "install -d -m 700 .config/server-dashboard && (umask 077 && printf 'PORT=$2\n' > .config/server-dashboard/.env) && echo senha-de-teste | dashboard instalar --sem-interface --servidor 127.0.0.1 --porta $3 --usuario maria --identidade '$4' --senha-stdin --smart nenhum" > "$OUT/E-$1-instalar.txt" 2>&1
}
na_versao() { em "$1" "dashboard versao" | grep -q "$2"; }
coletas() { docker exec "$1" sh -c 'grep -c "poll OK" /home/ana/.local/share/server-dashboard/data/dashboard.log 2>/dev/null || echo 0'; }
disponivel() { raiz "$1" "grep -qx 'versao=$2' /opt/server-dashboard/estado/disponivel"; }
botao_pacote() {
  local token
  token=$(docker exec -u root "$1" sh -c "grep '^DASH_TOKEN=' /home/ana/.config/server-dashboard/.env | cut -d= -f2-")
  node "$HERE/botao.mjs" "http://127.0.0.1:$2" "$token" "$3" "$4" "$5"
}
# desinstala <contêiner> <servidor>: dashboard desinstalar da pessoa e depois o apt purge.
desinstala() {
  em "$1" "echo senha-de-teste | dashboard desinstalar --sim --limpar-servidor --usuario maria --senha-stdin" > "$OUT/E-$1-desinstalar.txt" 2>&1
  confere "E: $1: o desinstalar limpou o servidor" bash -c "! docker exec $2 id dashmon"
  confere "E: $1: o desinstalar apagou o .env e a chave da pessoa" bash -c "! docker exec $1 sh -c 'ls /home/ana/.config/server-dashboard/.env /home/ana/.ssh/dashboard-*'"
  raiz "$1" "DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq server-dashboard" > "$OUT/E-$1-purge.txt" 2>&1
  confere "E: $1: o apt purge apagou /opt/server-dashboard e o comando" bash -c "! docker exec $1 sh -c 'ls -d /opt/server-dashboard /usr/bin/dashboard'"
  confere "E: $1: o apt purge removeu o usuário e os 2 grupos" bash -c "! docker exec $1 sh -c 'getent passwd _server-dashboard || getent group _server-dashboard || getent group server-dashboard'"
  confere "E: $1: o histórico da pessoa ficou na pasta pessoal" docker exec "$1" sh -c 'ls /home/ana/.local/share/server-dashboard/data/history/*.ndjson'
}

servidor e2e-srv-pac-deb dash-e2e-servidor-debian 2205
servidor e2e-srv-pac-ubu dash-e2e-servidor-ubuntu 2206
cliente_systemd e2e-pac-sd dash-e2e-cliente-systemd -v "$OFERTA:/srv/e2e:ro"
cliente e2e-pac-ubu dash-e2e-cliente-ubuntu -v "$OFERTA:/srv/e2e:ro"
confere "E1: systemd de pé" timeout 60 bash -c "until docker exec -u ana e2e-pac-sd bash -lc 'systemctl --user is-system-running' 2>/dev/null | grep -q running; do sleep 1; done"

for c in e2e-pac-sd e2e-pac-ubu; do
  confere "E: $c: apt install do .deb" apt_instala "$c"
  confere "E: $c: dashboard versao na 2.90.0 (semente do pacote)" na_versao "$c" 2.90.0
  confere "E: $c: a conta do sudo entrou no grupo server-dashboard" bash -c "docker exec $c id -nG ana | grep -qw server-dashboard"
  confere "E: $c: código do root, versões do executor" raiz "$c" 'test "$(stat -c %U /opt/server-dashboard)" = root && test "$(stat -c %U /opt/server-dashboard/versoes/v2.90.0)" = _server-dashboard && test -x /opt/server-dashboard/node/bin/node'
  confere "E: $c: origem de teste no repo.git" origem "$c"
done
confere "E1: timer da procura diária ligado" raiz e2e-pac-sd 'systemctl is-active server-dashboard-verificar.timer'
# Como sair e entrar de novo na sessão: o serviço de usuário passa a ter o grupo novo.
raiz e2e-pac-sd 'systemctl restart user@$(id -u ana).service' >> "$OUT/log.txt" 2>&1 || true
confere "E1: systemd do usuário de pé depois de entrar de novo" timeout 60 bash -c "until docker exec -u ana e2e-pac-sd bash -lc 'systemctl --user is-system-running' 2>/dev/null | grep -q running; do sleep 1; done"

FP=$(identidade 2205)
confere "E1: a pessoa instala o painel" instala_painel e2e-pac-sd 3106 2205 "$FP"
confere "E1: serviço de usuário do painel no ar" docker exec -u ana e2e-pac-sd bash -lc 'systemctl --user is-active server-dashboard'
confere "E1: 2 coletas pelo painel do pacote" espera_coletas e2e-pac-sd .local/share/server-dashboard 2
FP=$(identidade 2206)
confere "E2: a pessoa instala o painel" instala_painel e2e-pac-ubu 3107 2206 "$FP"
confere "E2: 2 coletas pelo painel do pacote (segundo plano)" espera_coletas e2e-pac-ubu .local/share/server-dashboard 2

pacote_tag 2.90.1
# E1: a procura pela unidade, a troca pelo botão (systemd-run --user → polkit → unidade).
confere "E1: a unidade verificar achou a v2.90.1 no bundle" raiz e2e-pac-sd 'systemctl start server-dashboard-verificar.service'
confere "E1: estado/disponivel com a v2.90.1" disponivel e2e-pac-sd v2.90.1
# A recusa precisa vir do polkit (pede a senha do administrador), não de um polkit fora do ar.
confere "E1: polkit: a pessoa não inicia outra unidade do executor" bash -c "docker exec -u ana e2e-pac-sd systemctl --no-ask-password start server-dashboard-verificar.service 2>&1 | grep -q 'Interactive authentication required'"
ANTES=$(coletas e2e-pac-sd)
confere "E1: atualizou pelo botão" botao_pacote e2e-pac-sd 3106 v2.90.1 systemd atualizado
confere "E1: versão nova no link atual" na_versao e2e-pac-sd 2.90.1
confere "E1: painel coletando na versão nova" espera_coletas e2e-pac-sd .local/share/server-dashboard $((ANTES + 1))

# E2: sem systemd, a pessoa não troca a versão (o pedido à unidade falha) e o painel volta.
confere "E2: o executor achou a v2.90.1 no bundle" executor e2e-pac-ubu verificar
confere "E2: estado/disponivel com a v2.90.1" disponivel e2e-pac-ubu v2.90.1
em e2e-pac-ubu "dashboard atualizar --terminal" > "$OUT/E-ubu-atualizar.txt" 2>&1 || true
confere "E2: sem systemd, o atualizar da pessoa não troca a versão" grep -q "não trocou de versão" "$OUT/E-ubu-atualizar.txt"
confere "E2: continua na 2.90.0" na_versao e2e-pac-ubu 2.90.0
ANTES=$(coletas e2e-pac-ubu)
confere "E2: o painel voltou a coletar" espera_coletas e2e-pac-ubu .local/share/server-dashboard $((ANTES + 1))
# O executor à mão, como o administrador faria: atualizar e voltar, com o painel parado.
em e2e-pac-ubu "dashboard parar" >> "$OUT/log.txt" 2>&1 || true
confere "E2: executor atualizar" executor e2e-pac-ubu atualizar
em e2e-pac-ubu "dashboard iniciar" >> "$OUT/log.txt" 2>&1 || true
confere "E2: versão nova depois do executor" na_versao e2e-pac-ubu 2.90.1
ANTES=$(coletas e2e-pac-ubu)
confere "E2: painel coletando na versão nova" espera_coletas e2e-pac-ubu .local/share/server-dashboard $((ANTES + 1))
em e2e-pac-ubu "dashboard parar" >> "$OUT/log.txt" 2>&1 || true
confere "E2: executor voltar" executor e2e-pac-ubu voltar
em e2e-pac-ubu "dashboard iniciar" >> "$OUT/log.txt" 2>&1 || true
confere "E2: de volta à 2.90.0" na_versao e2e-pac-ubu 2.90.0
ANTES=$(coletas e2e-pac-ubu)
confere "E2: painel coletando depois de voltar" espera_coletas e2e-pac-ubu .local/share/server-dashboard $((ANTES + 1))

# E1: versão que não liga: o dashboard atualizar pede a unidade voltar e devolve os dados.
pacote_tag 2.90.2 quebrada
confere "E1: a unidade verificar achou a v2.90.2" raiz e2e-pac-sd 'systemctl start server-dashboard-verificar.service'
em e2e-pac-sd "dashboard atualizar --terminal" > "$OUT/E-sd-quebrada.txt" 2>&1 || true
confere "E1: a versão quebrada voltou sozinha" grep -q "não funcionou aqui" "$OUT/E-sd-quebrada.txt"
confere "E1: de volta à 2.90.1" na_versao e2e-pac-sd 2.90.1
confere "E1: serviço do painel de volta" docker exec -u ana e2e-pac-sd bash -lc 'systemctl --user is-active server-dashboard'
ANTES=$(coletas e2e-pac-sd)
confere "E1: painel coletando depois da volta" espera_coletas e2e-pac-sd .local/share/server-dashboard $((ANTES + 1))

desinstala e2e-pac-sd e2e-srv-pac-deb
confere "E1: o purge tirou as unidades do executor" bash -c "! docker exec e2e-pac-sd systemctl cat server-dashboard-atualizar.service"
desinstala e2e-pac-ubu e2e-srv-pac-ubu
