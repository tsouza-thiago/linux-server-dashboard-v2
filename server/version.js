// Versões do painel: do app (package.json), do formato da amostra e do comando de coleta.
import fs from 'node:fs';
import { ROOT } from './config.js';
import { SCHEMA_VERSION } from './collector/parser.js';
import { COLLECTOR_VERSION } from './collector/builder.js';

let appVersion = '0.0.0';
try {
  appVersion = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, 'utf8')).version || appVersion;
} catch { /* sem package.json: versão desconhecida */ }

export const VERSION = Object.freeze({ app: appVersion, schema: SCHEMA_VERSION, collector: COLLECTOR_VERSION });
