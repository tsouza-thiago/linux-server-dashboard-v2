# Computador "limpo" (Debian ou Ubuntu) sem Node.js: só o que um desktop recém-instalado
# já traz (wget, openssh-client, python3) mais o git do comando de 1 linha do README. O Ubuntu
# leva o bash-completion, e o Debian fica sem: o autocomplete precisa valer nos 2 casos. Com
# SYSTEMD=1, o computador liga pelo systemd, com a sessão de usuário sempre de pé (lingering): é
# nele que o botão Atualizar roda com `systemd-run --user` (cenário D do rodar.sh).
# Imagem presa por digest (A03): a tag pode mudar de imagem, o digest não. Para atualizar:
#   docker buildx imagetools inspect debian:12   (linha Digest)
ARG BASE=debian:12@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858
FROM ${BASE}
ARG BASE
ARG PROXY=""
ARG SYSTEMD=""
COPY ca.crt /tmp/ca.crt
RUN set -e; if [ -n "$PROXY" ]; then \
      printf 'Acquire::https::Proxy "%s";\nAcquire::https::CAInfo "/tmp/ca.crt";\n' "$PROXY" > /etc/apt/apt.conf.d/99proxy; \
      sed -i 's#http://\(deb.debian.org\|archive.ubuntu.com\|security.ubuntu.com\)#https://\1#g' /etc/apt/sources.list.d/*.sources /etc/apt/sources.list 2>/dev/null || true; fi; \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates wget openssh-client python3 procps xz-utils $(case "${BASE}" in ubuntu*) echo bash-completion;; esac) ${SYSTEMD:+systemd systemd-sysv dbus dbus-user-session libpam-systemd} \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99proxy \
 && if [ -n "$PROXY" ]; then cp /tmp/ca.crt /usr/local/share/ca-certificates/proxy.crt && update-ca-certificates >/dev/null; fi
RUN useradd -m -s /bin/bash ana \
 && if [ -n "$SYSTEMD" ]; then \
      mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/ana; \
      systemctl mask getty.target systemd-udevd.service systemd-udev-trigger.service systemd-networkd.service; \
      echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u)' >> /home/ana/.profile; fi
USER ana
WORKDIR /home/ana
