#!/usr/bin/env node
/**
 * `[PURGA.6]` — Ningún archivo basura entra al repo.
 *
 * ── Por qué (2026-10-27) ──────────────────────────────────────────────────────────────────────
 * El repo es PÚBLICO y su historial guardaba 3 volcados de la base de producción (`identity.users`,
 * `commercial.customers`), un estado de cuenta bancario, Excel de proveedores, fotos de WhatsApp,
 * `.env.cloudinary` y cachés de `.nx`/`.angular` — 280 rutas, ~180 MB. Se descargaban sin cuenta.
 * Sacarlos de HEAD no los saca del historial: hay que reescribirlo, y eso cuesta una ventana con todo
 * el equipo. Esta compuerta frena la entrada, que es lo barato.
 *
 * ── Qué frena ─────────────────────────────────────────────────────────────────────────────────
 * - En la RAÍZ: imágenes, Excel, CSV, ZIP, PDF, TXT, LOG (capturas y descargas sueltas).
 * - En cualquier lugar: volcados (.dump, .mdb, .accdb), Thumbs.db, .DS_Store, archivos de bloqueo de
 *   Office (~$…), cachés .nx/ y .angular/, un `.env` real (sí pasa `*.example`) y rutas con
 *   «scratchpad» (archivos de sesión versionados por error).
 * `ops/prod/*.backup` NO es basura: es el servicio de respaldo.
 *
 * Uso:  node scripts/check-basura.js          → revisa los archivos versionados (el índice)
 *       node scripts/check-basura.js --self   → prueba negativa: debe frenar lo que debe
 */
'use strict';
const { execFileSync } = require('child_process');

const REGLAS = [
  ['captura o descarga suelta en la raíz', /^[^/]+\.(png|jpe?g|gif|webp|xlsx?|xlsm|csv|zip|7z|rar|pdf|txt|log)$/i],
  ['volcado de base de datos', /\.(dump|mdb|accdb|sqlite)$/i],
  ['caché del sistema operativo', /(^|\/)(Thumbs\.db|\.DS_Store|desktop\.ini)$/i],
  ['archivo de bloqueo de Office', /(^|\/)~\$/],
  ['caché de Nx o Angular', /(^|\/)\.(nx|angular)\//],
  ['archivo .env real (sólo se versiona *.example)', /(^|\/)\.env(\.(?!example$)[^/]+)?$/i],
  ['archivo de una sesión (scratchpad)', /scratchpad/i],
];
const PERMITIDOS = [/\.env(\.[a-z0-9-]+)*\.example$/i];

function basura(rutas) {
  const out = [];
  for (const r of rutas) {
    if (!r || PERMITIDOS.some((p) => p.test(r))) continue;
    const regla = REGLAS.find(([, re]) => re.test(r));
    if (regla) out.push({ ruta: r, motivo: regla[0] });
  }
  return out;
}
module.exports = { basura };

if (require.main !== module) return;

if (process.argv.includes('--self')) {
  const deben = ['captura.png', 'Libro1.xlsx', '01 ENERO 2026 - SNTDR 2169.csv', 'database/backups/prod.dump', 'Fotos/Thumbs.db',
    '~$salidas.xlsx', 'apps/view/.nx/workspace-data/x.json', '.angular/cache/a.db', '.env', '.env.cloudinary', 'ops/x/.env.local',
    'UsersSistemasAppDataLocalTempscratchpaddata2025.json'];
  const noDeben = ['README.md', 'apps/view/src/assets/logo.png', 'docs/esquema.csv', '.env.example', '.env.replica.example',
    'ops/ingest/ingest.env.example', 'ops/prod/Dockerfile.backup', 'ops/prod/crontab.backup', 'package.json', 'etiqueta-preview.html'];
  const noFrena = deben.filter((r) => !basura([r]).length);
  const frenaDeMas = noDeben.filter((r) => basura([r]).length);
  if (noFrena.length || frenaDeMas.length) {
    console.error('✗ check-basura --self FALLÓ');
    if (noFrena.length) console.error('  deja pasar basura:', noFrena);
    if (frenaDeMas.length) console.error('  frena archivos legítimos:', frenaDeMas);
    process.exit(1);
  }
  console.log(`✓ check-basura --self: ${deben.length} frenan, ${noDeben.length} pasan`);
  process.exit(0);
}

const rutas = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0');
const hallazgos = basura(rutas);
if (hallazgos.length) {
  console.error(`⛔ [PURGA.6] ${hallazgos.length} archivo(s) basura versionado(s) — el repo es PÚBLICO:`);
  for (const h of hallazgos.slice(0, 30)) console.error(`   ${h.ruta}  (${h.motivo})`);
  console.error('\n   Sácalo del índice: git rm --cached -- <ruta>   (y agrégalo a .gitignore si se repite)');
  process.exit(1);
}
console.log(`✓ check-basura: ${rutas.filter(Boolean).length} archivos versionados, ninguno basura`);
