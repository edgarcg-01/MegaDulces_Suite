'use strict';
/**
 * `[NP.8]` **Productos nuevos en vivo** — lo que pasó desde el corte de anoche hasta este momento.
 *
 * `analytics.mv_new_products` guarda la historia CERRADA (todo lo anterior a su `corte`). Lo de
 * hoy —la venta en tienda y las entradas de mercancía— sale de aquí, leyendo el ODS, que el
 * carril rápido mantiene al día cada ~15 s. La existencia ya es en vivo por sí sola
 * (`v_erp_stock_on_hand`). El servidor junta las tres cosas: nada se cuenta dos veces, porque la
 * matvista corta en `fecha < corte` y esta función arranca en `fecha >= corte`.
 *
 * ── Las reglas son LAS MISMAS, no unas parecidas ────────────────────────────────────────────
 *   · VENTA = la definición de `analytics.mv_kepler_sales_daily` (documentos U-D 8/10/12 de su
 *     propia plaza, no cancelados, sin renglones de servicio, cantidad distinta de cero) más el
 *     corte Kepler/Wincaja de `v_sellout_daily`, leído del RESOLVEDOR ÚNICO
 *     `analytics.v_branch_erp_cutover` y no copiado como lista de sucursales (ADR-056: así fue
 *     como Abastos estuvo $1.63M invisible).
 *   · ENTRADAS = el filtro de `analytics.erp_goods_receipt_lines` (XA2001 de su propia plaza, no
 *     cancelada), uniendo el renglón por la llave COMPLETA para poder entrar por el índice.
 * La función recibe el rango de fechas para que el candado la compare contra las fuentes
 * canónicas en días ya cerrados: si alguien cambia una regla de un lado y no del otro, se nota.
 *
 * ⚠️ Lo que esta parte en vivo NO trae, y se declara en pantalla: la venta de ruta (entra por su
 * propio carril de push) y la de las plazas que siguen en Wincaja. Esas se suman al cierre.
 *
 * ── El índice ───────────────────────────────────────────────────────────────────────────────
 * Las entradas de hoy no tenían por dónde entrar: `ix_kdm1_venta_fecha` es parcial a ventas
 * (`c2='U' AND c3='D'`) y sobre compras no había índice por fecha, así que pedir "las entradas
 * de hoy" recorría `kdm1` entero. Se crea el gemelo parcial a compras. Un índice no es una
 * copia (regla principal): no duplica el dato ni introduce rezago. CONCURRENTLY porque el carril
 * del ODS escribe en esta tabla cada minuto.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

const FN = 'analytics.fn_new_products_movimientos';
const HOY = "(now() AT TIME ZONE 'America/Mexico_City')::date";
const IMPORTE = "round(coalesce(nullif(regexp_replace(l.c13::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2)";

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdm1_compra_fecha
        ON kepler_ods.kdm1 (((c9)::date))
     WHERE c2 = 'X' AND c3 = 'A'`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN}(p_desde date, p_hasta date)
    RETURNS TABLE (tenant_id uuid, product_id uuid, tipo text, plaza text, fecha date,
                   folio text, importe numeric)
    LANGUAGE sql STABLE AS $fn$
      WITH u AS (
        SELECT m.tenant_id, m.product_id, m.sku FROM analytics.mv_new_products m
      )
      -- VENTA en tienda: la definicion de mv_kepler_sales_daily + el corte de v_sellout_daily.
      SELECT u.tenant_id, u.product_id, 'venta'::text, btrim(h.sucursal), h.c9::date,
             NULL::text, sum(${IMPORTE})
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l
          ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
         AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
         AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
        JOIN u ON u.sku = btrim(l.c8)
       WHERE h.c2 = 'U' AND h.c3 = 'D' AND h.c4::integer IN (8, 10, 12)
         AND h.c9::date BETWEEN p_desde AND least(p_hasta, ${HOY})
         AND btrim(h.c1) = btrim(h.sucursal)
         AND coalesce(nullif(btrim(h.c43), ''), '') <> 'C'
         AND coalesce(btrim(l.c11), '') <> 'SER'
         AND abs(coalesce(l.c9::numeric, 0)) > 0
         AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover x
                      WHERE x.tenant_id = u.tenant_id AND x.kepler_code = btrim(h.sucursal)
                        AND h.c9::date >= x.cutover_date)
       GROUP BY 1, 2, 3, 4, 5, 6
      UNION ALL
      -- ENTRADAS: el filtro de erp_goods_receipt_lines, con la llave completa del renglon.
      SELECT u.tenant_id, u.product_id, 'entrada'::text, h.sucursal::text, h.c9::date,
             btrim(h.c6::text), sum(${IMPORTE})
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
         AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
        JOIN u ON u.sku = nullif(btrim(l.c8::text), '')
       WHERE h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20'
         AND h.c9::date BETWEEN p_desde AND p_hasta
         AND btrim(h.c1::text) = h.sucursal::text
         AND btrim(coalesce(h.c43::text, '')) <> 'C'
       GROUP BY 1, 2, 3, 4, 5, 6
    $fn$`);

  await knex.raw(`GRANT EXECUTE ON FUNCTION ${FN}(date, date) TO app_runtime`);
  await knex.raw(`
    COMMENT ON FUNCTION ${FN}(date, date) IS
      '[NP.8] Venta en tienda (reglas de mv_kepler_sales_daily + corte de v_branch_erp_cutover) y '
      'entradas XA2001 (filtro de erp_goods_receipt_lines) de los productos de mv_new_products, '
      'en un rango de fechas. Con (corte, hoy) es la parte EN VIVO de la pantalla; con un dia '
      'cerrado, el candado la compara contra las fuentes canonicas. No trae ruta ni Wincaja.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN}(date, date)`);
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdm1_compra_fecha');
};
