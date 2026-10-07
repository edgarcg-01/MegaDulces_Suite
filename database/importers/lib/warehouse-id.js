'use strict';
/**
 * Normalización ALMACÉN — Paso 2b. Resuelve warehouse_code (texto) → warehouse_id (uuid) para que
 * los importers pueblen warehouse_id INLINE (las filas nuevas no quedan NULL; el backfill batch1 solo
 * llenó lo existente). Map por `code` + `kepler_code` (incluye Canindo '06' → MD-50). Un solo query.
 *
 *   const { loadWarehouseMap } = require('../lib/warehouse-id');
 *   const whMap = await loadWarehouseMap(db, TENANT);         // db = knex a la newdb (prod)
 *   ...insert({ ..., warehouse_id: whMap.get(String(code).trim()) || null })
 *
 * Devuelve un Map<string,uuid>. Si un code no está, .get() devuelve undefined → usar `|| null`.
 */
async function loadWarehouseMap(db, tenantId) {
  const rows = await db('commercial.warehouses')
    .where({ tenant_id: tenantId }).whereNull('deleted_at')
    .select('id', 'code', 'kepler_code');
  const m = new Map();
  for (const r of rows) {
    if (r.code) m.set(String(r.code).trim(), r.id);
    if (r.kepler_code) m.set(String(r.kepler_code).trim(), r.id);
  }
  return m;
}

module.exports = { loadWarehouseMap };
