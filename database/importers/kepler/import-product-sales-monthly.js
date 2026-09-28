/* eslint-disable no-console */
/**
 * `[AUD-DAT.10]` — **La venta mensual por producto DEJA DE SER UNA SEGUNDA LECTURA
 * y pasa a DERIVARSE de la diaria.** `analytics.product_sales_monthly` ya no lee los
 * 6 servidores Kepler: es el rollup de `analytics.product_sales_daily`.
 *
 * ── POR QUÉ CAMBIÓ (medido en prod, 2026-09-28) ─────────────────────────────────
 * Las dos tablas son hermanas, corren en el mismo carril nocturno y llevaban meses
 * contradiciéndose. Medido por mes cerrado:
 *
 *      mes        diaria      mensual     falta
 *      2026-06    720,533     398,622     44.7 %
 *      2026-07    978,698     623,677     36.3 %
 *      2026-08    955,432     760,468     20.4 %
 *
 * ⭐ Y la clave estaba en 2025: **cuadra al peso, mes por mes** (452,018 = 452,018,
 * 356,829 = 356,829, las doce). La divergencia vive SÓLO en 2026, y **no es de
 * unidades sino de FILAS**: enero-2026 tiene 89,358 filas en la diaria y **5,033**
 * en la mensual.
 *
 * ⛔ La causa era este mismo archivo. Su `DELETE` estaba acotado al **año en curso**
 * (`--year`, default `getFullYear()`) y borraba cada noche TODO 2026 que la
 * consulta Kepler-sola no devolviera — o sea, toda fila escrita por otro ERP.
 * 2025 sobrevive intacto justamente porque **ya nadie lo borra**.
 *
 * El daño concreto, agosto-2026:
 *   · `06` (Canindo) migró de Wincaja a Kepler el **2026-08-15** →  el mes está
 *     partido. Kepler sólo tiene del 15 al 31, así que el DELETE se comía los
 *     primeros 14 días: 100,037 u publicadas contra 198,248 en la diaria.
 *   · `MD-32` quedó en **0** con 94,400 u en la diaria.
 *
 * ⛔ Y la frontera de cada sucursal **es un dato**, no un literal:
 * `analytics.v_branch_erp_cutover`. Este importer la tenía hardcodeada como
 * `IN ('MD-30','MD-32')` y por eso `06` y `MD-50` se caían por la rendija.
 * Derivando de la diaria el problema **desaparece por construcción**: no hay dos
 * lecturas que reconciliar, hay una sola y su rollup.
 *
 * ── QUÉ NO ARREGLA (declarado, no disimulado) ───────────────────────────────────
 * ⚠️ Hereda lo bueno y lo malo de `product_sales_daily`, que hace UPSERT con
 * `GREATEST` y **nunca borra**: una corrección a la baja no se propaga. Es el modo
 * de falla más benigno de los dos (retiene historia de la era Wincaja en vez de
 * destruirla), pero es real y no se tapa acá.
 *
 * ⚠️ `product_sales_daily` NO cuadra con `analytics.sales_daily`, que además **no
 * tiene una sola fila de `MD-32` en ningún mes**. O sea: ninguna de las tres tiene
 * la verdad completa. Esa reconciliación es otro item; acá sólo se garantiza que
 * la mensual **no puede** volver a contradecir a la diaria.
 *
 *   DATABASE_URL_NEW=…  node database/importers/kepler/import-product-sales-monthly.js           # dry-run: mide el diff
 *   DATABASE_URL_NEW=…  node database/importers/kepler/import-product-sales-monthly.js --apply
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

/**
 * Freno del `DELETE`. La diaria es superset de la mensual en TODA la historia
 * medida (2025 y anteriores cuadran fila por fila), así que un huérfano legítimo
 * es rarísimo. Si de golpe aparecen muchos, es que la diaria se vació o se movió
 * de llave — y entonces borrar sería propagar el daño, no limpiarlo.
 *
 * ⛔ Un freno sin prueba negativa es una intención: el candado
 * `database/tests/test-newdb-product-sales-parity.js` lo rompe a propósito.
 */
const MAX_HUERFANOS_PCT = 5;
const MAX_HUERFANOS_PISO = 500; // por debajo de esto no vale la pena frenar

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  try {
    console.log(`\n=== VENTA mensual x producto ← rollup de product_sales_daily (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    // El origen, agregado una sola vez. Temp table (no CTE) para que el DELETE
    // de abajo pueda usar índice en vez de re-agregar 1.7 M filas por cada fila
    // del destino.
    await db.query(
      `CREATE TEMP TABLE stg_psm ON COMMIT DROP AS
         SELECT product_id, warehouse_id,
                date_trunc('month', sale_date)::date AS month,
                sum(units) AS units
           FROM analytics.product_sales_daily
          WHERE tenant_id = $1
          GROUP BY product_id, warehouse_id, 3`, [M]);
    await db.query(`CREATE INDEX ON stg_psm (product_id, warehouse_id, month)`);
    const { rows: [org] } = await db.query(`SELECT count(*)::int n, round(sum(units)) u FROM stg_psm`);
    const { rows: [dst] } = await db.query(
      `SELECT count(*)::int n, round(sum(units)) u FROM analytics.product_sales_monthly WHERE tenant_id=$1`, [M]);
    console.log(`  origen (rollup de la diaria): ${org.n} filas · ${Number(org.u).toLocaleString('es-MX')} u`);
    console.log(`  destino (mensual hoy):       ${dst.n} filas · ${Number(dst.u).toLocaleString('es-MX')} u`);

    // Diff por año, que es donde se lee la historia de esta contradicción.
    const { rows: diff } = await db.query(
      `SELECT to_char(COALESCE(s.month, t.month),'YYYY') anio,
              count(*) FILTER (WHERE t.month IS NULL)::int nuevas,
              count(*) FILTER (WHERE t.month IS NOT NULL AND t.units IS DISTINCT FROM s.units)::int cambian,
              count(*) FILTER (WHERE s.month IS NULL)::int huerfanas
         FROM stg_psm s
         FULL JOIN analytics.product_sales_monthly t
           ON t.tenant_id = $1 AND t.product_id = s.product_id
          AND t.warehouse_id = s.warehouse_id AND t.month = s.month
        GROUP BY 1 HAVING count(*) FILTER (WHERE t.month IS NULL)
                       + count(*) FILTER (WHERE t.month IS NOT NULL AND t.units IS DISTINCT FROM s.units)
                       + count(*) FILTER (WHERE s.month IS NULL) > 0
        ORDER BY 1`, [M]);
    console.log('\n  año    nuevas  cambian  huérfanas');
    for (const r of diff) {
      console.log(`  ${r.anio}  ${String(r.nuevas).padStart(7)}  ${String(r.cambian).padStart(7)}  ${String(r.huerfanas).padStart(9)}`);
    }

    const huerfanas = diff.reduce((a, r) => a + r.huerfanas, 0);
    const pct = dst.n ? (100 * huerfanas) / dst.n : 0;
    if (huerfanas > MAX_HUERFANOS_PISO && pct > MAX_HUERFANOS_PCT) {
      throw new Error(
        `ABORTADO: el DELETE se llevaría ${huerfanas} filas (${pct.toFixed(1)} % del destino, tope ${MAX_HUERFANOS_PCT} %). `
        + 'La diaria es superset de la mensual en toda la historia medida, así que esto significa que la diaria '
        + 'se vació o cambió de llave — borrar propagaría el daño. Revisar product_sales_daily antes de reintentar.');
    }

    if (!APPLY) {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] nada cambió.');
      return;
    }

    const up = await db.query(
      `INSERT INTO analytics.product_sales_monthly AS t
             (id, tenant_id, product_id, warehouse_id, month, units, updated_at)
       SELECT gen_random_uuid(), $1, product_id, warehouse_id, month, units, now() FROM stg_psm
       ON CONFLICT (tenant_id, product_id, warehouse_id, month) DO UPDATE SET
         units = EXCLUDED.units, updated_at = now()
       WHERE t.units IS DISTINCT FROM EXCLUDED.units`, [M]);
    const del = await db.query(
      `DELETE FROM analytics.product_sales_monthly t
        WHERE t.tenant_id = $1
          AND NOT EXISTS (SELECT 1 FROM stg_psm s
                           WHERE s.product_id = t.product_id
                             AND s.warehouse_id = t.warehouse_id AND s.month = t.month)`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas (huérfanas).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
