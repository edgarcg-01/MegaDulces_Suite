/* eslint-disable no-console */
/**
 * BACKFILL del crosswalk de almacén (normalización clase B, paso 1).
 * Puebla commercial.warehouses.{kepler_code, wincaja_source_branch, sells_to_public}
 * derivándolos del `code`/`name`/`kind` reales. Idempotente (solo SET, no borra).
 *
 * Mapeo (derivado de STOCK_BRANCH_MAP + import-cedis-stock-wincaja + los 27 warehouses):
 *   - code '00'..'05'  -> kepler_code = code (sucursales Kepler md_00..md_05)
 *   - code '00' (CEDIS) -> wincaja_source_branch = '00' (Wincaja Irapuato surte la existencia)
 *   - MD-30/32/50       -> wincaja_source_branch = 30/32/50 (wincaja-only)
 *   - kind='truck'      -> sells_to_public = true (ruta)
 *   - '00' (CEDIS)      -> sells_to_public = false (mayoreo/CEDIS)
 *   - retail 01-05, MD-*-> sells_to_public = true
 *   - ambiguos (01-00N sub-rutas PH) -> se dejan NULL (curación humana, se reportan)
 *
 * Uso:  node database/scripts/backfill-warehouse-crosswalk.js            # DRY-RUN (no escribe)
 *       node database/scripts/backfill-warehouse-crosswalk.js --apply    # escribe
 * Conexión: DATABASE_URL_NEW (o DATABASE_URL). Requiere que la migración de columnas ya exista.
 */
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

function planFor(w) {
  const code = String(w.code || '').trim();
  const kind = String(w.kind || '').trim();
  let kepler_code = null, wincaja_source_branch = null, sells_to_public = null, note = '';

  if (/^0[0-5]$/.test(code)) kepler_code = code;                 // sucursal Kepler
  if (code === '00') { wincaja_source_branch = '00'; sells_to_public = false; note = 'CEDIS (kepler+wincaja Irapuato, mayoreo)'; }
  else if (/^MD-(30|32|50)$/.test(code)) { wincaja_source_branch = code.slice(3); sells_to_public = true; note = 'wincaja-only'; }
  else if (/^0[1-5]$/.test(code)) { sells_to_public = true; note = 'sucursal retail Kepler'; }
  else if (kind === 'truck') { sells_to_public = true; note = 'camión de ruta'; }
  else { note = 'AMBIGUO → curación (se deja NULL)'; }

  return { kepler_code, wincaja_source_branch, sells_to_public, note };
}

(async () => {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) { console.error('falta DATABASE_URL_NEW'); process.exit(2); }
  const ssl = /rlwy|railway/.test(cs) ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: cs, ssl, statement_timeout: 30000 });
  await c.connect();

  // verificar que las columnas existan (migración aplicada)
  const cols = (await c.query(`SELECT column_name FROM information_schema.columns
     WHERE table_schema='commercial' AND table_name='warehouses'
       AND column_name IN ('kepler_code','wincaja_source_branch','sells_to_public')`)).rows.map(r => r.column_name);
  if (cols.length < 3) {
    if (APPLY) { console.error(`✗ faltan columnas (${cols.join(',') || 'ninguna'}) — aplicar la migración 20260815130000 primero`); process.exit(3); }
    console.warn(`  (aviso: columnas aún no existen en prod — dry-run muestra el mapeo, no escribe)\n`);
  }

  const ws = (await c.query(`SELECT id, code, name, kind FROM commercial.warehouses
     WHERE tenant_id=$1 AND deleted_at IS NULL ORDER BY code`, [TENANT])).rows;

  console.log(`\n=== Crosswalk de almacén (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${ws.length} warehouses ===\n`);
  console.log('  code'.padEnd(16) + 'kepler'.padEnd(8) + 'wincaja'.padEnd(9) + 'público'.padEnd(9) + 'nota');
  console.log('  ' + '─'.repeat(76));
  let ambiguos = 0, written = 0;
  for (const w of ws) {
    const p = planFor(w);
    if (p.note.startsWith('AMBIGUO')) ambiguos++;
    console.log('  ' + String(w.code).padEnd(14) + String(p.kepler_code ?? '·').padEnd(8) +
      String(p.wincaja_source_branch ?? '·').padEnd(9) + String(p.sells_to_public ?? '·').padEnd(9) + p.note);
    if (APPLY) {
      await c.query(`UPDATE commercial.warehouses SET kepler_code=$2, wincaja_source_branch=$3,
        sells_to_public=$4, updated_at=now() WHERE id=$1`,
        [w.id, p.kepler_code, p.wincaja_source_branch, p.sells_to_public]);
      written++;
    }
  }
  console.log(`\n  ${ws.length} warehouses · ${ambiguos} ambiguos (NULL, curación) · ${APPLY ? written + ' escritos' : 'DRY-RUN (sin escribir)'}`);
  if (!APPLY) console.log('  → correr con --apply para escribir.');
  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
