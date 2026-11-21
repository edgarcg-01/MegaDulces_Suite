import { ConflictException } from '@nestjs/common';
import type { Knex } from 'knex';

type Db = Knex | Knex.Transaction;

/**
 * `[CANON.7.4c]` Los lotes DECLARADOS (con código o caducidad, `lot_code <> 'NA'`) son dato propio; el lote «sin lote»
 * (`NA`) ya no se guarda: es `max(existencia de Kepler − lo declarado, 0)`. Hasta el 2026-11-20 el `NA` lo mantenía el
 * disparador de la COPIA `commercial.stock`, y declarar una caducidad exigía renglón en la copia y saldo en ese `NA`
 * (en el CEDIS, con la copia congelada desde el 16-oct, casi nunca lo había).
 *
 * La existencia es la de `analytics.v_erp_stock_on_hand` (Kepler o Wincaja según la sucursal), la misma que leen la
 * portada de Almacén y los pedidos. Lo que consume los lotes cuando la existencia baja es el disparador de `kdil`
 * (`commercial.consumir_lotes_por_existencia`, migración 20261120150025): este módulo usa su MISMO candado, así que
 * declarar y consumir no se cruzan.
 */

/** El candado de una celda (almacén, producto): el MISMO texto de llave que `commercial.consumir_lotes_por_existencia`. */
export async function bloquearLotes(trx: Db, warehouseId: string, productId: string): Promise<void> {
  await trx.raw(`SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`, [`lotes:${warehouseId}:${productId}`]);
}

export interface SaldoDeLotes {
  existencia: number;
  declarado: number;
  /** Lo que todavía se puede declarar con fecha: `max(existencia − declarado, 0)`. Es el `NA` derivado. */
  libre: number;
}

/** Existencia, lo declarado en lotes y lo libre (el `NA` derivado) de una celda. */
export async function saldoDeLotes(trx: Db, warehouseId: string, productId: string): Promise<SaldoDeLotes> {
  const { rows } = (await trx.raw(
    `SELECT (SELECT COALESCE(sum(e.qty_stock_units), 0)::float8 FROM analytics.v_erp_stock_on_hand e
              WHERE e.warehouse_id = ?::uuid AND e.product_id = ?::uuid) AS existencia,
            (SELECT COALESCE(sum(l.quantity), 0)::float8 FROM commercial.stock_lots l
              WHERE l.warehouse_id = ?::uuid AND l.product_id = ?::uuid AND l.lot_code <> 'NA' AND l.quantity > 0) AS declarado`,
    [warehouseId, productId, warehouseId, productId],
  )) as { rows: Array<{ existencia: number | string; declarado: number | string }> };
  const existencia = Number(rows[0]?.existencia) || 0;
  const declarado = Number(rows[0]?.declarado) || 0;
  return { existencia, declarado, libre: Math.max(existencia - declarado, 0) };
}

/**
 * Declara hasta `cantidad` piezas con caducidad (lote `EXP-<fecha>`), topado en lo libre. Devuelve lo declarado (0 si no
 * había nada libre). No toca el `NA` ni la copia.
 */
export async function declararCaducidad(
  trx: Db,
  d: { warehouseId: string; productId: string; expiryYmd: string; cantidad: number; userId?: string | null },
): Promise<number> {
  await bloquearLotes(trx, d.warehouseId, d.productId);
  const { libre } = await saldoDeLotes(trx, d.warehouseId, d.productId);
  const mover = Math.min(d.cantidad, libre);
  if (mover <= 0) return 0;
  await trx.raw(
    `INSERT INTO commercial.stock_lots
       (tenant_id, warehouse_id, product_id, lot_code, expiry_date, quantity, reserved_quantity, received_at, updated_by)
     VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, 0, now(), ?)
     ON CONFLICT (tenant_id, warehouse_id, product_id, lot_code, expiry_date)
     DO UPDATE SET quantity = commercial.stock_lots.quantity + EXCLUDED.quantity,
                   received_at = now(), updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [d.warehouseId, d.productId, `EXP-${d.expiryYmd}`, d.expiryYmd, mover, d.userId ?? null],
  );
  return mover;
}

/**
 * Inverso de `declararCaducidad`: baja `cantidad` del lote `EXP-<fecha>`. Se niega (409) si el lote ya no la tiene:
 * entre el alta y la corrección pudo salir mercancía de ese lote. Lo que se retira vuelve a lo libre solo (el `NA` es
 * derivado): no se escribe en ningún otro lado.
 */
export async function retirarCaducidad(
  trx: Db,
  d: { warehouseId: string; productId: string; expiryYmd: string; cantidad: number; userId?: string | null },
): Promise<void> {
  await bloquearLotes(trx, d.warehouseId, d.productId);
  const lotCode = `EXP-${d.expiryYmd}`;
  const lote = (await trx('commercial.stock_lots')
    .where({ warehouse_id: d.warehouseId, product_id: d.productId, lot_code: lotCode })
    .first('id', 'quantity', 'reserved_quantity')) as { id: string; quantity: string; reserved_quantity: string | null } | undefined;
  const libre = lote ? Number(lote.quantity) - Number(lote.reserved_quantity || 0) : 0;
  if (!lote || libre < d.cantidad)
    throw new ConflictException(
      `Ya salió mercancía del lote ${lotCode} (quedan ${libre} de ${d.cantidad}). Esta alta no se puede corregir sola: pedile al encargado que ajuste el inventario.`,
    );
  await trx('commercial.stock_lots')
    .where({ id: lote.id })
    .update({ quantity: Number(lote.quantity) - d.cantidad, updated_at: trx.fn.now(), updated_by: d.userId ?? null });
}
