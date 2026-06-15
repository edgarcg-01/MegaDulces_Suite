/* eslint-disable no-console */
/**
 * Importer Kepler → commercial.stock (Fase I, datos reales).
 *
 * Lee el ERP Kepler restaurado (DB md_03) y puebla commercial.stock de nuestra
 * plataforma con la existencia real de una sucursal, para que el inventario
 * físico (Fase I) cuente contra cifras verdaderas.
 *
 * Mapeo descifrado (columnas Kepler son cN opacas — inferidas desde datos):
 *   md.kdii  → maestro productos: c1=SKU, c2=nombre, c7=barcode, c8=clave familia
 *   md.kdil  → existencia/acumulados por sucursal: c1=sucursal, c3=SKU,
 *              c8/c9=cantidades, c6/c7=última compra/venta
 *   md.kdik  → valuación: c1=sucursal, c2=SKU, c6=existencia, c9=valor a costo
 *              → costo unitario = c9/c6
 *
 * Join a nuestro catálogo: kdii.c1 == public.products.sku (mismo esquema — el
 * ERP de Mega Dulces ES este Kepler). Mapea por SKU dentro del tenant.
 *
 * Uso:
 *   node database/importers/kepler/import-kepler-stock.js            # dry-run (no escribe)
 *   node database/importers/kepler/import-kepler-stock.js --apply    # escribe commercial.stock
 *   ... --branch 03 --warehouse KEPLER-03 --exist-col c9
 *
 * Idempotente: upsert por (tenant, warehouse, product).
 */

const { Client } = require('pg');

const MEGA = '00000000-0000-0000-0000-00000000d01c';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const APPLY = process.argv.includes('--apply');
const BRANCH = arg('branch', '03');
const WAREHOUSE = arg('warehouse', `KEPLER-${BRANCH}`);
const EXIST_COL = arg('exist-col', 'c9'); // c9 (hipótesis) | c8

const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';
const DST = 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

(async () => {
  const src = new Client({ connectionString: SRC });
  const dst = new Client({ connectionString: DST });
  await src.connect();
  await dst.connect();

  try {
    console.log(`\n=== Importer Kepler → commercial.stock ===`);
    console.log(`Sucursal: ${BRANCH} · Almacén destino: ${WAREHOUSE} · Existencia: kdil.${EXIST_COL} · Modo: ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN'}\n`);

    // 1) Leer existencia + costo de Kepler para la sucursal.
    const { rows: kepler } = await src.query(
      `SELECT l.c3 AS sku,
              i.c2 AS nombre,
              i.c7 AS barcode,
              l.${EXIST_COL}::numeric AS existencia,
              CASE WHEN k.c6 <> 0 THEN ROUND((k.c9 / k.c6)::numeric, 4) ELSE 0 END AS costo_unit,
              l.c6::date AS ult_compra,
              l.c7::date AS ult_venta
         FROM md.kdil l
         JOIN md.kdii i ON i.c1 = l.c3
         LEFT JOIN md.kdik k ON k.c1 = l.c1 AND k.c2 = l.c3
        WHERE l.c1 = $1`,
      [BRANCH],
    );
    console.log(`Kepler sucursal ${BRANCH}: ${kepler.length} SKUs con registro de existencia.`);

    // 2) Mapear a nuestro product_id por SKU.
    const skus = kepler.map((r) => r.sku);
    const { rows: ours } = await dst.query(
      `SELECT id, sku FROM public.products WHERE tenant_id = $1 AND sku = ANY($2)`,
      [MEGA, skus],
    );
    const skuToId = new Map(ours.map((r) => [r.sku, r.id]));

    const matched = kepler.filter((r) => skuToId.has(r.sku));
    const unmatched = kepler.filter((r) => !skuToId.has(r.sku));
    const withStock = matched.filter((r) => Number(r.existencia) !== 0);

    console.log(`Match por SKU: ${matched.length} · sin match (se omiten): ${unmatched.length}`);
    console.log(`Con existencia != 0: ${withStock.length}`);
    const totalUnits = matched.reduce((s, r) => s + Number(r.existencia), 0);
    console.log(`Unidades totales (suma existencia): ${totalUnits.toLocaleString()}\n`);

    // 3) Muestra de validación (para que Edgar confirme la columna de existencia).
    console.log('Muestra (top 15 por existencia) — validá contra la tienda real:');
    console.log('  SKU      EXIST    COSTO    ÚLT.VENTA   NOMBRE');
    const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
    [...matched].sort((a, b) => Number(b.existencia) - Number(a.existencia)).slice(0, 15).forEach((r) => {
      console.log(
        `  ${String(r.sku).padEnd(8)} ${String(r.existencia).padStart(8)} ${String(r.costo_unit).padStart(8)}  ${fmtDate(r.ult_venta)}  ${r.nombre}`,
      );
    });
    if (unmatched.length) {
      console.log(`\nEjemplos sin match en nuestro catálogo (${Math.min(5, unmatched.length)}):`);
      unmatched.slice(0, 5).forEach((r) => console.log(`  ${r.sku} ${r.nombre}`));
    }

    if (!APPLY) {
      console.log('\n[DRY-RUN] No se escribió nada. Corré con --apply para poblar commercial.stock.');
      return;
    }

    // 4) APPLY: asegurar almacén destino + upsert de stock en una transacción.
    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${MEGA}'`);

    let wh = await dst.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2`, [MEGA, WAREHOUSE]);
    let warehouseId;
    if (wh.rows.length) {
      warehouseId = wh.rows[0].id;
    } else {
      const ins = await dst.query(
        `INSERT INTO commercial.warehouses (tenant_id, code, name, is_default)
         VALUES ($1, $2, $3, false) RETURNING id`,
        [MEGA, WAREHOUSE, `Kepler sucursal ${BRANCH}`],
      );
      warehouseId = ins.rows[0].id;
      console.log(`\nAlmacén ${WAREHOUSE} creado.`);
    }

    let written = 0;
    for (const r of matched) {
      const productId = skuToId.get(r.sku);
      await dst.query(
        `INSERT INTO commercial.stock (tenant_id, warehouse_id, product_id, quantity, reserved_quantity, updated_at)
         VALUES ($1, $2, $3, $4, 0, now())
         ON CONFLICT (tenant_id, warehouse_id, product_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [MEGA, warehouseId, productId, Number(r.existencia)],
      );
      written++;
    }
    await dst.query('COMMIT');
    console.log(`\n[APPLY] ${written} filas de stock escritas en almacén ${WAREHOUSE}.`);
  } catch (e) {
    try { await dst.query('ROLLBACK'); } catch { /* noop */ }
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await dst.end();
  }
})();
