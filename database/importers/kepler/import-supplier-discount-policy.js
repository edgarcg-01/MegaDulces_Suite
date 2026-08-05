/**
 * RE.10 — Política de descuento por proveedor (tasa OBSERVADA).
 *
 * Deriva `commercial.supplier_discount_policy.expected_discount_rate` del historial:
 * para cada proveedor que HA capturado descuento (`analytics.erp_supplier_payments.descuento`
 * > 0) en ≥2 pagos, toma la MEDIANA de la tasa capturada (descuento/monto) como la tasa
 * "esperada". Esa es la base contra la que el detector marca los pagos que NO la tomaron.
 *
 * Computado 100% dentro de la newdb (no toca Kepler LAN). Idempotente: UPSERT que
 * SOLO pisa filas `source='observed'` — respeta las capturadas a mano (manual/kepler).
 *
 * Uso:
 *   node database/importers/kepler/import-supplier-discount-policy.js            # dry-run
 *   node database/importers/kepler/import-supplier-discount-policy.js --apply    # commit
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const M = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const MIN_PAGOS = 2; // señal mínima para llamarlo "política"
const APPLY = process.argv.includes('--apply');
const pct = (r) => (Number(r || 0) * 100).toFixed(2) + '%';

// Proveedores con tasa observable: mediana de la tasa capturada entre sus pagos con descuento.
const SELECT = `
  SELECT proveedor_code, max(proveedor_nombre) AS nombre,
         count(*)::int AS n_desc,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY descuento / monto)::numeric, 4) AS rate_median
    FROM analytics.erp_supplier_payments
   WHERE tenant_id = $1 AND descuento > 0 AND monto > 0
   GROUP BY proveedor_code
  HAVING count(*) >= ${MIN_PAGOS} AND round(percentile_cont(0.5) WITHIN GROUP (ORDER BY descuento / monto)::numeric, 4) > 0`;

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  console.log(`=== Política de descuento por proveedor (tasa observada, ≥${MIN_PAGOS} pagos) → commercial.supplier_discount_policy (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  try {
    const rows = (await db.query(SELECT, [M])).rows;
    console.log(`  ${rows.length} proveedores con tasa observable`);
    for (const r of rows.slice(0, 8)) console.log(`    ${r.proveedor_code} ${(r.nombre || '').slice(0, 30).padEnd(30)} tasa=${pct(r.rate_median)} (${r.n_desc} pagos)`);
    if (rows.length > 8) console.log(`    … +${rows.length - 8} más`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
    if (!rows.length) { console.log('\n[APPLY] 0 proveedores (¿pagos sin descuento c84?) — tabla intacta.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const up = await db.query(
      `INSERT INTO commercial.supplier_discount_policy
         (tenant_id, proveedor_code, proveedor_nombre, expected_discount_rate, discount_type, source, active)
       SELECT $1::uuid, proveedor_code, max(proveedor_nombre),
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY descuento / monto)::numeric, 4),
              'pronto_pago', 'observed', true
         FROM analytics.erp_supplier_payments
        WHERE tenant_id = $1 AND descuento > 0 AND monto > 0
        GROUP BY proveedor_code
       HAVING count(*) >= ${MIN_PAGOS} AND round(percentile_cont(0.5) WITHIN GROUP (ORDER BY descuento / monto)::numeric, 4) > 0
       ON CONFLICT (tenant_id, proveedor_code) DO UPDATE
         SET expected_discount_rate = EXCLUDED.expected_discount_rate,
             proveedor_nombre = EXCLUDED.proveedor_nombre,
             updated_at = now()
       WHERE commercial.supplier_discount_policy.source = 'observed'`,
      [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} políticas escritas/actualizadas (solo source='observed'; respeta manual/kepler).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
