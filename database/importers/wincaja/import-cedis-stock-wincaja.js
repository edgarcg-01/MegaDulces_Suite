/**
 * RA-PRO.24 — Existencia del CEDIS desde WINCAJA (Irapuato), no desde Kepler.
 *
 * Decisión Edgar 2026-07-28: la existencia FÍSICA real del CEDIS vive en el `.mdb`
 * `0 BPIRAPUATO MOV` (Wincaja branch '00'), no en el warehouse contable Kepler '00'
 * "Cedis Oficinas" (que además cargaba pseudo-SKUs contables: 00001 VENTAS AL 0% =97M,
 * 00022 TIEMPO AIRE…, inflando todo).
 *
 * Este feed hace que `commercial.stock` del warehouse '00' = existencia de Wincaja
 * Irapuato (v_stock source_branch='00', mapeada por sku al catálogo). MODO REPLACE:
 * borra las filas '00' (Kepler + fantasmas) e inserta solo lo de Irapuato. Corre
 * DESPUÉS del feed Kepler (que ya NO escribe '00' — ver import-branch-stock-live.js).
 *
 * OJO: hoy el .mdb de Irapuato trae ~149 SKUs con existencia → el CEDIS queda casi
 * vacío para el resto (Ferrero/Kinder = 0) → el sugerido de COMPRA sube y los
 * TRASPASOS de esos SKUs desaparecen (el CEDIS no los tiene). Es lo esperado con esta
 * fuente; si el .mdb está incompleto, reemplazar por el archivo de existencias completo.
 *
 * Uso (desde database/):
 *   node importers/wincaja/import-cedis-stock-wincaja.js            # dry-run
 *   node importers/wincaja/import-cedis-stock-wincaja.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CEDIS_CODE = process.env.CEDIS_WAREHOUSE_CODE || '00'; // warehouse destino (Cedis Oficinas)
const WINCAJA_CEDIS_BRANCH = process.env.WINCAJA_CEDIS_BRANCH || '00'; // Irapuato

// Existencia de Irapuato mapeada al catálogo, agregada por producto (sku duplicado → suma).
const SRC = `
  SELECT p.id AS product_id, GREATEST(SUM(s.existencia), 0) AS qty
  FROM wincaja.v_stock s
  JOIN catalog.products p
    ON p.tenant_id = s.tenant_id AND p.sku = s.sku AND p.deleted_at IS NULL
  WHERE s.tenant_id = ? AND s.source_branch = ? AND s.existencia IS NOT NULL AND s.existencia > 0
  GROUP BY p.id
`;

(async () => {
  const cfg = process.env.DATABASE_URL_NEW
    ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW) ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } }
    : require(path.resolve(__dirname, '..', '..', 'knexfile-newdb.js')).development;
  const db = knexLib(cfg);
  try {
    const wh = (await db.raw(`SELECT id FROM commercial.warehouses WHERE tenant_id=? AND code=? AND deleted_at IS NULL`, [TENANT, CEDIS_CODE])).rows[0];
    if (!wh) { console.error(`No existe warehouse CEDIS code=${CEDIS_CODE}`); await db.destroy(); process.exit(1); }

    const [pre] = (await db.raw(`SELECT count(*)::int n, round(sum(qty)::numeric,0) pz FROM (${SRC}) x`, [TENANT, WINCAJA_CEDIS_BRANCH])).rows;
    const [cur] = (await db.raw(`SELECT count(*)::int n, round(sum(quantity)::numeric,0) pz FROM commercial.stock WHERE tenant_id=? AND warehouse_id=?`, [TENANT, wh.id])).rows;
    console.log(`CEDIS ${CEDIS_CODE} ← Wincaja Irapuato (branch ${WINCAJA_CEDIS_BRANCH}):`);
    console.log(`  actual (Kepler+fantasmas): ${cur.n} SKUs, ${Number(cur.pz || 0).toLocaleString()} pz`);
    console.log(`  nuevo (Irapuato físico)  : ${pre.n} SKUs, ${Number(pre.pz || 0).toLocaleString()} pz`);

    if (!APPLY) { console.log('(dry-run — usar --apply)'); await db.destroy(); return; }

    await db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
      const del = await trx.raw(`DELETE FROM commercial.stock WHERE tenant_id=? AND warehouse_id=?`, [TENANT, wh.id]);
      const ins = await trx.raw(
        `INSERT INTO commercial.stock (tenant_id, warehouse_id, product_id, quantity, reserved_quantity, updated_at)
         SELECT ?, ?, product_id, qty, 0, now() FROM (${SRC}) src`,
        [TENANT, wh.id, TENANT, WINCAJA_CEDIS_BRANCH]);
      console.log(`  REPLACE: -${del.rowCount} viejas / +${ins.rowCount} de Irapuato`);
    });
    console.log('✅ commercial.stock del CEDIS = Wincaja Irapuato.');
  } catch (e) { console.error('ERR', e.message); process.exitCode = 1; }
  finally { await db.destroy(); }
})();
