/* eslint-disable no-console */
/**
 * Análisis de ROTACIÓN desde el ERP Kepler (read-only, dump md_03).
 *
 * Fuente: ventas reales en kdm1 (encabezado) + kdm2 (detalle).
 *   kdm1: c1=sucursal, c2/c3/c4=tipo doc (venta = c2='U', c3='D', c4=10 →
 *         149k tickets POS), c9=fecha.
 *   kdm2: enlaza por (c1,c4,c5,c6); c8=SKU, c9=cantidad, c11=presentación.
 *   kdil: existencia por sucursal (c9). kdik: costo (c9/c6).
 *
 * Salidas: top movers, stock muerto (existencia>0 sin ventas) con capital
 * parado al costo, y slow movers por días de inventario.
 *
 *   node database/scripts/kepler-rotation-analysis.js [sucursal] [dias]
 *   (default: sucursal 03, 90 días)
 *
 * NOTA: la cantidad mezcla presentaciones (PZA/PAQ/CJA) — proxy de velocidad,
 * no normalizado a pieza. Suficiente para ranking y detección de stock muerto.
 */

const { Client } = require('pg');

const BRANCH = process.argv[2] || '03';
const DAYS = Number(process.argv[3]) || 90;
const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';

const SALES = `h.c2='U' AND h.c3='D' AND h.c4=10`;
const VENTAS_CTE = `
  WITH ventas AS (
    SELECT d.c8 AS sku, sum(d.c9) AS u
      FROM md.kdm2 d JOIN md.kdm1 h
        ON h.c1=d.c1 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
     WHERE ${SALES} AND h.c1=$1 AND h.c9 >= (CURRENT_DATE - $2::int)
     GROUP BY d.c8)`;

(async () => {
  const db = new Client({ connectionString: SRC });
  await db.connect();
  try {
    console.log(`\n=== Rotación Kepler — sucursal ${BRANCH}, últimos ${DAYS} días ===\n`);

    const top = await db.query(
      `${VENTAS_CTE}
       SELECT v.sku, i.c2 AS nombre, v.u::int AS unidades
         FROM ventas v JOIN md.kdii i ON i.c1=v.sku
        ORDER BY v.u DESC LIMIT 10`, [BRANCH, DAYS]);
    console.log('TOP 10 más vendidos:');
    top.rows.forEach((r) => console.log(`  ${String(r.unidades).padStart(7)}  ${r.sku}  ${r.nombre}`));

    const dead = await db.query(
      `${VENTAS_CTE}
       SELECT count(*)::int AS skus,
              round(sum(l.c9 * COALESCE(k.c9/NULLIF(k.c6,0),0))::numeric,0) AS capital_costo
         FROM md.kdil l
         LEFT JOIN ventas v ON v.sku=l.c3
         LEFT JOIN md.kdik k ON k.c1=l.c1 AND k.c2=l.c3
        WHERE l.c1=$1 AND l.c9 > 0 AND COALESCE(v.u,0)=0`, [BRANCH, DAYS]);
    console.log(`\nSTOCK MUERTO (existencia>0, 0 ventas en ${DAYS}d): ${dead.rows[0].skus} SKUs · $${Number(dead.rows[0].capital_costo).toLocaleString()} capital parado (costo)`);

    const slow = await db.query(
      `${VENTAS_CTE}
       SELECT l.c3 AS sku, i.c2 AS nombre, l.c9::int AS existencia, v.u::int AS u,
              round((l.c9 / (v.u/$2::numeric))::numeric,0) AS dias_inv
         FROM md.kdil l JOIN ventas v ON v.sku=l.c3 JOIN md.kdii i ON i.c1=l.c3
        WHERE l.c1=$1 AND l.c9 > 50 AND v.u > 0
        ORDER BY dias_inv DESC LIMIT 10`, [BRANCH, DAYS]);
    console.log(`\nSLOW MOVERS (más días de inventario):`);
    slow.rows.forEach((r) => console.log(`  ${String(r.dias_inv).padStart(6)} días  exist=${String(r.existencia).padStart(5)}  ${r.sku}  ${r.nombre}`));
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
