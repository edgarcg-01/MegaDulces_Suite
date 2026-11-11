/**
 * `[CE.1.4]` «Por vencer» declara cuándo un lote fechado NO se puede creer.
 *
 * `commercial.stock_lots` es un sub-libro de la existencia: el trigger `fn_rebalance_stock_lots`
 * (migraciones `20260618210000` y `20260618220000`) pone toda diferencia de la existencia total
 * PRIMERO en el lote `NA` (sin fecha). Mientras el producto tenga `NA` en ese almacén, la venta lo
 * descuenta de ahí y el lote fechado NO baja: puede seguir apareciendo aunque ya se haya vendido
 * (Anexo CE §3 fila 6, decisión D4: el trigger se queda; lo que se hace es DECLARARLO).
 *
 * Medido en prod el 2026-11-11 (sólo lectura): de los 70 lotes que vencen en 30 días, 50 tienen `NA`
 * en su mismo almacén × producto (42 con más `NA` que el propio lote).
 */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface DeclaracionFechado {
  /** Lo que hay SIN fecha (lote `NA`) del mismo producto en el mismo almacén. NULL = no se pudo leer. */
  na_qty: number | null;
  /**
   * true = el lote fechado puede estar ya vendido (hay `NA` > 0: la venta lo descuenta primero).
   * NULL = no se pudo saber (no se leyó el `NA`): nunca se dibuja como «cierto».
   */
  dated_may_be_stale: boolean | null;
}

/** La declaración de un renglón de Por vencer a partir del `NA` que trae la consulta. */
export function declararFechado(naQty: unknown): DeclaracionFechado {
  const na = num(naQty);
  if (na === null) return { na_qty: null, dated_may_be_stale: null };
  return { na_qty: na, dated_may_be_stale: na > 0 };
}
