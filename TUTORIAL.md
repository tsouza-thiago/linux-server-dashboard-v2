# Tutorial — Linux Server Dashboard

Guia completo, passo a passo, para instalar, iniciar, parar e usar o **Linux Server Dashboard** —
o painel que mostra em tempo real o que está acontecendo com o seu servidor Linux
(ex.: um Debian modesto na sua rede local).

> **Para leigos:** se você nunca abriu um terminal, siga as seções **1**, **2** e **3**
> na ordem. Cada comando foi escrito para copiar e colar. Não precisa decorar nada.

---

## Índice

1. [O que é este programa?](#1-o-que-é-este-programa)
2. [Antes de começar (pré-requisitos)](#2-antes-de-começar-pré-requisitos)
3. [Instalação (assistente automático)](#3-instalação-assistente-automático)
4. [Iniciar o serviço](#4-iniciar-o-serviço)
5. [Parar o serviço](#5-parar-o-serviço)
6. [Como usar o dashboard](#6-como-usar-o-dashboard)
7. [Entendendo os números (glossário para leigos)](#7-entendendo-os-números-glossário-para-leigos)
8. [Alertas: o que significam e o que fazer](#8-alertas-o-que-significam-e-o-que-fazer)
9. [Solução de problemas](#9-solução-de-problemas)
10. [Dicas e boas práticas](#10-dicas-e-boas-práticas)

---

## 1. O que é este programa?

O **Linux Server Dashboard** é um "painel de controle" que fica no seu computador e mostra,
a cada 60 segundos, como está o seu servidor:

- uso de **CPU** (carga) e **memória RAM**;
- **temperatura** do processador;
- espaço livre em cada **disco** e previsão de quando podem encher;
- **tráfego de rede** (download/upload);
- **I/O dos discos** (leitura/escrita);
- **serviços** (smbd/nmbd ou outros) ativos ou parados;
- **saúde dos discos** (SMART);
- os **processos** que mais consomem memória;
- **alertas** quando algo está errado (disco quase cheio, temperatura alta, servidor fora do ar).

Como ele faz isso? Uma vez por minuto ele conecta no servidor por SSH, lê as informações
e mostra em gráficos. **O servidor não recebe nada** — só leitura, sem instalar nada nele.

### Por que o "índice de saúde"?

No canto inferior esquerdo há um círculo com uma nota de 0 a 100. Ele é calculado a partir
de uso de CPU, RAM, temperatura, discos e alertas ativos:

| Nota | Cor | Significado |
|------|-----|-------------|
| 80–100 | verde | saudável |
| 50–79 | amarelo | atenção |
| 0–49 | vermelho | crítico |

---

## 2. Antes de começar (pré-requisitos)

Só são necessários 3 itens, e normalmente já estão prontos neste computador:

1. **Node.js versão 18 ou mais nova** — é o "motor" do programa.
2. **O servidor ligado e na rede** (ex.: `ping 192.0.2.10`).
3. **O endereço do servidor** no formato `usuario@IP` (ex.: `root@192.0.2.10`).

> Não se preocupe com chave SSH: o instalador cria e configura tudo sozinho na seção 3.

### Como verificar (copie e cole no terminal)

```bash
node --version
```

Deve aparecer algo como `v18.x` ou `v20.x`, `v22.x`, etc. Se aparecer "command not found",
instale o Node.js antes de continuar:

- Baixe em https://nodejs.org (instalador do sistema), **ou**
- Use o gerenciador nvm: https://github.com/nvm-sh/nvm

Depois rode o `./install.sh` de novo.

---

## 3. Instalação (assistente automático)

A instalação é uma única vez. Depois disso, é só iniciar/parar quando quiser.

### Passo 1 — Entrar na pasta do projeto

```bash
cd ~/projeto/linux-server-dashboard
```

> Dica: este é o "endereço" do programa. Toda vez que precisar iniciar ou parar,
> comece por este comando.

### Passo 2 — Rodar o instalador (faz TUDO)

```bash
./install.sh
```

O instalador vai:

1. Conferir o Node.js e baixar as dependências (barra de progresso por alguns segundos);
2. Criar o arquivo de configuração `.env` e **gerar um token de acesso** (`DASH_TOKEN`)
   para proteger o painel;
3. **Testar a conexão SSH** com o servidor;
4. Se ainda não estiver configurada, abre o **assistente SSH** (interativo). Ele pergunta
   primeiro se você já tem um **alias SSH** configurado:

   ```
   Já tem um alias SSH configurado em ~/.ssh/config? [s/N]
   ```

   - Se você já usa um alias (ex.: `meu-servidor` do `~/.ssh/config`), digite `s` e o nome
     do alias — pronto, ele usa o que já existe.
   - Caso contrário, aperte Enter e digite o servidor:

     ```
     Endereço do servidor (ex.: root@192.0.2.10, ou só o IP/host):
     ```

     Você pode digitar `root@192.0.2.10` **ou** só `192.0.2.10` (aí ele pergunta
     o usuário, padrão `root`). Depois informa a **porta SSH** (padrão 22).

   Ele mostra o **plano** (servidor, chave e alias que serão criados) e pede confirmação.
   Confirmando, gera a chave de acesso, **pede a senha do servidor uma única vez** (só
   para copiar a chave — a senha **não** fica salva em lugar nenhum) e cria o apelido.

   > Entrada inválida não quebra a instalação: ele pede de novo (Ctrl+C cancela).

5. No final, mostra o resumo (com o seu token de acesso) e um **menu de próximos passos**:
   iniciar em segundo plano, instalar como serviço (roda sempre), ver o tutorial ou sair.

> **Se der erro na cópia da chave**, anote o comando que ele mostrar e rode a seção 9
> ("Chave SSH quebrada").

### Passo 3 — Teste rápido (opcional, mas recomendado)

Para confirmar que o programa consegue falar com o servidor **sem abrir o navegador**:

```bash
node server/poller.js --once
```

Vai imprimir um bloco de informações do servidor (host, kernel, memória, discos...).
Se aparecer um JSON com `"ok": true`, está tudo pronto.

---

## 4. Iniciar o serviço

### Forma fácil (recomendada)

```bash
cd ~/projeto/linux-server-dashboard
./start.sh
```

### Em segundo plano (libera o terminal)

```bash
./start.sh --background
```

O painel continua rodando mesmo depois de fechar o terminal. Para parar, use o `./stop.sh`.

### Saber se está rodando em segundo plano

```bash
./start.sh --status
```

Mostra o PID e a porta, ou avisa que não está rodando.

### Rodar sempre (inicia sozinho no login)

```bash
./install.sh --install-service
```

Para o serviço continuar ativo mesmo sem abrir sessão gráfica:

```bash
loginctl enable-linger $USER
```

Gerir o serviço:

```bash
systemctl --user status  linux-server-dashboard
systemctl --user restart linux-server-dashboard
```

### O que deve acontecer

1. O terminal mostra uma mensagem parecida com:
   `dashboard em http://127.0.0.1:3000 — host: seu-host, intervalo: 60000ms`
2. A primeira coleta acontece imediatamente (deve aparecer `poll OK` em ~1 segundo).
3. Depois, uma nova coleta a cada 60 segundos.

### Abrindo o painel no navegador

Abra seu navegador (Firefox, Chrome...) e digite na barra de endereço:

```
http://localhost:3000
```

Pronto, o painel está aberto. **Deixe o terminal aberto** (no modo normal) — enquanto ele
estiver rodando, o painel funciona. Fechar a janela do navegador **não** para o serviço;
fechar o terminal sim (no modo `--background` ou systemd, nem isso é problema).

> Na **primeira vez**, o painel mostra uma tela de login pedindo o seu **token de acesso**
> (o que o instalador mostrou no final). Depois disso o navegador fica conectado por 30
> dias. Para sair, use **Ajuda → Sessão → Sair deste navegador**.

> O painel só é acessível neste computador (127.0.0.1). Ninguém mais na rede
> consegue abrir — isso é proposital e seguro.

### Como saber se está rodando

Com o serviço ativo, abra outro terminal e execute:

```bash
curl http://127.0.0.1:3000/api/status
```

Deve devolver um texto começando com `{"meta":{...` contendo `"online":true`.

---

## 5. Parar o serviço

### Forma fácil (recomendada)

```bash
cd ~/projeto/linux-server-dashboard
./stop.sh
```

O script encontra o processo, encerra com gentileza (SIGTERM) e confirma:

```
Parando Linux Server Dashboard (PID 12345)...
Serviço parado. O histórico foi preservado (data/history/).
```

### Se você iniciou no terminal (Ctrl+C)

No terminal onde o `./start.sh` está rodando, pressione `Ctrl+C`.

### Se instalou como serviço systemd

```bash
systemctl --user stop linux-server-dashboard
```

### Manualmente (se nenhum dos acima funcionar)

```bash
# Descobrir o PID do processo
pgrep -f "node server/index.js"

# Encerrar (troque 12345 pelo número que apareceu)
kill 12345
```

> **O que acontece com os dados ao parar?** Nada se perde. O histórico fica salvo
> em `data/history/` (72 h detalhadas) e `data/rollup/` (90 dias resumidos). Na próxima vez que iniciar, os gráficos continuam de onde
> pararam. Enquanto parado, apenas não há novas coletas.

> **O servidor é afetado?** Não. Parar o painel não altera nada no servidor.

---

## 6. Como usar o dashboard

O painel tem 8 telas, listadas na coluna esquerda (ou nas teclas `1` a `8`).

| Tela | O que mostra |
|------|--------------|
| **1 Visão geral** | Manchete de saúde em linguagem simples ("Servidor saudável" / "Atenção" / "Crítico" e por quê), cartões com mini-gráfico (processador, memória, disco mais cheio com previsão, temperatura, rede, serviços) e eventos recentes |
| **2 Recursos** | CPU % com espera de disco, load, RAM e swap, pressão (PSI) e temperatura; linha tracejada = pico do intervalo |
| **3 Armazenamento** | Espaço, inodes, SMART e **previsão de disco cheio** por ponto de montagem; leitura/gravação, ocupação e latência por disco |
| **4 Rede** | Vazão de entrada/saída, totais desde o boot, erros e descartes |
| **5 Processos & serviços** | Estado de cada serviço e os processos que mais usam memória, com filtro e ordenação |
| **6 Eventos** | Linha do tempo única de alertas, quedas e anotações; reconhecer/resolver; nova anotação; uptime de até 90 dias |
| **7 Relatórios** | Resumo por dia (fuso local) dos últimos 30 dias; exportação CSV/JSON; impressão |
| **8 Ajuda** | Guia rápido, atalhos, configuração ativa (só leitura) e sessão |

Dicas por tela:

- **Visão geral** responde "está tudo bem?" em uma frase. Se não estiver, diz o porquê
  ("RAM 92%", "SMART /dev/sda"). O número de 0 a 100 é só um detalhe.
- **Armazenamento** mostra "enche em ~N dias" quando há pelo menos ~1 dia de dados e o
  disco está crescendo; "estável" quando não cresce.
- **Eventos** junta tudo o que aconteceu. Alertas abertos podem ser **reconhecidos**
  (você viu) ou **resolvidos**; ao remover uma anotação, aparece **Desfazer** por 4 s.
- **Relatórios** agrupa por dia no fuso do seu computador.

### Interações comuns a todas as telas

**Interações em todas as telas:**

- **Período**: botões `1h` · `6h` · `24h` · `72h` · `7d` · `30d` · `90d` no topo (fica na URL).
- **Gráficos**: arrastar = aproximar um trecho · roda do mouse = zoom · duplo clique = voltar.
  O cursor fica sincronizado entre os gráficos da tela.
- **Atalhos**: `1`–`8` telas · `C` coletar agora · `T` tema · `N` nova anotação · `/` buscar processo · `?` ajuda.
- **Tema**: escuro é o padrão; o botão ◐ (ou `T`) alterna para o claro (fica salvo).
- **Anotações**: em Eventos, marque manutenções ("troquei o cooler"); viram linhas tracejadas nos gráficos.
- **Coletar agora**: força uma coleta imediata, sem esperar o minuto.

> A interatividade toda (filtros, zoom, ordenação) acontece **no seu navegador** —
> o servidor não é incomodado por nada disso. A única "conversa" com ele
> continua sendo 1 comando por minuto.

---

## 7. Entendendo os números (glossário para leigos)

| Termo | O que significa | Valor saudável |
|-------|-----------------|----------------|
| **Load (1/5/15)** | Carga do processador na média de 1, 5 e 15 min. Neste servidor (1 núcleo), 1,0 = 100% de uso | abaixo de 1,0 |
| **RAM usada** | Memória em uso agora | abaixo de 90% |
| **Swap usada** | Memória "emprestada" do disco. Se estiver subindo, falta RAM | 0 (zero) |
| **Temperatura** | Calor do processador em °C | abaixo de 60 °C |
| **Mbps** | Velocidade de download/upload (megabits por segundo) | — |
| **MB/s** | Velocidade de leitura/escrita dos discos | — |
| **SMART** | Autodiagnóstico de saúde do disco | `PASSED` |
| **Uptime** | Tempo ligado desde o último boot | — |
| **ETA** | Previsão de quando um disco vai encher (pela tendência de crescimento) | quanto mais longe, melhor |
| **Outage** | Período em que o servidor ficou inacessível | nenhum |

### Sinais de alerta que você deve conhecer

- **Load acima de 1,0** — o processador está saturado (muito trabalho para 1 núcleo).
- **RAM ≥ 90%** — quase sem memória; o sistema começa a usar swap e fica lento.
- **Swap subindo** — falta memória; considere fechar serviços pesados.
- **Temperatura ≥ 60 °C** — cuidado com o calor; verifique ventilação/poeira.
- **Disco ≥ 90%** — risco de encher; libere espaço (principalmente em `/`).
- **SMART ≠ PASSED** — disco pode estar morrendo; faça backup urgente.
- **Serviço monitorado parado** — algo que deveria estar no ar caiu.

---

## 8. Alertas: o que significam e o que fazer

| Alerta | Nível | O que fazer |
|--------|-------|-------------|
| `Disco X com NN% usado` | warning | Liberar espaço: apagar arquivos temporários, mover dados grandes para outros discos. Atenção em `/` (sistema). |
| `RAM usada em NN%` | warning | Verificar processos pesados na tela **Processos**. Fechar aplicações, ou reduzir carga. |
| `Temperatura CPU NN°C` | warning | Verificar ventilação do gabinete, poeira nos coolers, posição do computador. |
| `SMART /dev/sdX: ...` | critical | **Backup imediato** dos dados do disco. Pode ser falha física. |
| `Serviço X ...` | critical | Reiniciar o serviço no servidor (ex.: `ssh seu-host 'sudo systemctl restart smbd'`). |
| `Servidor inacessível: ...` | critical | Servidor desligado ou fora da rede. Verificar energia, cabo de rede: `ping 192.0.2.10`. O painel continua tentando a cada minuto e se recupera sozinho. |

**Regra de ouro:** warning = preste atenção, critical = aja.

---

## 9. Solução de problemas

### O painel não abre no navegador

- Confirme que o serviço está rodando (o terminal está com `./start.sh` ativo?).
- Confira a porta: se você mudou `PORT` no `.env`, use a nova porta na URL.
- Teste com `curl http://127.0.0.1:3000/api/status` (seção 4).
- Se aparecer **"Host não permitido (403)"**: abra por `http://localhost:3000`
  (outros endereços são bloqueados de propósito).

### "Servidor inacessível" (indicador offline, banner de alerta)

1. O servidor está ligado? `ping -c 3 192.0.2.10`
2. O SSH responde? `ssh seu-host 'uptime'`
3. Se voltou, o painel se recupera sozinho no próximo minuto (ou clique em **Coletar agora**).

### Chave SSH quebrada / pedindo senha

```bash
ssh seu-host 'echo ok'
```

- Se pedir senha: a chave não está sendo usada. O jeito mais simples é refazer o assistente:
  ```bash
  ./install.sh --configure
  ```
- Se der "Permission denied": a chave pública não está no servidor. Reautorize:
  ```bash
  ssh-copy-id -i ~/.ssh/dashboard_ed25519.pub seu-host
  ```
- Se pedir "yes/no" sobre a chave do servidor: é a primeira conexão. Digite `yes`
  (o instalador também aceita automaticamente com segurança).

### Gráficos vazios ("sem amostras")

- O histórico ficou vazio? Confira `ls -la data/history/` (deve haver um arquivo `.ndjson` de hoje com tamanho > 0).
- O período escolhido pode ser maior que o histórico disponível: selecione `1h`.
- Na primeira execução, aguarde 1-2 minutos para acumular amostras.

### A porta 3000 já está em uso

```bash
# Descobrir quem está usando
lsof -i :3000

# Opções: matar o processo antigo (kill <PID>) ou mudar a porta no .env (PORT=3001)
```

### Onde ver o que aconteceu (logs)

```bash
tail -f data/dashboard.log    # modo normal / systemd
tail -f data/nohup.log        # modo --background
```

Cada coleta registra uma linha: `poll OK (123ms) — amostras: 45` ou `poll FALHOU: ...`.

### Testar a coleta isolada (sem o painel)

```bash
node server/poller.js --once
```

Se isso funcionar e o painel não, o problema é do painel. Se isso falhar,
o problema é SSH/rede — os logs dirão o motivo.

---

## 10. Dicas e boas práticas

1. **Nunca instale nada no servidor** — o monitoramento é 100% leitura. O servidor
   tem hardware muito limitado (1 núcleo, pouca RAM); qualquer instalação pode travá-lo.
2. **Respeite o intervalo de 60s** — não mude `POLL_INTERVAL` para valores muito baixos
   (o programa já bloqueia abaixo de 10 segundos). O servidor responde 1 comando por minuto, por projeto.
3. **Discos SMR** — evite cópias massivas e aleatórias de arquivos no
   servidor; são lentos para reescrever.
4. **Anote os eventos** — quando fizer manutenção no servidor, use **Eventos → Nova
   anotação** (ou a tecla `N`). Daqui a semanas você saberá o que aconteceu naquele dia.
5. **Exporte relatórios** — em **Relatórios**, baixe CSV ou JSON do período escolhido.
   Dá para abrir no Excel/LibreOffice e comparar semanas diferentes.
6. **Fique de olho na previsão de disco** — em **Armazenamento**, "enche em ~N dias"
   avisa com antecedência, antes que vire alerta.
7. **Mantenha o histórico** — não apague `data/` por acidente; ele guarda 3 dias de
   amostras detalhadas, 90 dias resumidos e todo o histórico de alertas e anotações.
8. **Backup do histórico (opcional)** — se quiser guardar além de 90 dias, exporte CSV
   periodicamente ou copie as pastas `data/history/` e `data/rollup/` para outro lugar.
9. **Segurança na prática** — não torne o painel acessível fora do seu computador.
   O endereço local `127.0.0.1` é de propósito. Se precisar acessar de longe, use VPN.

---

*Linux Server Dashboard — monitoramento somente leitura via SSH, 1 coleta/min,
dashboard local em 127.0.0.1:3000. O servidor não instala nada.*