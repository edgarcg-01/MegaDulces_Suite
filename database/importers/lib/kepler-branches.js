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
// ⚠️ NO poner un throw acá: es un const de NIVEL DE MÓDULO → tumbaría el `require` de kepler-branches
// para TODOS los procesos que lo importan (poller de tickets Kepler, setup-branch-subscriber, ods-cdc…),
// aunque no toquen una réplica. Pasó 2026-09-09: el refactor de fallbacks metió un throw y mató el poller
// Kepler → /tienda/live solo mostraba Morelia Abastos. El dbname es TEMPLATE: `urlOf` (abajo) lo reemplaza
// por `kepler_md_0X`, así que sólo importan host/puerto/credencial → el default al contenedor local sirve.
const REPLICA_BASE = process.env.KEPLER_REPLICA_BASE || 'postgresql://postgres:superoot@localhost:5433/postgres';

// Sucursales Kepler. host/port/db = infra (tercer octeto de IP = plaza). Orden 00..07.
// Una rama puede tener host (POS remoto con platform_ro) Y replica (base lógica local): NO son
// excluyentes. urlOf prefiere el POS; el shipper del ODS usa replicaDbName/replicaUrl, que son
// independientes de urlOf. La '06' Canindo tuvo SÓLO replica hasta el 2026-09-12, cuando se
// verificó que su POS (192.168.50.50:1977) SÍ expone platform_ro (misma credencial compartida) —
// antes de ese día su platform_ro tenía otra contraseña, por eso figuraba como replica-only.
const BRANCHES = Object.freeze([
  { code: '00', host: '192.168.9.95', port: 5432, db: 'md_00', name: 'CEDIS' },
  { code: '01', host: '192.168.10.10', port: 1977, db: 'md_01', name: 'Padre Hidalgo' },
  { code: '02', host: '192.168.42.42', port: 5432, db: 'md_02', name: 'La Piedad Abastos' },
  { code: '03', host: '192.168.40.40', port: 5432, db: 'md_03', name: '8 Esquinas' },
  { code: '04', host: '192.168.44.44', port: 5432, db: 'md_04', name: 'Yurécuaro' },
  { code: '05', host: '192.168.54.54', port: 5432, db: 'md_05', name: 'Zamora Centro' },
  // '06' Canindo: POS alcanzable con platform_ro desde 2026-09-12 (así los importers leen el POS
  // fresco en vez de la réplica; el ODS sigue leyendo kepler_md_06 vía replicaDbName). Antes, sin
  // POS legible, su contabilidad de septiembre nunca llegaba (kdc22609 sólo replicaba vía ods_repl,
  // que no la podía leer — ver ERP_KEPLER §4.2b).
  { code: '06', host: '192.168.50.50', port: 1977, db: 'md_06', replica: 'kepler_md_06', name: 'Canindo' },
  // '07' Morelia Madero: su POS migró de Wincaja ('32') a Kepler propio (`md_07`) el 2026-09-08
  // (handoff limpio — Wincaja 32 cerró caja el 09-07, Kepler arrancó el 09-08, cero traslape).
  // Replica-only: aún NO se verificó platform_ro en su POS (queda como deuda; sus importers leen la
  // réplica local kepler_md_07 hasta entonces).
  { code: '07', replica: 'kepler_md_07', name: 'Morelia Madero' },
]);

// URL de conexión por rama para los IMPORTERS: prefiere el POS remoto (platform_ro) cuando la rama
// tiene host; cae a la réplica lógica local sólo si NO hay POS legible (07). El schema `md.*` es
// idéntico en ambos → transparente al importer. ⚠️ El shipper del ODS NO pasa por acá: usa
// replicaDbName/replicaUrl, que SIEMPRE dan la réplica (es lo que ese carril mantiene al día).
const urlOf = (b) => {
  if (b.host) return `postgresql://${USER}:${PASS}@${b.host}:${b.port}/${b.db}`;
  if (b.replica) { const u = new URL(REPLICA_BASE); u.pathname = `/${b.replica}`; return u.toString(); }
  throw new Error(`kepler-branches: la rama '${b.code}' no tiene ni host ni replica`);
};

/** Config lista para `new Client()` — resuelve la conexión correcta por rama sin hardcodear
 *  host/port+cred en cada importer. Prefiere `b.url` (lo que traen las entradas de salesMap/
 *  stockMap) y cae a urlOf(b) para entradas crudas de BRANCHES. `extra` = timeouts u otras
 *  opciones de pg.Client. */
const clientConfig = (b, extra = {}) => ({ connectionString: b.url || urlOf(b), ...extra });

/** Shape SALES: [{code,host,port,db,name,url,replica}]. `cedis` (default true) incluye md_00.
 *  `url` resuelto por rama (Canindo = replica local) → usar con clientConfig o connectionString.
 *  `replica` (null para las ramas con POS remoto) expone el nombre de la base réplica. Se agregó
 *  2026-09-11: sin él, un consumidor NO PUEDE distinguir una rama que lee del POS de una que lee de
 *  una réplica lógica, y por lo tanto no puede comprobar que esa réplica siga RECIBIENDO. Ese día
 *  la réplica de `.249` quedó congelada (suscripciones en DISABLE por VL.2c) y el poller de tickets
 *  leyó 137 min de nada **sin un solo error**: la consulta funciona, la base existe, sólo dejó de
 *  avanzar. Poblado ≠ fresco (ADR-056). */
function salesMap({ cedis = true } = {}) {
  return BRANCHES.filter((b) => cedis || b.code !== '00')
    .map((b) => ({ code: b.code, host: b.host, port: b.port, db: b.db, name: b.name, url: urlOf(b), replica: b.replica || null }));
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
 * Nombre de la RÉPLICA LÓGICA LOCAL de una sucursal, en el contenedor `pgvector-md` (:5433).
 *
 * Las 7 réplicas siguen UNA sola convención — `kepler_md_00` … `kepler_md_06`. Antes no: la '03'
 * se llamaba `kepler_pilot` y ocho scripts cargaban a mano el caso especial
 * `code === '03' ? 'kepler_pilot' : …`; la colisión se resolvió el 2026-09-07 renombrando la
 * réplica. Este helper existe para que la convención tenga UN dueño: si mañana entra una rama que
 * no la sigue, se arregla acá y no en ocho archivos (ADR-056 — un primitivo copiado a mano no
 * cierra nada).
 *
 * OJO: NO es lo mismo que `urlOf`. `urlOf` da el POS (el ERP remoto, o la réplica sólo para
 * Canindo); esto da SIEMPRE la réplica local, que es contra lo que trabajan los carriles del ODS
 * (`replicate-ods-live`, los `ods-cdc-*`, los `reconcile-ods-*`).
 */
const replicaDbName = (code) => `kepler_md_${code}`;

/** URL de la réplica local de una sucursal. `base` = la URL del contenedor de réplicas, que cada
 *  carril resuelve con SU propia env var (`ODS_SOURCE_BASE` / `SUB_BASE`): no se elige acá porque
 *  el reparto de env vars entre origen y prod es justo la trampa de GOTCHAS §17/§18. */
const replicaUrl = (code, base) => {
  const u = new URL(base);
  u.pathname = `/${replicaDbName(code)}`;
  return u.toString();
};

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
  const modelCodes = new Set(BRANCHES.filter((b) => b.code !== '00').map((b) => b.code)); // 01-07 (00 no es Kepler)
  const missingInDb = [...modelCodes].filter((c) => !dbCodes.has(c));
  const missingInModule = [...dbCodes].filter((c) => !modelCodes.has(c));
  return { ok: !missingInDb.length && !missingInModule.length, missingInDb, missingInModule };
}

module.exports = {
  BRANCHES, salesMap, stockMap, branchUrl, urlOf, clientConfig, verifyAgainstDb,
  replicaDbName, replicaUrl, USER, PASS,
};
