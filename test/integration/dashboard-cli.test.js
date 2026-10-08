// ./dashboard (bash): escolhe o Node 24 (pasta, sistema ou download conferido) e chama a CLI.
// O download é testado contra um servidor HTTP local com um pacote falso: soma certa
// instala em .runtime/node; soma errada não extrai nada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = path.join(ROOT, 'scripts', 'node-runtime.sh');
const VERSION = /NODE_VERSION="([\d.]+)"/.exec(fs.readFileSync(LIB, 'utf8'))[1];
const ARCH = { x64: 'x64', arm64: 'arm64' }[process.arch];

function fakeNode(dir, major) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node');
  fs.writeFileSync(file, `#!/bin/sh\necho ${major}\n`, { mode: 0o755 });
  return file;
}

/** Pacote .tar.gz com o mesmo formato do oficial: node-vX-linux-ARCH/bin/node. */
function fakeTarball(work) {
  const name = `node-v${VERSION}-linux-${ARCH}`;
  fakeNode(path.join(work, name, 'bin'), 24);
  const tgz = path.join(work, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', tgz, '-C', work, name]);
  return { tgz, sha: crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex'), name };
}

// Assíncrono: o servidor HTTP do teste roda neste mesmo processo (spawnSync o travaria).
function ensure(root, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', 'set -e; . "$1"; ensure_node "$2"; echo "$NODE_ORIGEM|$NODE_BIN"', 'bash', LIB, root], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) => resolve({ status, out: out.trim(), err }));
  });
}

test('runtime: Node 24 do sistema é usado; antigo dispara o download conferido (SHA-256)', { skip: !ARCH }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-rt-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const { tgz, sha, name } = fakeTarball(path.join(work, 'dist'));
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    if (req.url === `/v${VERSION}/${name}.tar.gz`) { res.end(fs.readFileSync(tgz)); return; }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const dist = `http://127.0.0.1:${srv.address().port}`;
  const basePath = '/usr/bin:/bin';

  const novo = fakeNode(path.join(work, 'novo'), 24);
  const root1 = path.join(work, 'r1');
  fs.mkdirSync(root1);
  assert.deepEqual((await ensure(root1, { PATH: `${path.dirname(novo)}:${basePath}` })).out, `sistema|${novo}`);
  assert.equal(hits, 0, 'nada baixado');

  const velho = path.dirname(fakeNode(path.join(work, 'velho'), 18));
  const root2 = path.join(work, 'r2');
  fs.mkdirSync(root2);
  const env = { PATH: `${velho}:${basePath}`, DASHBOARD_NODE_DIST: dist, DASHBOARD_NODE_SHA256: sha };
  const first = await ensure(root2, env);
  assert.equal(first.status, 0, first.err);
  assert.equal(first.out, `baixado|${root2}/.runtime/node/bin/node`);
  assert.match(first.err, /baixando o oficial para \.runtime/);
  assert.equal(fs.statSync(path.join(root2, '.runtime')).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.join(root2, '.runtime')), ['node'], 'sem sobras do download');
  assert.equal((await ensure(root2, env)).out, `pasta|${root2}/.runtime/node/bin/node`, 'da 2ª vez usa o da pasta');

  const root3 = path.join(work, 'r3');
  fs.mkdirSync(root3);
  const bad = await ensure(root3, { ...env, DASHBOARD_NODE_SHA256: '0'.repeat(64) });
  assert.notEqual(bad.status, 0);
  assert.match(bad.err, /não confere com a soma SHA-256/);
  assert.deepEqual(fs.readdirSync(path.join(root3, '.runtime')), [], 'nada extraído');

  const off = await ensure(root3, { ...env, DASHBOARD_NODE_DIST: 'http://127.0.0.1:1' });
  assert.notEqual(off.status, 0);
  assert.match(off.err, /não consegui baixar/);
});

test('runtime: as somas fixadas são do pacote oficial (64 hex, uma por arquitetura)', () => {
  const lib = fs.readFileSync(LIB, 'utf8');
  for (const arch of ['x64', 'arm64']) assert.match(lib, new RegExp(`NODE_SHA256_${arch}="[0-9a-f]{64}"`));
  assert.match(VERSION, /^24\.\d+\.\d+$/, 'Node 24 (ADR 0002)');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=24');
});

test('./dashboard chama a CLI com o Node 24 e informa de onde ele veio', { skip: Number(process.versions.node.split('.')[0]) < 24 }, () => {
  const r = spawnSync(path.join(ROOT, 'dashboard'), ['versao'], {
    encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NO_COLOR: '1' },
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `Server Dashboard ${pkg.version}`);
  const help = spawnSync(path.join(ROOT, 'dashboard'), ['ajuda'], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
  for (const cmd of ['instalar', 'abrir', 'iniciar', 'parar', 'status', 'diagnosticar', 'reconfigurar', 'atualizar', 'desinstalar']) {
    assert.match(help.stdout, new RegExp(`\\n  ${cmd} `), `ajuda lista "${cmd}"`);
  }
});
