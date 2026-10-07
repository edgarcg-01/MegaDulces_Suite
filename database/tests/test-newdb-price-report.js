/**
 * `[CAT.7]` — **El reporte de precios por proveedor, contra la base real.**
 *
 * Las decisiones que NO son SQL (de qué fuente sale el precio, qué huecos se declaran) ya las mide
 * `price-report.spec.ts` sin base. Acá va lo único que una base puede contestar, y que es
 * exactamente donde este repo ya se quemó:
 *
 *  1. **Las columnas existen en las DOS fuentes.** Una columna que no está en la vista compila
 *     perfecto y revienta en runtime (ya pasó con `erp_sales_invoices.warehouse_name`). La lista
 *     se LEE del `.ts` de producción vía ts-node: si alguien agrega una columna al reporte y no
 *     existe, esto se pone rojo antes que la pantalla.
 *  2. **La vista consolidada devuelve UNA fila por producto.** Es la premisa de la que cuelga todo
 *     el reporte: si alguna vez abanicara, cada producto saldría impreso 7 veces —una por plaza—
 *     y los totales de la hoja mentirían. `product_label_prices` tiene grano por sucursal
 *     (`[NORM.3]`) y unirla directo multiplica ×7.
 *  3. **El filtro de plaza FILTRA.** Prueba negativa: con una plaza que no existe, el reporte no
 *     puede devolver precios. Un `LEFT JOIN` con la condición puesta en el `WHERE` en vez de en
 *     el `ON` daría cero renglones; uno sin la condición daría los de otra plaza. Las dos formas
 *     de estar mal son silenciosas.
 *  4. **El precio SÍ difiere entre plazas**, que es por lo que la hoja tiene que declarar cuál es.
 *     Si no difiriera, todo el aparato de sucursal sería decorativo — y eso también hay que saberlo.
 *
 * Read-only: no escribe ni una fila.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-price-report.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nomedido = (m) => console.log(`  ⚠️  NO MEDIDO — ${m}`);

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo y falla con TS5011.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const {
  PRICE_REPORT_LABEL_COLUMNS, FUENTE_CONSOLIDADA, FUENTE_POR_SUCURSAL, resolvePriceReportParams,
} = require(path.resolve(__dirname, '../../libs/commercial/src/lib/commercial-products/price-report.ts'));

/** Nombre de tabla/vista `schema.objeto` → `{schema, name}`. */
const parte = (fq) => ({ schema: fq.split('.')[0], name: fq.split('.')[1] });

(async () => {
  console.log('\n═══ [CAT.7] Reporte de precios por proveedor ═══\n');
  try {
    // ── 1. Las columnas que el reporte lee existen en las dos fuentes ────────────────────────
    console.log('── 1. El catálogo de la DB tiene lo que el reporte pide ──');
    ok(PRICE_REPORT_LABEL_COLUMNS.length > 0, `la lista de columnas del reporte llegó del .ts (${PRICE_REPORT_LABEL_COLUMNS.length})`);

    for (const fuente of [FUENTE_POR_SUCURSAL, FUENTE_CONSOLIDADA]) {
      const { schema, name } = parte(fuente);
      const { rows } = await knex.raw(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
        [schema, name]);
      const hay = new Set(rows.map((r) => r.column_name));
      const faltan = PRICE_REPORT_LABEL_COLUMNS.filter((c) => !hay.has(c));
      ok(rows.length > 0, `${fuente} existe`);
      ok(faltan.length === 0, `${fuente} tiene las ${PRICE_REPORT_LABEL_COLUMNS.length} columnas del reporte${faltan.length ? ` — FALTAN: ${faltan.join(', ')}` : ''}`);
    }

    // ── 2. La premisa: la vista consolidada NO abanica ───────────────────────────────────────
    console.log('\n── 2. Una fila por producto en la forma consolidada ──');
    const dup = (await knex.raw(`
      SELECT count(*)::int n FROM (
        SELECT product_id FROM ${FUENTE_CONSOLIDADA} WHERE tenant_id = ?
         GROUP BY product_id HAVING count(*) > 1) x`, [T])).rows[0].n;
    const filasVista = (await knex.raw(`SELECT count(*)::int n FROM ${FUENTE_CONSOLIDADA} WHERE tenant_id = ?`, [T])).rows[0].n;
    if (!filasVista) {
      nomedido('la vista consolidada está vacía en esta base: no hay premisa que comprobar');
    } else {
      ok(dup === 0, `ningún producto duplicado en la vista consolidada (${filasVista} filas, ${dup} duplicados)`);
    }

    // Y el CONTRAPUNTO: la tabla con grano por sucursal SÍ tiene varias filas por producto. Sin
    // esto, el bloque de arriba podría estar verde porque la tabla tampoco tiene grano.
    const porSuc = (await knex.raw(`
      SELECT count(DISTINCT sucursal)::int plazas, count(*)::int filas
        FROM ${FUENTE_POR_SUCURSAL} WHERE tenant_id = ?`, [T])).rows[0];
    ok(Number(porSuc.plazas) > 1,
      `la tabla base SÍ tiene grano por sucursal (${porSuc.plazas} plazas, ${porSuc.filas} filas) — o sea que la vista de arriba está colapsando de verdad`);

    // ── 3. El precio DIFIERE entre plazas (por eso la hoja tiene que declarar cuál es) ───────
    console.log('\n── 3. ¿Importa la plaza? ──');
    const difieren = (await knex.raw(`
      SELECT count(*)::int n FROM (
        SELECT product_id FROM ${FUENTE_POR_SUCURSAL}
         WHERE tenant_id = ? AND piece_price IS NOT NULL
         GROUP BY product_id HAVING count(DISTINCT piece_price) > 1) x`, [T])).rows[0].n;
    ok(difieren > 0,
      `${difieren} productos tienen precio de pieza DISTINTO entre plazas: la carátula de la hoja no es decorativa`);

    // ── 4. El reporte, corrido de verdad ─────────────────────────────────────────────────────
    console.log('\n── 4. La consulta del reporte, con un proveedor real ──');
    const sup = (await knex.raw(`
      SELECT s.id, s.name, count(p.id)::int n
        FROM catalog.products p
        JOIN catalog.suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
       WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.activo IS TRUE
       GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 1`, [T])).rows[0];

    if (!sup) {
      nomedido('no hay ningún proveedor con productos activos en esta base');
    } else {
      /** La misma consulta del servicio, armada con la misma lista de columnas. */
      const correr = async (sucursal) => {
        const p = resolvePriceReportParams({ supplier_ids: [sup.id], sucursal });
        const cols = PRICE_REPORT_LABEL_COLUMNS.map((c) => `l.${c}`).join(', ');
        const { rows } = await knex.raw(`
          SELECT p.id AS product_id, btrim(coalesce(p.sku, '')) AS sku, p.nombre, p.cost_base,
                 s.name AS supplier_name, b.nombre AS brand_name, ${cols}
            FROM catalog.products p
            LEFT JOIN catalog.suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
            LEFT JOIN catalog.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
            LEFT JOIN ${p.fuente} l ON l.product_id = p.id AND l.tenant_id = p.tenant_id
                 ${p.sucursal ? 'AND l.sucursal = :suc' : ''}
           WHERE p.tenant_id = :t AND p.deleted_at IS NULL AND p.activo IS TRUE
             AND p.supplier_id = :sup
           ORDER BY s.name, p.nombre LIMIT :lim`,
          { t: T, sup: sup.id, lim: p.limit, ...(p.sucursal ? { suc: p.sucursal } : {}) });
        return rows;
      };

      const consolidado = await correr(undefined);
      ok(consolidado.length > 0, `${sup.name}: ${consolidado.length} renglones en modo consolidado`);

      const ids = new Set(consolidado.map((r) => r.product_id));
      ok(ids.size === consolidado.length,
        'ningún producto sale dos veces en el reporte (el LEFT JOIN a la vista no abanica)');

      const conPrecio = consolidado.filter((r) => r.piece_price !== null).length;
      ok(conPrecio > 0, `${conPrecio} de ${consolidado.length} renglones traen precio de unidad base`);
      ok(consolidado.every((r) => r.piece_price === null || Number(r.piece_price) >= 0),
        'ningún precio negativo llega a la hoja');

      const plaza = (await knex.raw(
        `SELECT sucursal FROM ${FUENTE_POR_SUCURSAL} WHERE tenant_id = ? GROUP BY 1 ORDER BY 1 LIMIT 1`, [T])).rows[0];
      if (!plaza) {
        nomedido('no hay ninguna plaza con precios cargados');
      } else {
        const deLaPlaza = await correr(plaza.sucursal);
        ok(deLaPlaza.length === consolidado.length,
          `el mismo proveedor da los mismos ${deLaPlaza.length} renglones con plaza ${plaza.sucursal} (el filtro no pierde productos)`);
        ok(deLaPlaza.every((r) => r.sucursal === null || r.sucursal === plaza.sucursal),
          `todos los precios devueltos son de la plaza ${plaza.sucursal} y de ninguna otra`);

        // ── PRUEBA NEGATIVA: una plaza inexistente no puede devolver precios ────────────────
        const fantasma = await correr('99');
        ok(fantasma.length === consolidado.length,
          'con una plaza inexistente el reporte sigue listando los productos (el filtro está en el ON, no en el WHERE)');
        ok(fantasma.every((r) => r.piece_price === null),
          '⛔ y NINGUNO trae precio: el filtro de plaza filtra de verdad');
      }
    }
  } catch (e) {
    console.log(`  ❌ error inesperado: ${e.message}`);
    fail++;
  } finally {
    await knex.destroy();
  }

  console.log(fail ? `\n❌ ${fail} aserción(es) fallaron` : '\n✅ TODO VERDE');
  process.exit(fail ? 1 : 0);
})();
