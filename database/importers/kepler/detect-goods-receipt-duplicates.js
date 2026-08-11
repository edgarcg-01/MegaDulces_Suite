#!/usr/bin/env node
/*
 * RE.12 — Marca las órdenes de entrada DUPLICADAS del CEDIS ('00', servidor 9.95) que
 * son espejo de una recepción de sucursal. La CANÓNICA es SIEMPRE la de sucursal (tiene
 * los productos); la fila CEDIS se marca `dup_of_(sucursal,folio)` → la canónica.
 *
 * Match: (proveedor_rfc + receipt_date + monto); si el RFC falta en algún lado, cae a
 * (proveedor_nombre + fecha + monto). Pick determinista (DISTINCT ON folio CEDIS). Recompute
 * completo cada corrida (resetea antes). Idempotente. Verificado en prod: ~1,139 CEDIS dups.
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

  // Guard: columnas presentes (la migración 20260811120000 debe estar aplicada).
  const col = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='analytics' AND table_name='erp_goods_receipts' AND column_name='dup_of_folio'`,
  );
  if (!col.rowCount) { console.error('Falta la columna dup_of_folio — aplicá la migración 20260811120000 primero.'); process.exit(1); }

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
  const reset = await db.query(
    `UPDATE analytics.erp_goods_receipts SET dup_of_sucursal=NULL, dup_of_folio=NULL
     WHERE tenant_id=$1 AND sucursal='00' AND dup_of_folio IS NOT NULL`, [T]);
  const upd = await db.query(
    `WITH pairs AS (
       SELECT DISTINCT ON (c.folio) c.folio AS cedis_folio, s.sucursal AS suc, s.folio AS suc_folio
       FROM analytics.erp_goods_receipts c
       JOIN analytics.erp_goods_receipts s ON ${MATCH}
       WHERE c.tenant_id=$1 AND c.sucursal='00' AND c.monto>0
       ORDER BY c.folio, s.sucursal, s.folio
     )
     UPDATE analytics.erp_goods_receipts c
     SET dup_of_sucursal=p.suc, dup_of_folio=p.suc_folio
     FROM pairs p WHERE c.tenant_id=$1 AND c.sucursal='00' AND c.folio=p.cedis_folio`, [T]);
  await db.query('COMMIT');
  console.log(`\n[APPLY] ${reset.rowCount} reseteadas · ${upd.rowCount} marcadas como duplicadas de su sucursal.`);
  await db.end();
})().catch(async (e) => { console.error('ERR', e.message); process.exit(1); });
