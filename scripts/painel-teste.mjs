#!/usr/bin/env node
// Painel de teste para os testes no navegador (ADR 0019): sobe o painel de verdade
// (createApp) em 127.0.0.1, numa porta separada, sem token e com dados semeados numa pasta
// temporária. Nada de SSH nem de data/: a coleta usa a saída anonimizada da fixture do
// servidor (test/fixtures/coleta-v2/debian13-real.txt), como o soak.
//
//   npm run painel-teste                              # cenário normal, porta 3943
//   npm run painel-teste -- --cenario=lacunas --porta=3944
//   npm run painel-teste -- --versao-nova             # com aviso de versão nova (falsa) e troca simulada
//   npm run painel-teste -- --versao-nova --resultado=voltou  # a troca simulada volta atrás
//   npm run painel-teste -- --versao-nova --exige-reconfigurar  # versão que muda a coleta, com o aviso
//   npm run painel-teste -- --versao-nova --sem-escrita  # serviço sem escrita em .atualizacao/painel/: o botão mostra o 503 (#181)
//   npm run painel-teste -- --reconfigurar            # Reconfigurar com login: o painel dá lugar ao assistente falso
//   npm run painel-teste -- --reconfigurar=volta      # o mesmo, mas o painel novo "não sobe" no fim
//   npm run painel-teste -- --reconfigurar=recusa     # o comando recusa depois do 202, e o painel fica
//   npm run painel-teste -- --reconfigurar=sem-assinatura  # recusado pela rota, antes do código
//   (com --versao-nova o painel tem login: o token é "teste")
//
// Cenários:
//   normal   10 dias de agregados + 72 h de amostras a cada minuto, sem queda; coleta ao vivo
//   lacunas  dias sem coleta e um dia inteiro em queda (disponibilidade só sobre o tempo
//            medido, ADR 0018); coleta ao vivo
//   offline  24 h de amostras e o servidor caindo agora (queda em andamento)
//   vazio    nenhum dado e nenhuma coleta (o 1º uso, antes da 1ª coleta)
//
//   npm run painel-teste -- --assistente --porta=3947
// sobe o assistente de instalação com servidor, ssh e systemd falsos
// (test-support/instalacao-fake.js), código ACD-347. Modo senha: usuário maria, senha
// "certa". Modo chave: apelido meu-servidor; a 1ª conferência do ssh-agent diz que a chave
// falta (para ver o ssh-add) e as seguintes acham a chave. O sudo pede senha ("certa").
//
// Ctrl+C encerra o painel e apaga a pasta temporária.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { collect } from '../server/collector/index.js';
import { normalizeTargets } from '../server/collector/builder.js';
import { History } from '../server/storage/index.js';
import { OutageLog } from '../server/storage/outages.js';
import { createWizardApp } from '../server/setup/web.js';
import { LOG_PELA_TELA, retirarCodigoPelaTela } from '../server/setup/pela-tela.js';
import { VERSION } from '../server/version.js';
import { abrirRegistro, garantirPasta, lerEstado, pegarTrava, soltarTrava } from '../server/atualizacao/registro.js';
import { makeInstalacao, detectionWithSudo } from '../test-support/instalacao-fake.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60000;
const DAY = 1440 * MIN;
export const CENARIOS = ['normal', 'lacunas', 'offline', 'vazio'];
// Os alvos da fixture: 4 pastas em 3 discos, rede e 1 serviço (todas as telas têm o que mostrar).
// normalizeTargets completa o smartDevs com os discos, como a instalação sem SMART_DEVS faz
// (configTargets); sem isso a Ajuda diria "nenhum disco em SMART_DEVS" (#57). O hash do
// coletor não muda: SMART nos mesmos discos do I/O fica fora da conta.
const ALVOS = normalizeTargets({ netIf: 'enp0s7', mounts: ['/', '/mnt/sdb1', '/mnt/sdc1', '/mnt/sdc2'], devs: ['sda', 'sdb', 'sdc'], services: ['smbd'] });
export const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'coleta-v2', 'debian13-real.txt'), 'utf8');

/**
 * Saída padrão do coletor falso: a fixture com os contadores avançando conforme o instante,
 * para as taxas (CPU, rede, disco) e o uptime terem valores. Mesma ideia do soak.
 */
function saidaFalsa(now) {
  const min = Math.floor(now / MIN);
  return FIXTURE
    // 1 núcleo, 6000 tiques por minuto: ~5% usuário, 2% sistema, 1% espera de disco, resto ocioso.
    .replace(/^cpu\s+(\d+) (\d+) (\d+) (\d+) (\d+)/m, (_, us, ni, sy, id, io) =>
      `cpu  ${Number(us) + min * 300} ${ni} ${Number(sy) + min * 120} ${Number(id) + min * 5520} ${Number(io) + min * 60}`)
    .replace(/(enp0s7:\s*)(\d+)/, (_, a, n) => `${a}${Number(n) + min * 750_000}`)
    .replace(/(===UPTIME===\n)(\d+)/, (_, a, n) => `${a}${Number(n) + (min % 100000) * 60}`);
}

/** Coletor falso: `saida(now)` faz o papel do servidor. Quem devolve null simula uma queda. */
export function coletorFalso(saida = saidaFalsa) {
  let prev = null;
  return async (now) => {
    const stdout = saida(now);
    if (stdout === null) return { ok: false, error: 'teste: servidor desligado' };
    const r = await collect({ host: 'servidor', prev, targets: ALVOS, now, runner: async () => ({ stdout, stderr: '', code: 0 }) });
    if (r.ok) prev = r.sample;
    return r;
  };
}

// Instante (ms) de `dias` atrás, na hora local `hora`.
const diaHora = (agora, dias, hora) => { const d = new Date(agora - dias * DAY); d.setHours(hora, 0, 0, 0); return d.getTime(); };

/**
 * Grava em `dir` (o data/ do painel de teste) os dados do cenário. `opcoes` encurta os
 * períodos nos testes. Devolve o coletor falso, para a coleta ao vivo continuar de onde parou.
 */
export async function semear(dir, cenario, { agora = Date.now(), horasBrutas = 72, diasAntigos = 10, coletor = coletorFalso() } = {}) {
  if (!CENARIOS.includes(cenario)) throw new Error(`cenário desconhecido: ${cenario} (use ${CENARIOS.join(', ')})`);
  const coletar = coletor;
  const h = new History({ dataDir: dir, log: () => {} });
  const quedas = new OutageLog({ file: path.join(dir, 'outages.ndjson'), log: () => {} });
  const guardar = async (de, ate, passo) => {
    for (let t = de; t < ate; t += passo) {
      const r = await coletar(t);
      if (r.ok) h.append(r.sample);
    }
  };
  if (cenario === 'normal') {
    const inicioBruto = agora - horasBrutas * 60 * MIN;
    await guardar(inicioBruto - diasAntigos * DAY, inicioBruto, 5 * MIN);
    await guardar(inicioBruto, agora, MIN);
  } else if (cenario === 'lacunas') {
    // 6 dias atrás: 2 h; 3 dias atrás: 2 h e uma queda que atravessa o dia seguinte inteiro;
    // hoje: as 2 primeiras horas. Os outros dias ficam sem coleta.
    await guardar(diaHora(agora, 6, 9), diaHora(agora, 6, 11), MIN);
    await guardar(diaHora(agora, 3, 9), diaHora(agora, 3, 11), MIN);
    quedas.start(diaHora(agora, 3, 11) + MIN, 'teste: servidor desligado');
    quedas.end(diaHora(agora, 1, 0) + 5 * MIN);
    await guardar(Math.min(diaHora(agora, 0, 0), agora - 2 * 60 * MIN), Math.min(diaHora(agora, 0, 2), agora), MIN);
  } else if (cenario === 'offline') {
    await guardar(agora - 24 * 60 * MIN, agora - 10 * MIN, MIN);
  }
  await h.flush();
  await quedas.flush();
  return { coletar };
}

/** A mesma versão falsa, com o marcador do CHANGELOG que muda o script de coleta. */
async function procurarQueExigeReconfigurar() {
  const r = await procurarFalso();
  return { ...r, novidades: { ...r.novidades, exigeReconfigurar: true } };
}

/** Lê --nome=valor da linha de comando. */
const opcao = (nome, padrao) => {
  const a = process.argv.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.slice(nome.length + 3) : padrao;
};

/**
 * O painel (createApp) sobre os dados de `dir`, sem token. `coletar` é o coletor falso de
 * semear(); no cenário offline, toda coleta falha. `extra` vai direto para o createApp.
 */
export function criarPainel(dir, cenario, coletar, extra = {}) {
  // offline: toda coleta falha (o motor abre a queda depois de 2 falhas seguidas).
  const coleta = cenario === 'offline'
    ? async () => ({ ok: false, error: 'teste: servidor desligado' })
    : () => coletar(Date.now());
  const arq = (nome) => path.join(dir, nome);
  return createApp({
    dataDir: dir, historyFile: arq('history.json'), alertsFile: arq('alerts.json'), annotationsFile: arq('annotations.json'),
    outagesFile: arq('outages.ndjson'), sessionsFile: arq('sessions.json'), dashToken: '', sshHost: 'servidor',
    targets: ALVOS, pollInterval: 60000, collect: coleta, log: () => {}, ...extra,
  });
}

/**
 * Troca de versão falsa, para ver o progresso: escreve o registro como o `dashboard atualizar
 * --registro` faria, com um processo imaginário em `<dir>/proc` segurando a trava. Nada sai da
 * máquina e nenhum arquivo do painel muda. `reiniciar` derruba o servidor no meio, como a troca.
 */
export function atualizacaoFalsa(dir, { resultado = 'atualizado', passoMs = 700, reiniciar = async () => {} } = {}) {
  const procDir = path.join(dir, 'proc');
  fs.mkdirSync(path.join(procDir, '4242'), { recursive: true });
  fs.writeFileSync(path.join(procDir, '4242', 'cmdline'), 'node\0/painel/server/cli/index.js\0atualizar\0--registro\0');
  const espera = () => new Promise((r) => { setTimeout(r, passoMs); });
  const executar = async () => {
    const registro = abrirRegistro(dir);
    pegarTrava(dir, { pid: 4242, procDir });
    const escrever = (linha) => registro.stream.write(`${linha}\n`);
    const { de } = lerEstado(dir);
    (async () => {
      registro.marcar({ fase: 'procurando' });
      escrever('Server Dashboard · atualizar');
      await espera();
      escrever('✓ versão nova encontrada: v9.9.9 (assinatura conferida com a chave da versão instalada)');
      registro.marcar({ fase: 'trocando' });
      await espera();
      escrever('✓ cópia de segurança de data/ feita (.backups/teste)');
      registro.marcar({ fase: 'ligando' });
      await reiniciar();
      if (resultado === 'voltou') {
        registro.marcar({ fase: 'voltando', resultado: 'voltou' });
        escrever(`✗ a versão v9.9.9 não funcionou aqui: voltando para ${de}`);
        await espera();
        escrever(`✓ de volta à ${de}, com os dados de antes da atualização`);
      } else {
        escrever('✓ versão nova no ar');
        escrever(`✓ atualizado de ${de} para v9.9.9`);
      }
      registro.fim(resultado === 'voltou' ? 1 : 0);
      soltarTrava(dir);
    })();
    return { ok: true };
  };
  // Com login: sem sessão, o botão fica desligado (a senha do painel de teste é "teste").
  return { dashToken: 'teste', pastaAtualizacao: dir, procDirAtualizacao: procDir, executarAtualizacao: executar, modoAtualizacao: 'segundo-plano' };
}

/**
 * Uma porta só para o painel e o assistente falso, como na troca de verdade: `trocar('painel')`,
 * `trocar(app)` ou `trocar(null)`, que derruba cada conexão (nada escutando na porta).
 */
export function portaTrocavel() {
  let atual = 'painel';
  let painel = null;
  const handler = (req, res) => {
    if (atual === 'painel' && painel) return painel(req, res);
    if (typeof atual === 'function') return atual(req, res);
    return req.socket.destroy();
  };
  return { handler, usarPainel: (app) => { painel = app; }, trocar: (a) => { atual = a; } };
}

/**
 * Reconfiguração falsa: a rota de verdade gera o código, e nenhum comando de verdade sobe. Sem
 * `trocar`, só o 202. `bloqueio` simula o que a rota acusa depois do clique (`sem-assinatura`,
 * `outra-pasta`). Com `trocar` (de `portaTrocavel`), faz o que o `--pela-tela` faria, com o
 * assistente falso: `resultado` 'assistente' (cancelar ou terminar religa o painel), 'volta' (o
 * painel novo "não sobe" e o log diz o motivo) ou 'recusa' (o comando recusa e o painel fica).
 */
export function reconfiguracaoFalsa(dir, { bloqueio = null, trocar = null, resultado = 'assistente', passoMs = 1200 } = {}) {
  const dados = path.join(dir, 'data');
  fs.mkdirSync(dados, { recursive: true });
  const espera = () => new Promise((r) => { setTimeout(r, passoMs); });
  // As linhas no formato da saída da CLI sem terminal (✓ ▲ ✗ →), como o comando grava.
  const gravar = (linhas) => fs.writeFileSync(path.join(dados, LOG_PELA_TELA), linhas.map((l) => `${l}\n`).join(''), { mode: 0o600 });
  const assistentes = [];
  const voltar = async (falhou) => {
    trocar(null);
    gravar(falhou
      ? ['→ assistente no ar, esperando o navegador', '✓ assistente concluído e desligado', '✗ o painel não subiu com a configuração nova (o painel não respondeu)', '✓ painel de volta com a configuração anterior']
      : ['→ assistente no ar, esperando o navegador', '▲ assistente cancelado', '✓ painel de volta com a configuração anterior']);
    await espera();
    trocar('painel');
  };
  const simular = async () => {
    await espera();
    const codigo = retirarCodigoPelaTela(dados);
    if (resultado === 'recusa' || !codigo) {
      gravar(['✗ há uma atualização em andamento (o painel continua no ar)']);
      return;
    }
    trocar(null);
    await espera();
    const { app, cleanup } = criarAssistente({
      codeHash: codigo.hash, codeTtlMs: codigo.exp - Date.now(),
      onCancel: () => voltar(false), onFinish: () => voltar(resultado === 'volta'),
    });
    assistentes.push(cleanup);
    gravar(['→ assistente no ar, esperando o navegador']);
    trocar(app);
  };
  const executarReconfiguracao = async () => {
    if (trocar) simular().catch((err) => console.error(`reconfiguração falsa: ${err.message}`));
    return { ok: true };
  };
  return {
    dashToken: 'teste', pastaAtualizacao: dir, executarReconfiguracao, conferirReconfiguracao: () => bloqueio,
    limparAssistentes: () => { for (const c of assistentes.splice(0)) c(); },
  };
}

/** Versão nova falsa para ver o aviso, o menu e as novidades: nada sai desta máquina. */
export async function procurarFalso() {
  return {
    nova: 'v9.9.9',
    novidades: {
      cortado: false,
      secoes: [{
        versao: '9.9.9',
        data: '2026-11-02',
        texto: 'Versão de exemplo do painel de teste.\n\n### Adicionado\n\n- Item com `codigo` e **negrito** (#1).\n- Item longo que continua\n  na linha de baixo.\n\n### Corrigido\n\n- <b>HTML</b> no texto aparece como texto.',
      }],
    },
    bloqueio: null,
    erro: null,
  };
}

/**
 * O assistente com a instalação falsa: nada sai desta máquina (ver o cabeçalho). `opcoes` vão para o
 * `createWizardApp` (o modo `--pela-tela` passa o hash do código e o cancelar).
 */
export function criarAssistente(opcoes = {}) {
  const fake = makeInstalacao({ detection: detectionWithSudo('pede-senha') });
  // A chave "falta" no agente só na 1ª conferência: assim dá para ver o ssh-add e o Tentar de novo.
  fake.srv.agentHasKey = false;
  // Nome genérico: o preparo mostra o nome do computador, e os prints saem daqui.
  fake.inst.deps.hostname = () => 'notebook-a';
  fake.inst.deps.versionStatus = () => ({ ok: true, tag: `v${VERSION.app}` });
  const conferir = fake.inst.deps.checkAgentKey;
  fake.inst.deps.checkAgentKey = async (o) => {
    const r = await conferir(o);
    fake.srv.agentHasKey = true;
    return r;
  };
  const app = createWizardApp({ inst: fake.inst, code: 'ACD347', onFinish: () => {}, log: (m) => console.log(m), ...opcoes });
  return { app, cleanup: fake.cleanup };
}

async function main() {
  const cenario = opcao('cenario', 'normal');
  const porta = Number(opcao('porta', process.argv.includes('--assistente') ? '3947' : '3943'));
  if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) throw new Error('use --porta entre 1024 e 65535');
  if (process.argv.includes('--assistente')) {
    const { app, cleanup } = criarAssistente();
    const server = app.listen(porta, '127.0.0.1', () => {
      console.log(`assistente de teste em http://127.0.0.1:${porta}/configurar#codigo=ACD-347`);
      console.log('Ctrl+C encerra e apaga os dados de teste.');
    });
    const sair = () => { server.close(); cleanup(); process.exit(0); };
    process.on('SIGINT', sair);
    process.on('SIGTERM', sair);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-painel-teste-'));
  // A instalação cria .atualizacao/painel/; `--sem-escrita` simula o serviço sem essa pasta (#181).
  if (!process.argv.includes('--sem-escrita')) garantirPasta(dir);
  const reconfigurar = process.argv.includes('--exige-reconfigurar');
  // Outro hash na resposta do "servidor": é o que a coleta vê depois de uma versão que muda o script.
  const { coletar } = await semear(dir, cenario, reconfigurar ? { coletor: coletorFalso((now) => saidaFalsa(now).replace(/(===VER===\n\d+ )\w+/, '$1000000000000')) } : {});
  const versaoNova = process.argv.includes('--versao-nova');
  let server;
  // "Reinício" no meio da troca: fecha as conexões e volta a escutar 3 s depois.
  const reiniciar = () => new Promise((pronto) => {
    server.close();
    server.closeAllConnections();
    setTimeout(() => { server.listen(porta, '127.0.0.1', pronto); }, 3000);
  });
  const troca = versaoNova ? atualizacaoFalsa(dir, { resultado: opcao('resultado', 'atualizado'), reiniciar }) : {};
  // Sem esta opção, o painel de teste não tem executor e o item Reconfigurar responde 409.
  const pedido = process.argv.find((x) => x === '--reconfigurar' || x.startsWith('--reconfigurar='));
  const valor = pedido?.split('=')[1] ?? null;
  const portaUnica = portaTrocavel();
  const reconfiguracao = pedido
    ? reconfiguracaoFalsa(dir, ['recusa', 'volta'].includes(valor) || !valor ? { trocar: portaUnica.trocar, resultado: valor ?? 'assistente' } : { bloqueio: valor })
    : {};
  const { limparAssistentes = () => {}, ...depsReconfiguracao } = reconfiguracao;
  const { app, runPoll, atualizacao, shutdown } = criarPainel(dir, cenario, coletar, { ...depsReconfiguracao, ...(versaoNova ? { procurarVersao: reconfigurar ? procurarQueExigeReconfigurar : procurarFalso, sshAccess: reconfigurar ? 'restrito' : undefined, ...troca } : {}) });
  if (versaoNova) await atualizacao.verificar();
  if (cenario === 'offline') { await runPoll(); await runPoll(); }
  // vazio fica sem coleta: é o estado do 1º uso, antes da 1ª amostra chegar.
  const timer = cenario === 'vazio' ? null : setInterval(runPoll, 60000);
  // Só 127.0.0.1 (I6), como o painel de verdade.
  portaUnica.usarPainel(app);
  server = http.createServer(portaUnica.handler).listen(porta, '127.0.0.1', () => {
    console.log(`painel de teste (${cenario}) em http://127.0.0.1:${porta} — dados em ${dir}`);
    console.log('Ctrl+C encerra e apaga os dados de teste.');
  });
  const sair = async () => {
    if (timer) clearInterval(timer);
    server.close();
    await shutdown();
    limparAssistentes();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', sair);
  process.on('SIGTERM', sair);
}

const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) main().catch((err) => { console.error(`ERRO: ${err.message}`); process.exit(1); });
