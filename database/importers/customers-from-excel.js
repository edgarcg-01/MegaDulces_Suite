/* eslint-disable no-console */
/**
 * Importer: carga clientes del maestro Kepler (Excel CLIENTES RUTAS, hojas por
 * ruta) a `commercial.customers`. Carga de data (no migración), idempotente por
 * (tenant_id, code) vía onConflict ignore — re-correr no duplica.
 *
 * Entrada: `database/_cli.json` = [[hoja, code, name], ...] generado del xlsx con:
 *   python -c "import pandas as pd,json; ..."  (ver sesión; xlsx está gitignored)
 *
 * Reglas de `code` (llave única, NOT NULL):
 *   - código numérico único        → tal cual (linkea con Kepler).
 *   - código numérico duplicado     → sufijo incremental (100, 100-1, 100-2…).
 *   - código basura (sin dígito)    → generado IMP-<rutaNum>[-n] (nombre es real).
 * Ruta de venta → `notes` ("Ruta: RUTA 28"), porque customers.route_id apunta a
 * logistics.routes (destinos de embarque), no a las rutas de venta.
 *
 * Uso:
 *   local: node database/importers/customers-from-excel.js
 *   prod : TARGET_DB_URL="postgres://..." node database/importers/customers-from-excel.js
 *   dry-run: agregar --dry
 */
const fs = require('fs');
const path = require('path');

const T = '00000000-0000-0000-0000-00000000d01c';
const DRY = process.argv.includes('--dry');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_cli.json'), 'utf-8'));

const SHEET_ROUTE = {
  'ruta 21': 'RUTA 21', 'ruta 22': 'RUTA 22', 'ruta 23': 'RUTA 23',
  'ruta 26': 'RUTA 26', 'ruta 27': 'RUTA 27', 'ruta 28': 'RUTA 28',
  'ruta 321': 'RUTA 321', 'ruta 322': 'RUTA 322',
  'RUTA 501': 'RUTA 501', 'RUTA 502': 'RUTA 502', 'RUTA 503': 'RUTA 503',
  'RUTA 504': 'RUTA 504', 'RUTA 505': 'RUTA 505',
};

const conn = process.env.TARGET_DB_URL
  ? { client: 'pg', connection: { connectionString: process.env.TARGET_DB_URL, ssl: { rejectUnauthorized: false } } }
  : require('../knexfile-newdb.js').development;
const knex = require('knex')(conn);

(async () => {
  const used = new Set();
  const records = [];
  for (const [sheet, rawCode, name] of rows) {
    const routeName = SHEET_ROUTE[sheet] || sheet;
    const routeNum = (routeName.match(/\d+/) || ['X'])[0];
    let base = /\d/.test(rawCode) ? rawCode.trim() : `IMP-${routeNum}`;
    let code = base, i = 1;
    while (used.has(code)) { code = `${base}-${i}`; i++; }
    used.add(code);
    records.push({
      tenant_id: T,
      code,
      name: name.slice(0, 250),
      active: true,
      notes: `Ruta: ${routeName}`,
    });
  }
  console.log(`Preparados ${records.length} clientes (códigos únicos: ${used.size}). target=${process.env.TARGET_DB_URL ? 'PROD' : 'local'}${DRY ? ' [DRY]' : ''}`);

  if (DRY) {
    const dups = records.length - used.size;
    console.log('ejemplos:', records.slice(0, 4).map((r) => `${r.code}|${r.name}|${r.notes}`).join('  ·  '));
    console.log('códigos generados/sufijados:', records.filter((r) => r.code.includes('-') || r.code.startsWith('IMP')).length, '| colisiones resueltas:', dups);
    await knex.destroy();
    return;
  }

  const before = await knex('commercial.customers').where({ tenant_id: T }).count('* as n').first();
  let inserted = 0;
  for (let j = 0; j < records.length; j += 500) {
    const batch = records.slice(j, j + 500);
    const res = await knex('commercial.customers')
      .insert(batch)
      .onConflict(['tenant_id', 'code'])
      .ignore();
    inserted += res.rowCount ?? 0;
  }
  const after = await knex('commercial.customers').where({ tenant_id: T }).count('* as n').first();
  console.log(`customers antes=${before.n} → después=${after.n} (insertados nuevos: ${Number(after.n) - Number(before.n)})`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
