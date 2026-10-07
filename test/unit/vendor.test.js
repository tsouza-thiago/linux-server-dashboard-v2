import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'vendor');

test('bibliotecas versionadas batem com o SHA-256 registrado em vendor.json', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor.json'), 'utf8'));
  for (const [name, lib] of Object.entries(manifest)) {
    assert.match(lib.version, /^\d+\.\d+\.\d+$/, name);
    assert.ok(lib.license, `${name}: licença registrada`);
    for (const [file, sum] of Object.entries(lib.sha256)) {
      const data = fs.readFileSync(path.join(VENDOR, lib.dir, file));
      assert.equal(crypto.createHash('sha256').update(data).digest('hex'), sum, `${name}/${file} foi alterado`);
    }
  }
});

test('nenhum arquivo solto em public/vendor fora do manifesto', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor.json'), 'utf8'));
  const listed = new Set(Object.values(manifest).flatMap((lib) => Object.keys(lib.sha256).map((f) => `${lib.dir}/${f}`)));
  for (const dir of fs.readdirSync(VENDOR, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of fs.readdirSync(path.join(VENDOR, dir.name))) {
      assert.ok(listed.has(`${dir.name}/${f}`), `${dir.name}/${f} sem soma no manifesto`);
    }
  }
});
