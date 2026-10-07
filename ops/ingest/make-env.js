/* eslint-disable no-console */
/**
 * Genera `C:\KeplerRunner\ingest.env` (OBS.4) a partir de las fuentes ya vetadas del host, SIN
 * imprimir ni un secreto: `.env` del repo (FLEET_DB_URL = prod, ODS_SOURCE_BASE) y el launcher
 * `run-ods-live-loop.cmd` (FEEDS_INGEST_KEY, FEEDS_INGEST_URL).
 *
 * Existe para que nadie tenga que copiar la key a mano y para dejar el reparto de variables escrito
 * en un solo lugar — el reparto ES el arreglo (GOTCHAS §17): la fuente por ODS_SOURCE_BASE, prod por
 * DATABASE_URL_NEW + ODS_HB_URL. Reescribir mal esas tres deja el latido y el reconciliador ciegos.
 *
 *   node ops/ingest/make-env.js            # dry-run: dice qué llaves resolvió (sin valores)
 *   node ops/ingest/make-env.js --write    # escribe el archivo
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const WRITE = process.argv.includes('--write');
const OUT = process.env.INGEST_ENV_OUT || 'C:\\KeplerRunner\\ingest.env';
const CMD = process.env.INGEST_ENV_CMD || 'C:\\KeplerRunner\\run-ods-live-loop.cmd';

/** Lee KEY=VALUE de un .env (sin dotenv, para no contaminar process.env). */
function leerEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** Lee `set "KEY=VALUE"` de un .cmd de KeplerRunner. */
function leerCmd(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"?\s*$/i.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = leerEnv(path.join(REPO, '.env'));
const cmd = leerCmd(CMD);

// La FUENTE se reescribe a host.docker.internal: dentro de un contenedor `localhost` es el propio
// contenedor, no el host donde pgvector-md publica el 5433.
const fuente = (env.ODS_SOURCE_BASE || cmd.ODS_SOURCE_BASE || '')
  .replace(/@(localhost|127\.0\.0\.1)\b/, '@host.docker.internal');
const prod = env.FLEET_DB_URL || '';

const vars = {
  ODS_SOURCE_BASE: fuente,
  DATABASE_URL_NEW: prod,
  ODS_HB_URL: prod,
  FEEDS_SINK: 'http',
  FEEDS_INGEST_URL: cmd.FEEDS_INGEST_URL || 'https://feeds-ingest-production.up.railway.app',
  FEEDS_INGEST_KEY: cmd.FEEDS_INGEST_KEY || '',
  CRON_TENANT_ID: env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c',
};

const faltan = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
console.log('resueltas:', Object.entries(vars).filter(([, v]) => v).map(([k]) => k).join(', ') || '(ninguna)');
if (faltan.length) {
  console.error(`\n✖ faltan: ${faltan.join(', ')}`);
  console.error(`  fuentes consultadas: ${path.join(REPO, '.env')} · ${CMD}`);
  process.exit(1);
}
// Chequeo de cordura: si la fuente y prod coinciden, el reparto está mal y todo queda ciego.
if (new URL(vars.ODS_SOURCE_BASE).host === new URL(vars.ODS_HB_URL).host) {
  console.error('\n✖ ODS_SOURCE_BASE y ODS_HB_URL apuntan al MISMO host — el latido caería en la fuente.');
  process.exit(1);
}

const cuerpo = [
  '# Generado por ops/ingest/make-env.js — NO commitear (lleva FEEDS_INGEST_KEY).',
  `# ${new Date().toISOString()}`,
  '',
  ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
  '',
].join('\n');

if (!WRITE) { console.log(`\n[dry-run] ${cuerpo.split('\n').length - 1} líneas listas para ${OUT}. Corré con --write.`); return; }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, cuerpo, 'utf8');
console.log(`\n✓ escrito ${OUT}`);
