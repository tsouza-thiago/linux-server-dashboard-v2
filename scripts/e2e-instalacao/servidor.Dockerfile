# Servidor de teste (Debian ou Ubuntu): sshd, sudo e smartmontools, um administrador
# "maria" com senha. É o "servidor" da instalação de ponta a ponta (rodar.sh).
# Imagem presa por digest (A03): a tag pode mudar de imagem, o digest não. Para atualizar:
#   docker buildx imagetools inspect debian:12   (linha Digest)
ARG BASE=debian:12@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858
FROM ${BASE}
ARG PROXY=""
COPY ca.crt /tmp/ca.crt
RUN set -e; if [ -n "$PROXY" ]; then \
      printf 'Acquire::https::Proxy "%s";\nAcquire::https::CAInfo "/tmp/ca.crt";\n' "$PROXY" > /etc/apt/apt.conf.d/99proxy; \
      sed -i 's#http://\(deb.debian.org\|archive.ubuntu.com\|security.ubuntu.com\)#https://\1#g' /etc/apt/sources.list.d/*.sources /etc/apt/sources.list 2>/dev/null || true; fi; \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo smartmontools procps iproute2 \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99proxy
RUN useradd -m -s /bin/bash maria && echo 'maria:senha-de-teste' | chpasswd && usermod -aG sudo maria && mkdir -p /run/sshd
CMD ["/usr/sbin/sshd", "-D", "-e"]
