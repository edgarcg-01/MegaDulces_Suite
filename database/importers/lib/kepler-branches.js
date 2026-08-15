/**
 * FUENTE ÚNICA de las 6 sucursales Kepler (reemplaza el arreglo duplicado en ~40 importers).
 *
 * Contexto (normalización ALMACÉN, paso 3): el SET de sucursales + su código canónico ya
 * vive en `commercial.warehouses.kepler_code` (paso 1, en la DB). Pero la RESOLUCIÓN DE
 * CONEXIÓN (host/port/db + creds read-only) es INFRAESTRUCTURA — no va en la DB de negocio.
 * Este módulo centraliza esa infra en UN solo lugar, con override por env y helper de
 * cross-check contra la DB (verifyAgainstDb) para cazar drift.
 *
 * Dos shapes históricos que hay que preservar exactamente:
 *   - STOCK/reorden:  { code, url }                         (env STOCK_BRANCH_MAP)
 *   - SALES/kardex:   { code, host, port, db, name }         (env SALES_BRANCH_MAP)
 * Y dos variantes: con o sin CEDIS '00' (el stock del '00' viene de Wincaja, NO de Kepler
 * — ver import-cedis-stock-wincaja; pero reorden/ventas SÍ leen md_00).
 *
 * Cada importer conserva su check de env (compatibilidad); solo el DEFAULT sale de aquí:
 *   const { stockMap } = require('../lib/kepler-branches');
 *   const MAP = process.env.STOCK_BRANCH_MAP ? JSON.parse(process.env.STOCK_BRANCH_MAP) : stockMap();
 */
'use strict';

// Credenciales read-only del ERP. Centralizadas + env-overridable (paso hacia sacar el
// hardcode; hoy default = el mismo valor que estaba inline en los 40 importers).
const USER = process.env.KEPLER_RO_USER || 'platform_ro';
const PASS = process.env.KEPLER_RO_PASS || 'kepler123';

// Las 6 sucursales Kepler. host/port/db = infra (tercer octeto de IP = plaza). Orden 00..05.
const BRANCHES = Object.freeze([
  { code: '00', host: '192.168.9.95', port: 5432, db: 'md_00', name: 'CEDIS' },
  { code: '01', host: '192.168.10.10', port: 1977, db: 'md_01', name: 'Padre Hidalgo' },
  { code: '02', host: '192.168.42.42', port: 5432, db: 'md_02', name: 'La Piedad Abastos' },
  { code: '03', host: '192.168.40.40', port: 5432, db: 'md_03', name: '8 Esquinas' },
  { code: '04', host: '192.168.44.44', port: 5432, db: 'md_04', name: 'Yurécuaro' },
  { code: '05', host: '192.168.54.54', port: 5432, db: 'md_05', name: 'Zamora Centro' },
]);

const urlOf = (b) => `postgresql://${USER}:${PASS}@${b.host}:${b.port}/${b.db}`;

/** Shape SALES: [{code,host,port,db,name}]. `cedis` (default true) incluye md_00. */
function salesMap({ cedis = true } = {}) {
  return BRANCHES.filter((b) => cedis || b.code !== '00')
    .map((b) => ({ code: b.code, host: b.host, port: b.port, db: b.db, name: b.name }));
}

/** Shape STOCK: [{code,url}]. `cedis` (default false) — el stock de '00' viene de Wincaja. */
function stockMap({ cedis = false } = {}) {
  return BRANCHES.filter((b) => cedis || b.code !== '00')
    .map((b) => ({ code: b.code, url: urlOf(b) }));
}

/** URL de conexión de UNA sucursal por código ('00'..'05'). Para importers single-branch
 *  (leen solo CEDIS md_00, o md_03/md_01). Centraliza la cred que estaba inline. */
function branchUrl(code) {
  const b = BRANCHES.find((x) => x.code === code);
  if (!b) throw new Error(`kepler-branches: código de sucursal desconocido '${code}'`);
  return urlOf(b);
}

/**
 * Cross-check contra la dim canónica: compara los kepler_code de commercial.warehouses
 * con los codes 01-05 de este módulo. Devuelve {ok, missingInDb, missingInModule}.
 * No lanza — para usar como alerta (dead-man) desde un feed o el scanner de salud.
 */
async function verifyAgainstDb(pgClient, tenantId = '00000000-0000-0000-0000-00000000d01c') {
  const { rows } = await pgClient.query(
    `SELECT kepler_code FROM commercial.warehouses
      WHERE tenant_id=$1 AND kepler_code IS NOT NULL AND deleted_at IS NULL`, [tenantId]);
  const dbCodes = new Set(rows.map((r) => r.kepler_code));
  const modelCodes = new Set(BRANCHES.filter((b) => b.code !== '00').map((b) => b.code)); // 01-05 (00 no es Kepler)
  const missingInDb = [...modelCodes].filter((c) => !dbCodes.has(c));
  const missingInModule = [...dbCodes].filter((c) => !modelCodes.has(c));
  return { ok: !missingInDb.length && !missingInModule.length, missingInDb, missingInModule };
}

module.exports = { BRANCHES, salesMap, stockMap, branchUrl, urlOf, verifyAgainstDb, USER, PASS };
