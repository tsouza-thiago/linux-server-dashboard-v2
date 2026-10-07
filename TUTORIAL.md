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

O painel tem 9 telas, listadas na coluna esquerda. Clique em cada item para trocar de tela.

### 🏠 Visão Geral (primeira tela)

É o "resumo do dia". Mostra, em cartões:

- **Load (1/5/15)** — a carga do processador agora, nos últimos 5 e 15 minutos
  (quanto menor, melhor; o valor deve ficar abaixo de 1,0).
- **Memória RAM** — memória em uso e total (ex.: `900 / 2000 MB`).
- **Swap** — memória de reserva no disco (deve ficar em 0).
- **Temperatura CPU** — limite de segurança: 60 °C (alerta) / 70 °C (crítico).
- **Uptime** — há quanto tempo o servidor está ligado.
- **Sistema** — número de núcleos e versão do kernel.

Abaixo, 4 gráficos: load, RAM, temperatura e uso dos discos.
E ainda: lista de discos (clique em um para ver detalhes), rede (download/upload) e
serviços com selo verde (ativo) ou vermelho (parado).

### 💾 Discos

- Um **cartão por disco** com % usado, espaço livre e **previsão de lotação** (ETA).
- Clique em um cartão para ver o gráfico de uso daquele disco.
- A previsão é feita pela tendência de crescimento: se o disco cresce
  `+0,5 GB/dia`, ele avisa em quantos dias vai encher. Se não cresce, mostra
  "Crescimento estável — sem previsão de lotação".
- O selo **SMART** mostra a saúde do disco: `PASSED` (bom) ou outro status (ruim).

### 🌐 Rede

- Download e upload em **Mbps** (megabits por segundo) — leitura/escrita em tempo real.
- Gráfico de tráfego de rede ao longo do tempo.
- Gráfico de **I/O por disco** (MB/s de leitura/escrita). As abas são criadas
  automaticamente a partir dos discos monitorados (`DISK_DEVS`).

### ⚙️ Processos

- Lista os 7 processos que mais consomem **memória** no servidor.
- **Buscar**: digite no campo de busca para filtrar por comando ou usuário.
- **Ordenar**: clique no cabeçalho de uma coluna (PID, Usuário, CPU%, MEM%, Comando)
  para ordenar. Clique de novo para inverter.

### 🔔 Alertas

- Lista de alertas com filtros: **Ativos** (não resolvidos), **Todos**, **Warning**, **Critical**.
- Cada alerta tem um ciclo de vida: `new` (novo) → `ack` (reconhecido) → `resolved` (resolvido).
  - **Reconhecer** (✓): você viu o alerta e está ciente.
  - **Resolver**: o alerta deixou de existir (auto-resolve) ou você o encerrou manualmente.
- Os alertas ativos também aparecem como barras coloridas no topo de todas as telas
  (amarelo = warning, vermelho = critical) com botão ✓ para reconhecer.

### 📝 Anotações

- Linha do tempo de eventos que você mesmo marca (ex.: "troquei o cooler", "desliguei
  para limpeza").
- **Criar**: use o formulário no topo da tela, ou clique num ponto de um gráfico e
  escolha **"Anotar neste momento"**.
- **Remover**: clique em "Remover" na anotação (a linha do gráfico some junto).

### 📊 Análise

- **Índice de saúde**: detalhe de cada desconto na nota (ex.: "-15 RAM 92%").
- **Pressão de RAM (6h)**: média, pico e tendência (subindo/estável/caindo).
- **ETA — discos cheios**: tabela com crescimento por dia e previsão de lotação.
- **Resumo diário**: min / média / máx de load, RAM, temperatura e rede por dia.
- **Outages**: períodos em que o servidor ficou inacessível + % de uptime nos últimos 30 dias.

### 📜 Histórico

- Tabela com as amostras do período selecionado (cada linha = 1 coleta).
- Ótima para "rolar" o passado e conferir valores exatos.

### ❓ Ajuda (esta tela!)

- Resumo rápido deste tutorial, sempre à mão dentro do painel.

---

### Interações comuns a todas as telas

| Ação | Como fazer | Para quê |
|------|-----------|----------|
| **Mudar período** | Botões `1h` / `6h` / `24h` / `72h` no topo | Ver gráficos de hoje, ou dos últimos 3 dias |
| **Alternar tema** | Botão (lua/sol) no topo da tela | Trocar entre tema escuro e claro (fica salvo) |
| **Zoom no gráfico** | Roda do mouse sobre o gráfico | Ampliar um intervalo para ver detalhes |
| **Mover (pan)** | `Shift` + arrastar com o mouse | Navegar dentro do zoom |
| **Voltar o zoom** | Trocar o período (1h/6h/...) ou atualizar a página | Restaurar a visão normal |
| **Detalhe de uma amostra** | Clicar em um ponto do gráfico | Abrir janela com tudo daquela coleta (RAM, discos, processos, SMART...) |
| **Anotar no gráfico** | Na janela de detalhe, clicar em "Anotar neste momento" | Marcar um evento na linha do tempo (linha roxa tracejada) |
| **Coletar agora** | Botão no rodapé da coluna esquerda | Forçar uma coleta imediata (não espera o minuto) |
| **Exportar CSV** | Botão "Exportar" no topo | Baixar o período atual em planilha (Excel abre direto) |

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
4. **Anote os eventos** — quando fizer manutenção no servidor, clique num ponto do
   gráfico e adicione uma anotação. Daqui a semanas você saberá o que aconteceu naquele dia.
5. **Exporte relatórios** — o botão **Exportar** baixa CSV do período atual. Dá para
   abrir no Excel/LibreOffice e comparar semanas diferentes.
6. **Fique de olho na Análise** — o **ETA de discos** e a **pressão de RAM** avisam
   problemas com dias de antecedência, antes que virem alerta.
7. **Mantenha o histórico** — não apague `data/` por acidente; ele guarda 3 dias de
   amostras detalhadas, 90 dias resumidos e todo o histórico de alertas e anotações.
8. **Backup do histórico (opcional)** — se quiser guardar além de 90 dias, exporte CSV
   periodicamente ou copie as pastas `data/history/` e `data/rollup/` para outro lugar.
9. **Segurança na prática** — não torne o painel acessível fora do seu computador.
   O endereço local `127.0.0.1` é de propósito. Se precisar acessar de longe, use VPN.

---

*Linux Server Dashboard — monitoramento somente leitura via SSH, 1 coleta/min,
dashboard local em 127.0.0.1:3000. O servidor não instala nada.*