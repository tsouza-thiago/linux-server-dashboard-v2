// Do clone para o pacote .deb (`dashboard instalar --importar-pasta <clone>`, F9, ADR 0042 item
// 11 e ADR 0050): para o painel do clone (nunca os 2 juntos: seriam 2 SSH por minuto, I1), traz
// o .env e o data/ dele para as pastas pessoais do pacote e liga o painel do pacote. A pasta do
// clone não é alterada: ela é a cópia de segurança. A chave SSH fica no ~/.ssh, onde já estava,
// e o ID da instalação não muda: a linha do authorized_keys no servidor continua valendo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDe, envDe } from '../config.js';
import { ensureDataDirs, installService, installShortcut, removerAutocomplete, removerLinkDoPath } from '../setup/local.js';
import { hasSystemdUser, panelPort, startPanel, stopPanel, waitForPort } from './servico.js';

// Arquivos que valem só para o painel que os criou: o PID e os códigos de uso único.
const PULAR = new Set(['dashboard.pid', 'entrar.json', 'reconfigurar.json']);
// Variáveis com caminho: no clone, um caminho absoluto aponta para a pasta dele.
const CAMINHOS = ['SSH_CONFIG', 'HISTORY_FILE', 'LOG_FILE'];

/** É um clone da V2 já instalado? (package.json 2.x do linux-server-dashboard, server/index.js e .env) */
export function detectarClone(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.name !== 'linux-server-dashboard' || !/^2\./.test(String(pkg.version))) return { ok: false, motivo: 'nao-e-clone' };
    if (!fs.existsSync(path.join(dir, 'server', 'index.js'))) return { ok: false, motivo: 'nao-e-clone' };
    if (!fs.existsSync(path.join(dir, '.env'))) return { ok: false, motivo: 'sem-env' };
    return { ok: true, versao: pkg.version };
  } catch {
    return { ok: false, motivo: 'nao-e-clone' };
  }
}

/**
 * O .env do clone para o pacote. Os caminhos relativos já são relativos à pasta de dados, que
 * muda junto. Um caminho absoluto dentro do data/ do clone vira relativo; fora dele, a linha sai
 * (o config.js já o trocaria pelo padrão, ADR 0043). O resto vai como está: o config.js valida
 * cada valor ao carregar (I8).
 */
export function envDoClone(texto, clone) {
  const dados = path.join(clone, 'data');
  const linhas = [];
  for (const linha of String(texto).split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(linha);
    if (!m || !CAMINHOS.includes(m[1])) { linhas.push(linha); continue; }
    const valor = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!path.isAbsolute(valor)) linhas.push(linha);
    else if (valor.startsWith(dados + path.sep)) linhas.push(`${m[1]}=${path.relative(clone, valor)}`);
  }
  return linhas.join('\n');
}

/**
 * O data/ssh/config do clone aponta o known_hosts pelo caminho absoluto da pasta dele. Troca só
 * essa linha pelo known_hosts novo; o resto (servidor, chave, identidade) fica igual.
 */
export function sshConfigDoPacote(texto, knownHosts) {
  if (/["\r\n\0]/.test(knownHosts)) throw new Error(`caminho não suportado: ${knownHosts}`);
  return String(texto).replace(/^(\s*UserKnownHostsFile\s+).*$/m, `$1"${knownHosts}"`);
}

// Existe algo nesse caminho (arquivo, pasta ou link, mesmo quebrado)?
function existe(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/**
 * Copia o data/ do clone sem sobrescrever nada e sem seguir links (um link poderia apontar para
 * fora da pasta). Pastas ficam 0700 e arquivos 0600, como no resto do painel.
 */
function copiarDados(de, para, contagem) {
  fs.mkdirSync(para, { recursive: true, mode: 0o700 });
  fs.chmodSync(para, 0o700);
  for (const item of fs.readdirSync(de, { withFileTypes: true })) {
    const origem = path.join(de, item.name);
    const destino = path.join(para, item.name);
    if (item.isDirectory()) copiarDados(origem, destino, contagem);
    else if (item.isFile() && !PULAR.has(item.name) && !existe(destino)) {
      fs.copyFileSync(origem, destino, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destino, 0o600);
      contagem.arquivos += 1;
    }
  }
}

/** Há uma instalação do pacote nesta conta? (o .env ou o histórico já existem) */
function pacoteJaInstalado(root) {
  if (existe(envDe(root))) return true;
  try {
    return fs.readdirSync(path.join(dataDe(root), 'history')).length > 0;
  } catch {
    return false;
  }
}

/**
 * A importação em si: confere o clone e o destino, para o painel do clone, copia o .env e o
 * data/, tira o comando e o autocomplete pessoais que apontam para o clone (o pacote já traz os
 * dele), instala o serviço do pacote e confere que o painel respondeu.
 */
export async function importarPasta({ out, root, dir, home = os.homedir(), deps = {} }) {
  const clone = path.resolve(String(dir || ''));
  const det = detectarClone(clone);
  if (!det.ok) {
    out.fail(det.motivo === 'sem-env' ? 'esse clone ainda não foi instalado (falta o .env)' : 'essa pasta não é um clone do painel', clone);
    out.explain('procurei o package.json 2.x do linux-server-dashboard, o server/index.js e o .env.', `passe a pasta onde você clonou o painel, por exemplo: ${out.cmd} instalar --importar-pasta ~/linux-server-dashboard-v2`);
    return 1;
  }
  if (fs.realpathSync(clone) === fs.realpathSync(root)) { out.fail('essa pasta é o código do pacote'); return 1; }
  if (pacoteJaInstalado(root)) {
    out.fail('o painel do pacote já tem configuração nesta conta', envDe(root));
    out.explain('a importação nunca sobrescreve uma instalação.', `para trocar pela do clone, rode antes ${out.cmd} desinstalar --apagar-historico.`);
    return 1;
  }
  out.ok(`clone encontrado (${det.versao})`, clone);

  // 1. O painel do clone para antes da cópia: assim os dados não mudam no meio dela.
  const parado = await (deps.stopPanel ?? stopPanel)({ root: clone, home });
  out.ok(parado.wasRunning ? 'painel do clone parado' : 'o painel do clone não estava rodando', 'nunca os 2 ao mesmo tempo');

  // 2. .env e data/ para as pastas pessoais (0700/0600).
  ensureDataDirs(root);
  fs.writeFileSync(envDe(root), envDoClone(fs.readFileSync(path.join(clone, '.env'), 'utf8'), clone), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(envDe(root), 0o600);
  const contagem = { arquivos: 0 };
  const dadosDoClone = path.join(clone, 'data');
  if (fs.existsSync(dadosDoClone)) copiarDados(dadosDoClone, dataDe(root), contagem);
  // Um descritor só para ler e gravar: o arquivo não troca entre a leitura e a escrita (CodeQL
  // "file system race"), e O_NOFOLLOW recusa um link no lugar dele.
  let fd = null;
  try {
    fd = fs.openSync(path.join(dataDe(root), 'ssh', 'config'), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  } catch { /* o clone não tinha data/ssh/config */ }
  if (fd !== null) {
    try {
      const novo = sshConfigDoPacote(fs.readFileSync(fd, 'utf8'), path.join(dataDe(root), 'ssh', 'known_hosts'));
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, novo, 0);
    } finally {
      fs.closeSync(fd);
    }
  }
  out.ok('configuração e dados trazidos do clone', `${contagem.arquivos} arquivo${contagem.arquivos === 1 ? '' : 's'} · ${path.dirname(dataDe(root))}`);

  // 3. O ~/.local/bin/dashboard e o autocomplete pessoal do clone esconderiam os do pacote.
  if (removerLinkDoPath({ root: clone, home }).removido) out.ok('comando pessoal do clone removido', 'agora vale o dashboard do pacote');
  const auto = removerAutocomplete({ root: clone, home, env: deps.env ?? process.env });
  if (auto.removido) out.ok('autocomplete pessoal do clone removido', auto.nome);

  // 4. O painel do pacote: serviço de usuário (troca a unidade do clone) ou segundo plano.
  let servico = null;
  if ((deps.hasSystemdUser ?? hasSystemdUser)()) servico = await (deps.installService ?? installService)({ root, home });
  if (!servico || !servico.ok) {
    const r = await (deps.startPanel ?? startPanel)({ root, home });
    if (!r.ok) { out.fail('o painel do pacote não subiu', r.error); return 1; }
  }
  (deps.installShortcut ?? installShortcut)({ root, home });
  const port = panelPort(root);
  if (!(await (deps.waitForPort ?? waitForPort)(port, { timeoutMs: 60000 }))) { out.fail('o painel do pacote não respondeu'); return 1; }
  out.ok(`painel do pacote no ar em http://127.0.0.1:${port}`, servico && servico.ok ? 'serviço de usuário' : 'segundo plano');
  out.line();
  out.line(out.c.dim(`A pasta ${clone} não foi alterada: ela é a cópia de segurança. Confira o painel e, depois, apague a pasta quando quiser.`));
  return 0;
}
