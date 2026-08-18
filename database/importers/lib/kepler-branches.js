/**
 * FUENTE ÚNICA de las sucursales Kepler (reemplaza el arreglo duplicado en ~40 importers).
 *
 * Contexto (normalización ALMACÉN, paso 3): el SET de sucursales + su código canónico ya
 * vive en `commercial.warehouses.kepler_code` (paso 1, en la DB). Pero la RESOLUCIÓN DE
 * CONEXIÓN (host/port/db + creds read-only) es INFRAESTRUCTURA — no va en la DB de negocio.
 * Este módulo centraliza esa infra en UN solo lugar, con override por env y helper de
 * cross-check contra la DB (verifyAgainstDb) para cazar drift.
 *
 * Dos shapes históricos que hay que preservar exactamente:
 *   - STOCK/reorden:  { code, url }                         (env STOCK_BRANCH_MAP)
 *   - SALES/kardex:   { code, host, port, db, name, url }   (env SALES_BRANCH_MAP)
 * Y dos variantes: con o sin CEDIS '00' (el stock del '00' viene de Wincaja, NO de Kepler
 * — ver import-cedis-stock-wincaja; pero reorden/ventas SÍ leen md_00).
 *
 * Canindo ('06') es una rama especial: su POS migró de Wincaja a Kepler pero NO expone
 * `platform_ro` en host remoto → se lee del REPLICA LÓGICO LOCAL `kepler_md_06` (@ :5433),
 * que la replicación nativa mantiene al día. `urlOf`/`clientConfig` resuelven eso de forma
 * transparente (el schema `md.*` es idéntico en el POS remoto y en el replica local).
 *
 * PREFERIR `clientConfig(b, {timeouts})` para `new Client()` en vez de hardcodear
 * host/port+cred: así Canindo (y futuras ramas sin platform_ro) funcionan sin tocar el importer:
 *   const { salesMap, clientConfig } = require('../lib/kepler-branches');
 *   const MAP = process.env.SALES_BRANCH_MAP ? JSON.parse(process.env.SALES_BRANCH_MAP) : salesMap();
 *   const c = new Client(clientConfig(b, { statement_timeout: 60000 }));
 */
'use strict';

// Credenciales read-only del ERP. Centralizadas + env-overridable (paso hacia sacar el
// hardcode; hoy default = el mismo valor que estaba inline en los 40 importers).
const USER = process.env.KEPLER_RO_USER || 'platform_ro';
const PASS = process.env.KEPLER_RO_PASS || 'kepler123';
// Base del contenedor de réplicas lógicas locales (para ramas sin platform_ro remoto, ej.
// Canindo). Mismo default que replicate-ods-live.js (SUB_BASE). Env-overridable.
const REPLICA_BASE = process.env.KEPLER_REPLICA_BASE || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

// Sucursales Kepler. host/port/db = infra (tercer octeto de IP = plaza). Orden 00..06.
// '06' Canindo NO tiene host remoto con platform_ro → `replica` marca que se lee del
// replica lógico local kepler_md_06 (ver urlOf).
const BRANCHES = Object.freeze([
  { code: '00', host: '192.168.9.95', port: 5432, db: 'md_00', name: 'CEDIS' },
  { code: '01', host: '192.168.10.10', port: 1977, db: 'md_01', name: 'Padre Hidalgo' },
  { code: '02', host: '192.168.42.42', port: 5432, db: 'md_02', name: 'La Piedad Abastos' },
  { code: '03', host: '192.168.40.40', port: 5432, db: 'md_03', name: '8 Esquinas' },
  { code: '04', host: '192.168.44.44', port: 5432, db: 'md_04', name: 'Yurécuaro' },
  { code: '05', host: '192.168.54.54', port: 5432, db: 'md_05', name: 'Zamora Centro' },
  { code: '06', replica: 'kepler_md_06', name: 'Canindo' },
]);

// URL de conexión por rama: remoto (platform_ro) para 00-05; réplica local para las que
// tienen `replica` (Canindo). El schema `md.*` es idéntico → transparente al importer.
const urlOf = (b) => {
  if (b.replica) { const u = new URL(REPLICA_BASE); u.pathname = `/${b.replica}`; return u.toString(); }
  return `postgresql://${USER}:${PASS}@${b.host}:${b.port}/${b.db}`;
};

/** Config lista para `new Client()` — resuelve la conexión correcta por rama sin hardcodear
 *  host/port+cred en cada importer. Prefiere `b.url` (lo que traen las entradas de salesMap/
 *  stockMap) y cae a urlOf(b) para entradas crudas de BRANCHES. `extra` = timeouts u otras
 *  opciones de pg.Client. */
const clientConfig = (b, extra = {}) => ({ connectionString: b.url || urlOf(b), ...extra });

/** Shape SALES: [{code,host,port,db,name,url}]. `cedis` (default true) incluye md_00.
 *  `url` resuelto por rama (Canindo = replica local) → usar con clientConfig o connectionString. */
function salesMap({ cedis = true } = {}) {
  return BRANCHES.filter((b) => cedis || b.code !== '00')
    .map((b) => ({ code: b.code, host: b.host, port: b.port, db: b.db, name: b.name, url: urlOf(b) }));
}

/** Shape STOCK: [{code,url}]. `cedis` (default false) — el stock de '00' viene de Wincaja. */
function stockMap({ cedis = false } = {}) {
  return BRANCHES.filter((b) => cedis || b.code !== '00')
    .map((b) => ({ code: b.code, url: urlOf(b) }));
}

/** URL de conexión de UNA sucursal por código ('00'..'06'). Para importers single-branch
 *  (leen solo CEDIS md_00, o md_03/md_01). Centraliza la cred que estaba inline. */
function branchUrl(code) {
  const b = BRANCHES.find((x) => x.code === code);
  if (!b) throw new Error(`kepler-branches: código de sucursal desconocido '${code}'`);
  return urlOf(b);
}

/**
 * Cross-check contra la dim canónica: compara los kepler_code de commercial.warehouses
 * con los codes 01-06 de este módulo. Devuelve {ok, missingInDb, missingInModule}.
 * No lanza — para usar como alerta (dead-man) desde un feed o el scanner de salud.
 */
async function verifyAgainstDb(pgClient, tenantId = '00000000-0000-0000-0000-00000000d01c') {
  const { rows } = await pgClient.query(
    `SELECT kepler_code FROM commercial.warehouses
      WHERE tenant_id=$1 AND kepler_code IS NOT NULL AND deleted_at IS NULL`, [tenantId]);
  const dbCodes = new Set(rows.map((r) => r.kepler_code));
  const modelCodes = new Set(BRANCHES.filter((b) => b.code !== '00').map((b) => b.code)); // 01-06 (00 no es Kepler)
  const missingInDb = [...modelCodes].filter((c) => !dbCodes.has(c));
  const missingInModule = [...dbCodes].filter((c) => !modelCodes.has(c));
  return { ok: !missingInDb.length && !missingInModule.length, missingInDb, missingInModule };
}

module.exports = { BRANCHES, salesMap, stockMap, branchUrl, urlOf, clientConfig, verifyAgainstDb, USER, PASS };
