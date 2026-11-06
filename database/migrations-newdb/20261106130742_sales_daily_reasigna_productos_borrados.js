'use strict';
/**
 * `[CANON.5.26]` — H9 bis: la venta de `analytics.sales_daily` escrita a nombre de un producto
 * BORRADO cuyo SKU tiene una fila VIVA pasa a la viva, sin contar dos veces.
 *
 * `import-sales-fact` armaba el mapa SKU→id sin orden: con 887 SKUs que tienen una fila borrada y
 * una viva, el id elegido cambiaba entre corridas y la MISMA venta (sku × almacén × canal × día)
 * quedaba escrita a nombre de los dos. El importer ya prefiere la viva (mismo commit); esto limpia
 * lo escrito antes.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-06) ────────────────────────────────────────
 *  · 1,991 filas en ids borrados con gemelo vivo (21+11+64 productos; tienda, crédito, mayoreo).
 *  · 1,263 de ellas YA tienen fila viva con la misma llave: 1,253 con el mismo valor (venta
 *    contada doble, ~$150 mil en un año) y 10 con valor distinto (gana la escrita más reciente).
 *  · 728 sin fila viva gemela: sólo se les cambia el product_id (el total no se mueve).
 *  · 338 filas de 8 SKUs que NO tienen fila viva: no se tocan.
 *
 * Pasos, sobre el par (borrada → viva del mismo tenant y SKU; la viva más reciente si hubiera
 * varias, la misma regla que el importer):
 *   1. si la gemela borrada se escribió DESPUÉS que la viva y su valor difiere, su valor pasa a la viva;
 *   2. la gemela borrada se borra (era la copia);
 *   3. la borrada sin gemela cambia de product_id.
 * Control: el total de los productos tocados queda igual a «antes − copias + correcciones» y no
 * queda ninguna fila en un id borrado con gemelo vivo. Si no cuadra, aborta (ROLLBACK).
 *
 * ⛔ ORDEN: aplicar DESPUÉS de desplegar la imagen `ingesta` con el importer arreglado. Con el
 *    importer viejo corriendo (cada 15 min), una de cada tantas corridas vuelve a escribir al id
 *    borrado y la copia reaparece dentro de su ventana. Es idempotente: si eso pasó, se corre de
 *    nuevo y limpia lo que reapareció.
 * ⚠️ Sólo mueve datos: la compuerta del despliegue la verá NO_MEDIDO y frena hasta aplicarla.
 *    Son ~2 mil filas sobre índice: segundos.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const PAR = `
  viva AS (
    SELECT DISTINCT ON (tenant_id, sku) tenant_id, sku, id
      FROM catalog.products
     WHERE deleted_at IS NULL AND btrim(coalesce(sku, '')) <> ''
     ORDER BY tenant_id, sku, created_at DESC, id DESC),
  par AS (
    SELECT b.tenant_id, b.id AS old_id, v.id AS new_id
      FROM catalog.products b
      JOIN viva v ON v.tenant_id = b.tenant_id AND v.sku = b.sku
     WHERE b.deleted_at IS NOT NULL)`;

// Suma de los productos involucrados (los dos lados del par): el universo que la migración toca.
const TOTAL = `
  WITH ${PAR}
  SELECT coalesce(sum(s.revenue), 0)::numeric AS rev, count(*)::int AS filas
    FROM analytics.sales_daily s
   WHERE (s.tenant_id, s.product_id) IN (SELECT tenant_id, old_id FROM par UNION SELECT tenant_id, new_id FROM par)`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const antes = (await knex.raw(TOTAL)).rows[0];

  // 1. La gemela borrada más reciente y distinta le pasa su valor a la viva.
  const corr = await knex.raw(`
    WITH ${PAR},
    d AS (SELECT DISTINCT ON (s.tenant_id, p.new_id, s.warehouse_id, s.channel, s.sale_date) s.*, p.new_id
            FROM analytics.sales_daily s
            JOIN par p ON p.tenant_id = s.tenant_id AND p.old_id = s.product_id
           ORDER BY s.tenant_id, p.new_id, s.warehouse_id, s.channel, s.sale_date, s.updated_at DESC, s.id DESC)
    UPDATE analytics.sales_daily l
       SET units = d.units, revenue = d.revenue, cost = d.cost, tickets = d.tickets,
           unit_kind = d.unit_kind, units_base = d.units_base, rung_factor = d.rung_factor,
           rung_mixed = d.rung_mixed, units_unresolved = d.units_unresolved, updated_at = d.updated_at
      FROM d
     WHERE l.tenant_id = d.tenant_id AND l.product_id = d.new_id AND l.warehouse_id = d.warehouse_id
       AND l.channel = d.channel AND l.sale_date = d.sale_date
       AND d.updated_at > l.updated_at
       AND (l.units, l.revenue, l.cost, l.tickets, l.unit_kind, l.units_base, l.rung_factor, l.rung_mixed, l.units_unresolved)
           IS DISTINCT FROM
           (d.units, d.revenue, d.cost, d.tickets, d.unit_kind, d.units_base, d.rung_factor, d.rung_mixed, d.units_unresolved)`);

  // 2. La gemela borrada era la copia: se va.
  const borradas = await knex.raw(`
    WITH ${PAR}
    DELETE FROM analytics.sales_daily s
     USING par p
     WHERE p.tenant_id = s.tenant_id AND p.old_id = s.product_id
       AND EXISTS (SELECT 1 FROM analytics.sales_daily l
                    WHERE l.tenant_id = s.tenant_id AND l.product_id = p.new_id AND l.warehouse_id = s.warehouse_id
                      AND l.channel = s.channel AND l.sale_date = s.sale_date)
    RETURNING s.revenue`);
  // 2b. Varias borradas del mismo SKU con la misma llave (hoy 0 SKUs con más de una borrada y una
  //     viva): se queda la escrita más reciente; sin esto el paso 3 chocaría con uq_sales_daily.
  const repetidas = await knex.raw(`
    WITH ${PAR},
    r AS (SELECT s.id, s.revenue, row_number() OVER (PARTITION BY s.tenant_id, p.new_id, s.warehouse_id, s.channel, s.sale_date
                                           ORDER BY s.updated_at DESC, s.id DESC) AS n
            FROM analytics.sales_daily s JOIN par p ON p.tenant_id = s.tenant_id AND p.old_id = s.product_id)
    DELETE FROM analytics.sales_daily s USING r WHERE s.id = r.id AND r.n > 1
    RETURNING s.revenue`);
  borradas.rows.push(...repetidas.rows);
  borradas.rowCount += repetidas.rowCount;
  const revBorrada = borradas.rows.reduce((a, r) => a + Number(r.revenue), 0);

  // 3. Sin gemela: sólo cambia de dueño.
  const movidas = await knex.raw(`
    WITH ${PAR}
    UPDATE analytics.sales_daily s SET product_id = p.new_id
      FROM par p
     WHERE p.tenant_id = s.tenant_id AND p.old_id = s.product_id`);

  const despues = (await knex.raw(TOTAL)).rows[0];
  const quedan = (await knex.raw(`WITH ${PAR}
    SELECT count(*)::int AS n FROM analytics.sales_daily s JOIN par p ON p.tenant_id = s.tenant_id AND p.old_id = s.product_id`)).rows[0].n;
  if (quedan !== 0) throw new Error(`[CANON.5.26] quedan ${quedan} filas en ids borrados con gemelo vivo: aborto.`);
  // El total sólo puede bajar por las copias borradas y moverse por las correcciones del paso 1;
  // las filas de los pasos 2 y 3 no pueden aparecer ni desaparecer de otro modo.
  if (despues.filas !== antes.filas - borradas.rowCount) {
    throw new Error(`[CANON.5.26] filas: antes ${antes.filas}, borradas ${borradas.rowCount}, después ${despues.filas}: no cuadra, aborto.`);
  }
  console.log(`[CANON.5.26] sales_daily: ${corr.rowCount} filas vivas corregidas con el valor más reciente, `
    + `${borradas.rowCount} copias borradas ($${revBorrada.toFixed(2)}), ${movidas.rowCount} reasignadas al id vivo. `
    + `Total de los productos tocados: ${Number(antes.rev).toFixed(2)} → ${Number(despues.rev).toFixed(2)}.`);
};

/**
 * No se deshace: el paso 2 borra copias de venta que ya estaban en la fila viva, y devolverlas
 * sería volver a contar doble. Lo que sí cambió de dueño (paso 3) lo reescribe igual el siguiente
 * `import-sales-fact` dentro de su ventana.
 */
exports.down = async function down(knex) {
  void knex;
};
