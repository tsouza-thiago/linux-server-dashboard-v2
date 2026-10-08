# Computador "limpo" (Debian ou Ubuntu) sem Node.js: só o que um desktop recém-instalado
# já traz (wget, openssh-client, python3) mais o git do comando de 1 linha do README.
ARG BASE=debian:12
FROM ${BASE}
ARG PROXY=""
COPY ca.crt /tmp/ca.crt
RUN set -e; if [ -n "$PROXY" ]; then \
      printf 'Acquire::https::Proxy "%s";\nAcquire::https::CAInfo "/tmp/ca.crt";\n' "$PROXY" > /etc/apt/apt.conf.d/99proxy; \
      sed -i 's#http://\(deb.debian.org\|archive.ubuntu.com\|security.ubuntu.com\)#https://\1#g' /etc/apt/sources.list.d/*.sources /etc/apt/sources.list 2>/dev/null || true; fi; \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates wget openssh-client python3 procps xz-utils \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99proxy \
 && if [ -n "$PROXY" ]; then cp /tmp/ca.crt /usr/local/share/ca-certificates/proxy.crt && update-ca-certificates >/dev/null; fi
RUN useradd -m -s /bin/bash ana
USER ana
WORKDIR /home/ana
