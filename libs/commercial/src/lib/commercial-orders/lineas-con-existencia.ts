import type { Knex } from 'knex';
import { EXISTENCIA_ODS_CON_APARTADO_SQL } from '../commercial-inventory/stock-state';

/**
 * `[CANON.7.4b]` Los renglones del detalle de pedido (B6) con la existencia y el apartado de la sucursal de surtido de
 * cada renglón (la del pedido si no dice, `[MCP.3.13]`). Sale de `findById` para que la prueba de integración ejerza
 * ESTA consulta contra Postgres real (`order-stock.it.spec.ts`), no una copia de su SQL.
 *
 * La existencia es la del ODS y el apartado el del libro de movimientos (`EXISTENCIA_ODS_CON_APARTADO_SQL`), lo mismo con
 * lo que valida `OrderStockService.reserve()`; ya no la copia `commercial.stock`. Se acota ANTES a los almacenes y
 * productos del pedido con constantes: la vista agrupa por (almacén, producto) y Postgres empuja un filtro constante
 * hasta `kdil`, pero no una condición de JOIN (sin el filtro leería la red entera por cada detalle de pedido; medido en
 * prod el 2026-11-20: 16–18 ms un pedido de 55 renglones).
 */
export async function lineasConExistencia(
  trx: Knex | Knex.Transaction,
  orderId: string,
  order: { warehouse_id: string; status: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- la misma forma sin tipar que devolvía findById
): Promise<any[]> {
  const pares = (await trx('commercial.order_lines')
    .where({ order_id: orderId })
    .select('product_id', trx.raw('COALESCE(source_warehouse_id, ?::uuid) AS warehouse_id', [order.warehouse_id]))) as Array<{
    product_id: string;
    warehouse_id: string;
  }>;
  const existenciaDelPedido = trx.raw(
    `(SELECT x.warehouse_id, x.product_id, x.quantity, x.reserved_quantity
        FROM ${EXISTENCIA_ODS_CON_APARTADO_SQL} x
       WHERE x.warehouse_id = ANY(?::uuid[]) AND x.product_id = ANY(?::uuid[])) AS s`,
    [[...new Set(pares.map((r) => r.warehouse_id))], [...new Set(pares.map((r) => r.product_id))]],
  );
  return trx('commercial.order_lines as ol')
    .leftJoin('public.products as p', 'p.id', 'ol.product_id')
    .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
    // [MCP.3.13] La existencia es la de la sucursal de surtido del renglón (la del pedido si no dice).
    .leftJoin('commercial.warehouses as sw', 'sw.id', 'ol.source_warehouse_id')
    .leftJoin(existenciaDelPedido, function () {
      this.on('s.product_id', '=', 'ol.product_id').andOn(
        's.warehouse_id',
        '=',
        trx.raw('COALESCE(ol.source_warehouse_id, ?::uuid)', [order.warehouse_id]),
      );
    })
    .where('ol.order_id', orderId)
    .orderBy('ol.line_number')
    .select(
      'ol.*',
      'p.nombre as product_name',
      'b.nombre as brand_name',
      'sw.name as source_warehouse_name',
      'sw.short_label as source_warehouse_short',
      trx.raw('COALESCE(s.quantity, 0) as stock_quantity'),
      trx.raw('COALESCE(s.reserved_quantity, 0) as stock_reserved'),
      // Stock disponible para ESTA línea: si el pedido está pending_approval/confirmed,
      // la qty de la línea ya está incluida en reserved → se suma de vuelta para
      // mostrar el tope al que se puede subir la línea. En draft no se reserva,
      // así que (quantity - reserved) ya es el disponible real.
      // ⚠️ Una preventa confirmada NO apartó: también se le suma de vuelta (regla anterior, sin cambio en 7.4b).
      trx.raw(
        `GREATEST(
           COALESCE(s.quantity, 0) - COALESCE(s.reserved_quantity, 0)
           + CASE WHEN ? IN ('pending_approval','confirmed') THEN ol.quantity ELSE 0 END,
           0
         ) as stock_available`,
        [order.status],
      ),
    );
}
