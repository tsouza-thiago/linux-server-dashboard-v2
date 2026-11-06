// Painel de teste para os testes de API: `createApp` com pasta temporária e coletor falso.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { listen, close } from './request.js';

/** Cria o app numa pasta temporária. `extra` entra por último em `createApp`. */
export function setupApp({ collect, token, rateLimitMax, extra = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-api-'));
  const handles = createApp({
    sshHost: 'meu-host',
    pollInterval: 60000,
    historyFile: path.join(dir, 'history.json'),
    alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'),
    dashToken: token,
    ...(rateLimitMax === undefined ? {} : { rateLimitMax }),
    collect: collect || (async () => ({ ok: false, error: 'sem runner', ts: new Date().toISOString() })),
    log: () => {},
    ...extra,
  });
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } };
  return { ...handles, dir, cleanup };
}

/** Sobe o app em porta livre e limpa no fim do teste: desliga, fecha o servidor e só então apaga a pasta. */
export async function withServer(t, setup) {
  const app = setup();
  const { server, port } = await listen(app.app);
  t.after(async () => {
    await app.shutdown(); // espera as gravações pendentes antes de apagar a pasta
    await close(server);
    app.cleanup();
  });
  return { ...app, server, port };
}
