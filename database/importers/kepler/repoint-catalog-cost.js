/* eslint-disable no-console */
/**
 * CANON.0.1 — REPOINT de COSTO a `kepler_ods` (crudo en prod, same-DB, @min).
 *
 * Reemplaza al escritor de costo de `import-catalog-bulk` (que leía el overlay vivo de las
 * 6 sucursales + fallback al snapshot Mega_Dulces .245). Aquí el costo sale del ODS en el
 * MISMO Postgres de prod — sin fan-out de 6 conexiones, sin depender del .245.
 *
 * Regla de costo (validada 2026-08-20 vs cost_base actual: ratio p50=1.000, p95=1.05):
 *   costo NETO = MEDIANA de kdik.c16 entre sucursales RETAIL (excl CEDIS '00', que trae
 *   basura de valuación ~0.0001 y precios por-caja). La mediana entre 5-6 sucursales es
 *   robusta a que UNA guarde un c16 per-caja (el 83718: md_02 $716 vs real $35) — la mayoría
 *   per-pieza gana. Fallback (sin kdik): costo implícito del precio de la casa c90/1.2333
 *   (c90 = c16 × 1.2333, misma regla; excl CEDIS + moda). Verificado: ODS cubre 8,627/8,797
 *   (98.1%) del cost_base actual; 170 residuales sin kdik ni c90 quedan intactos (UPDATE-only).
 *
 * cost_with_tax = costo NETO × (1 + IVA + IEPS)   [tasas del producto]
 * cost_per_case = cost_with_tax × factor_sale     [piezas por caja del producto]
 * (semántica canónica — ver reference_catalog_cost_net_gross.)
 *
 * **ODS-only, server-side, UPDATE-only, churn-free:** un solo UPDATE con CTE (ODS y
 * catalog.products viven en el mismo Postgres) — cero egress, cero round-trips. NO inserta,
 * NO borra; solo pisa el costo cuando cambió > $0.005 (evita churn por ruido de float).
 *
 *   DATABASE_URL_NEW = prod (o local :5433).
 *   node database/importers/kepler/repoint-catalog-cost.js            # dry-run (cuenta + muestra)
 *   node database/importers/kepler/repoint-catalog-cost.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const HOUSE = 1.2333; // precio de la casa: c90 = costo_neto × 1.2333 → costo implícito = c90 / 1.2333
const TOL = 0.005;    // tolerancia de cambio (churn-free)
const APPLY = process.argv.includes('--apply');

// Costo neto por SKU desde el ODS, ANCLADO al precio (evita la colisión per-caja/per-pza de kdik):
//   kk    = MEDIANA retail de kdik.c16 (excl CEDIS). Robusta a UN outlier, PERO cuando la mayoría
//           de sucursales guardan el costo POR CAJA, la mediana también es por-caja → basura
//           (91059 16KG: $5002 real per-caja vs mediana $152 per-kg; 96910 500GR: $136 real vs
//           mediana $4034 per-caja). No hay forma intrínseca de saber la unidad del c16.
//   anchor = costo implícito del precio de la casa (c90 / 1.2333). El c90 es UNIDAD-CONSISTENTE con
//           el precio de venta → su costo implícito está SIEMPRE en la unidad correcta. Es el ancla.
//   net   = la mediana kdik SOLO si cae en [0.25×, 4×] del ancla (margen real ∈ ~0.6-1.2× ancla;
//           una fuga per-caja da 10-100× → se rechaza y se usa el ancla). Sin c90 → kdik cruda
//           (SKUs promo $0.01 sin precio real; raros). Sin kdik → ancla.
const NET_CTE = `
  WITH kk AS (
    SELECT btrim(c2) AS sku, (percentile_cont(0.5) WITHIN GROUP (ORDER BY c16::numeric))::numeric AS med
      FROM kepler_ods.kdik
     WHERE c16::numeric > 0 AND btrim(sucursal) <> '00' AND btrim(coalesce(c2,'')) <> ''
     GROUP BY btrim(c2)),
  anchor AS (
    SELECT sku, (precio / ${HOUSE})::numeric AS net FROM (
      SELECT btrim(c1) AS sku, mode() WITHIN GROUP (ORDER BY c90::numeric) AS precio
        FROM kepler_ods.kdii
       WHERE c90::numeric > 0.05 AND btrim(sucursal) <> '00' AND btrim(coalesce(c1,'')) <> ''
       GROUP BY btrim(c1)) r),
  net AS (
    SELECT COALESCE(kk.sku, a.sku) AS sku,
      CASE
        WHEN kk.med IS NOT NULL AND a.net IS NOT NULL
          THEN CASE WHEN kk.med BETWEEN a.net * 0.25 AND a.net * 4 THEN kk.med ELSE a.net END
        WHEN kk.med IS NOT NULL THEN kk.med
        ELSE a.net
      END AS net
    FROM kk FULL OUTER JOIN anchor a ON a.sku = kk.sku)`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== REPOINT costo kepler_ods.kdik → catalog.products (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // sanidad: ¿existe el ODS?
    const ok = (await db.query(`SELECT to_regclass('kepler_ods.kdik') a, to_regclass('kepler_ods.kdii') b`)).rows[0];
    if (!ok.a || !ok.b) { console.error('❌ kepler_ods.kdik/kdii ausente — abortando (¿DST sin ODS?)'); process.exitCode = 1; return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    // CLAMP anti-corrupción: kdik.c16 y c90 mezclan unidad per-pza/per-caja de forma inconsistente
    // por SKU y en AMBOS sentidos (91059: ODS per-pza correcto, actual per-caja MAL; 96910: ODS
    // per-caja MAL, actual per-pza correcto). Sin un ancla universal confiable, la única regla que
    // NUNCA empeora el dato es NO mover el costo lejos del actual: se aplica el costo ODS solo si
    // cae en [1/3, 3]× del actual (drift normal). Los saltos ~30× (colisión de caja) se RECHAZAN
    // y se registran → backlog de normalización de unidad (problema DQ pre-existente, no del repoint).
    const CHANGED = `(p.cost_base IS NULL OR abs(p.cost_base::numeric - n.net) > ${TOL})`;
    const INBAND = `(p.cost_base IS NULL OR (n.net BETWEEN p.cost_base::numeric/3 AND p.cost_base::numeric*3))`;
    const WHERE = `p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=n.sku AND n.net > 0 AND ${CHANGED} AND ${INBAND}`;

    const stat = (await db.query(`
      ${NET_CTE}
      SELECT count(*) FILTER (WHERE p.id IS NOT NULL)::int con_producto,
             count(*) FILTER (WHERE p.id IS NOT NULL AND n.net>0 AND ${CHANGED} AND ${INBAND})::int a_cambiar,
             count(*) FILTER (WHERE p.id IS NOT NULL AND n.net>0 AND ${CHANGED} AND NOT ${INBAND})::int rechazados_fuera_banda
        FROM net n
        LEFT JOIN catalog.products p ON p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=n.sku`, [M])).rows[0];
    console.log(`  ODS con producto: ${stat.con_producto} · a cambiar (drift en banda): ${stat.a_cambiar} · RECHAZADOS (fuera [1/3,3]×): ${stat.rechazados_fuera_banda}`);

    const sample = (await db.query(`
      ${NET_CTE}
      SELECT p.sku, left(p.nombre,32) nombre, round(p.cost_base::numeric,4) actual, round(n.net,4) nuevo,
             round((n.net - p.cost_base::numeric),4) delta
        FROM net n JOIN catalog.products p ON p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=n.sku
       WHERE p.cost_base IS NOT NULL AND abs(p.cost_base::numeric - n.net) > ${TOL} AND ${INBAND}
       ORDER BY abs(n.net - p.cost_base::numeric) DESC LIMIT 10`, [M])).rows;
    if (sample.length) { console.log('\n  mayores cambios APLICADOS (en banda):'); console.table(sample); }
    const rej = (await db.query(`
      ${NET_CTE}
      SELECT p.sku, left(p.nombre,32) nombre, round(p.cost_base::numeric,4) actual, round(n.net,4) ods,
             round((n.net/nullif(p.cost_base::numeric,0)),1) ratio
        FROM net n JOIN catalog.products p ON p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=n.sku
       WHERE p.cost_base IS NOT NULL AND abs(p.cost_base::numeric - n.net) > ${TOL} AND NOT ${INBAND}
       ORDER BY abs(n.net - p.cost_base::numeric) DESC LIMIT 8`, [M])).rows;
    if (rej.length) { console.log('\n  RECHAZADOS (unidad ambigua — quedan intactos, backlog DQ):'); console.table(rej); }

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    const res = await db.query(`
      ${NET_CTE}
      UPDATE catalog.products p SET
        cost_base     = round(n.net, 6),
        cost_with_tax = round(n.net * (1 + COALESCE(p.iva_rate,0) + COALESCE(p.ieps_rate,0)), 6),
        cost_per_case = CASE WHEN p.factor_sale > 0
                             THEN round(n.net * (1 + COALESCE(p.iva_rate,0) + COALESCE(p.ieps_rate,0)) * p.factor_sale, 6)
                             ELSE p.cost_per_case END,
        updated_at = now()
      FROM net n WHERE ${WHERE}`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${res.rowCount} costos actualizados (en banda; ${stat.rechazados_fuera_banda} rechazados intactos). UPDATE-only churn-free.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    if (e.detail) console.error('  detail:', e.detail);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
