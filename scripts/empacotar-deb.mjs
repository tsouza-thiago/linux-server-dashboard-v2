// Server Dashboard — gera o pacote .deb de uma versão (F9 do #92, ADR 0042 item 10 e ADR 0049).
//
//   npm run empacotar-deb                     a tag da versão do package.json (vX.Y.Z)
//   npm run empacotar-deb -- --ref v2.6.0     outra tag (ou HEAD, para conferir no CI)
//   npm run empacotar-deb -- --saida <pasta>  onde gravar (padrão: dist/)
//
// Grava <saida>/server-dashboard_<versão>_all.deb e <saida>/SHA256SUMS. O pacote é
// reprodutível: tudo sai da ref no git (nunca da pasta de trabalho), com a data do commit como
// SOURCE_DATE_EPOCH, dono root, permissões fixas e o dpkg-deb do sistema com 1 thread. A mesma
// ref gera os mesmos bytes em qualquer máquina; o CI gera de novo e compara (ADR 0042, item 10).
// Sem dependência nova: só git, tar e dpkg-deb.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ_PROJETO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOME = 'server-dashboard';
const BASE = 'opt/server-dashboard';
// Padrão das tags de versão (o mesmo do RELEASE_TAG e do executor).
const PADRAO_TAG = /^v2\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/;
// Nenhuma configuração do sistema ou da pessoa muda o que o git gera (tar.umask, autocrlf…).
const AMBIENTE = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C', TZ: 'UTC' };

/** Lê as opções da linha de comando; opção desconhecida ou sem valor sai com erro. */
function opcoes(argv) {
  const o = { repo: RAIZ_PROJETO, ref: null, saida: null };
  for (let i = 0; i < argv.length; i += 1) {
    const chave = { '--ref': 'ref', '--saida': 'saida', '--repo': 'repo' }[argv[i]];
    if (!chave || argv[i + 1] === undefined) throw new Error(`opção inválida: ${argv[i]}`);
    o[chave] = argv[i += 1];
  }
  o.repo = path.resolve(o.repo);
  o.saida = path.resolve(o.saida ?? path.join(o.repo, 'dist'));
  return o;
}

/** Roda um comando sem shell; falha com a saída de erro dele. */
function rodar(cmd, args, { buffer = false, env = AMBIENTE } = {}) {
  const r = spawnSync(cmd, args, { env, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${String(r.stderr).trim()}`);
  return r.stdout;
}

/** Versão do Debian a partir da do npm: a pré-versão usa ~, que ordena antes da final. */
export function versaoDebian(v) {
  if (!/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(v)) throw new Error(`versão inválida no package.json: ${v}`);
  return v.replace('-', '~');
}

/**
 * Os arquivos do pacote (ADR 0042, item 1): destino → origem na ref (ou link), com o modo fixo.
 * Só arquivos que o dpkg controla; versoes, estado, node e repo.git são do executor (postinst).
 */
function conteudo(unidades) {
  return [
    { destino: `${BASE}/bin/dashboard`, origem: 'bin/dashboard', modo: 0o755 },
    { destino: `${BASE}/libexec/atualizador`, origem: 'libexec/atualizador', modo: 0o755 },
    { destino: `${BASE}/share/allowed_signers`, origem: 'docs/allowed_signers', modo: 0o644 },
    { destino: `${BASE}/share/semente.tar`, semente: true, modo: 0o644 },
    // Link fixo do pacote: o lançador segue <base>/atual → versoes/atual, que só o executor troca.
    { destino: `${BASE}/atual`, link: 'versoes/atual' },
    { destino: 'usr/bin/dashboard', link: `/${BASE}/bin/dashboard` },
    ...unidades.map((u) => ({ destino: `usr/lib/systemd/system/${path.basename(u)}`, origem: u, modo: 0o644 })),
    { destino: 'usr/share/polkit-1/rules.d/50-server-dashboard.rules', origem: 'pacote/polkit/50-server-dashboard.rules', modo: 0o644 },
    { destino: 'usr/lib/sysusers.d/server-dashboard.conf', origem: 'pacote/sysusers/server-dashboard.conf', modo: 0o644 },
    { destino: 'usr/share/bash-completion/completions/dashboard', origem: 'scripts/completar.bash', modo: 0o644 },
    { destino: `usr/share/doc/${NOME}/copyright`, origem: 'LICENSE', modo: 0o644 },
    { destino: 'DEBIAN/postinst', origem: 'pacote/debian/postinst', modo: 0o755 },
    { destino: 'DEBIAN/prerm', origem: 'pacote/debian/prerm', modo: 0o755 },
    { destino: 'DEBIAN/postrm', origem: 'pacote/debian/postrm', modo: 0o755 },
  ];
}

/** Põe a data em tudo, de baixo para cima (o link em si, não o alvo). */
function datar(dir, epoch) {
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (fs.lstatSync(p).isDirectory()) datar(p, epoch);
    fs.lutimesSync(p, epoch, epoch);
  }
  fs.lutimesSync(dir, epoch, epoch);
}

/** Lista os arquivos comuns (relativos à raiz), em ordem fixa, fora o DEBIAN/. */
function arquivos(raiz, rel = '') {
  const lista = [];
  for (const nome of fs.readdirSync(path.join(raiz, rel)).sort()) {
    const r = rel ? `${rel}/${nome}` : nome;
    const st = fs.lstatSync(path.join(raiz, r));
    if (r === 'DEBIAN') continue;
    if (st.isDirectory()) lista.push({ r, tipo: 'pasta' }, ...arquivos(raiz, r));
    else lista.push({ r, tipo: st.isSymbolicLink() ? 'link' : 'arquivo', tamanho: st.size });
  }
  return lista;
}

/** Gera o .deb e o SHA256SUMS. Devolve { deb, soma, versao }. */
export function empacotar({ repo, ref, saida }) {
  const git = (...args) => rodar('git', ['-C', repo, ...args]);
  if (!ref) ref = `v${JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version}`;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-')) throw new Error(`ref inválida: ${ref}`);
  const commit = git('rev-parse', '--verify', '-q', `${ref}^{commit}`).trim();
  const versaoNpm = JSON.parse(git('show', `${commit}:package.json`)).version;
  if (PADRAO_TAG.test(ref) && ref !== `v${versaoNpm}`) throw new Error(`a tag ${ref} traz a versão ${versaoNpm} no package.json`);
  const versao = versaoDebian(versaoNpm);
  // SOURCE_DATE_EPOCH: a data do commit da ref, a mesma que o git archive grava na semente.
  const epoch = Number(git('log', '-1', '--format=%ct', commit).trim());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empacotar-deb-'));
  try {
    const raiz = path.join(tmp, 'raiz');
    const unidades = git('ls-tree', '--name-only', commit, 'pacote/systemd/').split('\n')
      .filter((f) => /\.(service|timer)$/.test(f)).sort();
    for (const item of conteudo(unidades)) {
      const destino = path.join(raiz, item.destino);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      if (item.link) {
        fs.symlinkSync(item.link, destino);
        continue;
      }
      if (item.semente) {
        // O mesmo git archive que o executor extrai de uma tag (umask do git, sem prefixo).
        rodar('git', ['-C', repo, '-c', 'tar.umask=0002', 'archive', '--format=tar', '-o', destino, commit]);
      } else {
        fs.writeFileSync(destino, rodar('git', ['-C', repo, 'show', `${commit}:${item.origem}`], { buffer: true }));
      }
      fs.chmodSync(destino, item.modo);
    }

    // Tamanho instalado (KiB, como o dpkg-gencontrol: cada arquivo arredondado para cima) e as
    // somas MD5 que o `dpkg --verify` confere.
    const lista = arquivos(raiz);
    const tamanho = lista.reduce((t, a) => t + (a.tipo === 'arquivo' ? Math.ceil(a.tamanho / 1024) : 1), 0);
    const md5 = lista.filter((a) => a.tipo === 'arquivo')
      .map((a) => `${crypto.createHash('md5').update(fs.readFileSync(path.join(raiz, a.r))).digest('hex')}  ${a.r}\n`).join('');
    const control = git('show', `${commit}:pacote/debian/control`)
      .replace('@VERSAO@', versao).replace('@TAMANHO@', String(tamanho));
    fs.writeFileSync(path.join(raiz, 'DEBIAN', 'control'), control);
    fs.writeFileSync(path.join(raiz, 'DEBIAN', 'md5sums'), md5);
    // Pastas 0755 e arquivos de controle 0644, seja qual for o umask de quem gera.
    for (const a of lista.filter((x) => x.tipo === 'pasta')) fs.chmodSync(path.join(raiz, a.r), 0o755);
    for (const d of [raiz, path.join(raiz, 'DEBIAN')]) fs.chmodSync(d, 0o755);
    for (const f of ['control', 'md5sums']) fs.chmodSync(path.join(raiz, 'DEBIAN', f), 0o644);
    datar(raiz, epoch);

    fs.mkdirSync(saida, { recursive: true });
    const nome = `${NOME}_${versao}_all.deb`;
    const deb = path.join(saida, nome);
    // Dono root em tudo (sem isso, o dono seria quem gera); xz com 1 thread (o resultado do xz
    // com várias threads muda com o número de núcleos).
    rodar('dpkg-deb', ['--root-owner-group', '-Zxz', '-z6', '--threads-max=1', '--build', raiz, deb],
      { env: { ...AMBIENTE, SOURCE_DATE_EPOCH: String(epoch) } });
    const soma = crypto.createHash('sha256').update(fs.readFileSync(deb)).digest('hex');
    fs.writeFileSync(path.join(saida, 'SHA256SUMS'), `${soma}  ${nome}\n`);
    return { deb, soma, versao };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = opcoes(process.argv.slice(2));
    const r = empacotar(o);
    console.log(`Pacote: ${r.deb}`);
    console.log(`SHA-256: ${r.soma}`);
    console.log('Próximo passo (mantenedor): assine o SHA256SUMS com a chave das tags:');
    console.log(`  ssh-keygen -Y sign -f <chave privada> -n ${NOME} ${path.join(o.saida, 'SHA256SUMS')}`);
  } catch (e) {
    console.error(`ERRO: ${e.message}`);
    process.exit(1);
  }
}
