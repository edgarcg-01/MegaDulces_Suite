#!/usr/bin/env node
/*
 * RE.12 — Marca las órdenes de entrada DUPLICADAS del CEDIS ('00', servidor 9.95) que
 * son espejo de una recepción de sucursal. La CANÓNICA es SIEMPRE la de sucursal (tiene
 * los productos); la fila CEDIS se marca `dup_of_(sucursal,folio)` → la canónica.
 *
 * Match: (proveedor_rfc + receipt_date + monto); si el RFC falta en algún lado, cae a
 * (proveedor_nombre + fecha + monto). Pick determinista (DISTINCT ON folio CEDIS). Escribe las
 * marcas en analytics.erp_goods_receipt_dedup (UPSERT + limpia obsoletas); la VISTA erp_goods_receipts
 * las lee por LEFT JOIN. Idempotente. Verificado en prod: ~1,240 CEDIS dups / $9.87M.
 *
 * Uso:
 *   node database/importers/kepler/detect-goods-receipt-duplicates.js            # DRY-RUN
 *   node database/importers/kepler/detect-goods-receipt-duplicates.js --apply    # marca
 * Env: DATABASE_URL_NEW (o DATABASE_URL / MIG_DB_URL) → la DB nueva multi-tenant.
 *      TENANT_ID (default Mega Dulces).
 */
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DB_URL = process.env.DATABASE_URL_NEW || process.env.MIG_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) { console.error('Falta DATABASE_URL_NEW / DATABASE_URL'); process.exit(1); }

// Predicado de gemela: c = CEDIS ('00'), s = sucursal (<>'00'), mismo día/monto y proveedor.
const MATCH = `
  s.tenant_id = c.tenant_id AND s.sucursal <> '00' AND s.monto > 0
  AND s.receipt_date = c.receipt_date AND s.monto = c.monto
  AND ( (c.proveedor_rfc IS NOT NULL AND s.proveedor_rfc IS NOT NULL AND c.proveedor_rfc = s.proveedor_rfc)
     OR ((c.proveedor_rfc IS NULL OR s.proveedor_rfc IS NULL) AND c.proveedor_nombre = s.proveedor_nombre) )`;

(async () => {
  const local = /localhost|127\.0\.0\.1|192\.168\./.test(DB_URL);
  const db = new Client({ connectionString: DB_URL, ssl: local ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await db.connect();

  // Guard: la tabla de marcas debe existir (mig 20260820120000). Desde esa migración
  // erp_goods_receipts es VISTA → las marcas viven en analytics.erp_goods_receipt_dedup
  // (la vista las lee por LEFT JOIN). Este importer YA NO hace UPDATE a la vista.
  const tbl = await db.query(`SELECT to_regclass('analytics.erp_goods_receipt_dedup') r`);
  if (!tbl.rows[0].r) { console.error('Falta analytics.erp_goods_receipt_dedup — aplicá la migración 20260820120000 primero.'); process.exit(1); }

  const [{ count }] = (await db.query(
    `SELECT count(*)::int count FROM analytics.erp_goods_receipts c
     WHERE c.tenant_id=$1 AND c.sucursal='00' AND c.monto>0 AND EXISTS (
       SELECT 1 FROM analytics.erp_goods_receipts s WHERE ${MATCH})`, [T],
  )).rows;
  console.log(`\n${APPLY ? 'APLICANDO' : 'DRY-RUN'} — ${count} fila(s) CEDIS ('00') con gemela de sucursal → se marcarán como duplicadas.`);

  if (!APPLY) {
    console.table((await db.query(
      `SELECT c.folio cedis, left(c.proveedor_nombre,24) prov, c.receipt_date::text fecha, c.monto,
              s.sucursal suc, s.folio suc_folio
       FROM analytics.erp_goods_receipts c
       JOIN LATERAL (
         SELECT s.sucursal, s.folio FROM analytics.erp_goods_receipts s WHERE ${MATCH}
         ORDER BY s.sucursal, s.folio LIMIT 1) s ON true
       WHERE c.tenant_id=$1 AND c.sucursal='00' AND c.monto>0 ORDER BY c.receipt_date DESC LIMIT 12`, [T],
    )).rows);
    console.log('\nDry-run. Corré con --apply para marcar.');
    await db.end();
    return;
  }

  await db.query('BEGIN');
  // Materializa la vista UNA vez (evita evaluarla dos veces en el self-join) y calcula las gemelas.
  await db.query(
    `CREATE TEMP TABLE _gr ON COMMIT DROP AS
       SELECT sucursal, folio, receipt_date, monto, proveedor_rfc, proveedor_nombre
         FROM analytics.erp_goods_receipts WHERE tenant_id=$1 AND monto > 0`, [T]);
  await db.query(`CREATE INDEX ON _gr (receipt_date, monto)`);
  // UPSERT de marcas (última gana, determinista) en la tabla de dedup — NO en la vista.
  const upd = await db.query(
    `INSERT INTO analytics.erp_goods_receipt_dedup (tenant_id, cedis_folio, dup_of_sucursal, dup_of_folio, computed_at)
     SELECT DISTINCT ON (c.folio) $1::uuid, c.folio, s.sucursal, s.folio, now()
       FROM _gr c JOIN _gr s ON ${MATCH}
      WHERE c.sucursal='00'
      ORDER BY c.folio, s.sucursal, s.folio
     ON CONFLICT (tenant_id, cedis_folio) DO UPDATE
       SET dup_of_sucursal=EXCLUDED.dup_of_sucursal, dup_of_folio=EXCLUDED.dup_of_folio, computed_at=now()`, [T]);
  // Limpia marcas obsoletas: folios CEDIS que ya no tienen gemela (o cambió el monto/proveedor).
  const del = await db.query(
    `DELETE FROM analytics.erp_goods_receipt_dedup d
      WHERE d.tenant_id=$1
        AND NOT EXISTS (
          SELECT 1 FROM _gr c JOIN _gr s ON ${MATCH}
           WHERE c.sucursal='00' AND c.folio=d.cedis_folio)`, [T]);
  await db.query('COMMIT');
  console.log(`\n[APPLY] ${upd.rowCount} marcadas (UPSERT) · ${del.rowCount} marcas obsoletas eliminadas.`);
  await db.end();
})().catch(async (e) => { console.error('ERR', e.message); process.exit(1); });
