/**
 * `[CE.1.4]` «Por vencer» declara cuándo un lote fechado NO se puede creer.
 *
 * Los lotes fechados son dato propio (se capturan en el Andén); la existencia NO: es la de Kepler.
 * Mientras haya existencia SIN fecha del mismo producto en el mismo almacén, la venta la descuenta
 * primero y el lote fechado NO baja: puede seguir apareciendo aunque ya se haya vendido (Anexo CE §3
 * fila 6, decisión D4: se DECLARA).
 *
 * `[CE.1.7]` Lo sin fecha se DERIVA del ODS, no de la copia del importer: existencia de Kepler de la
 * celda (`analytics.v_erp_stock_on_hand`, sobre `kepler_ods.kdil`) menos lo fechado de la celda.
 * Antes se leía el lote `NA` que el trigger `fn_rebalance_stock_lots` cuadra contra `commercial.stock`,
 * la copia de `import-branch-stock-live` (cuadra 91 % contra el POS; la vista del ODS, 100 %).
 *  · sin fecha > 0  → puede estar ya vendido.
 *  · sin fecha < 0  → lo fechado es MÁS que lo que Kepler tiene: parte ya se vendió seguro.
 *  · sin fecha = 0  → la cantidad se puede creer.
 *  · sin existencia del ODS (no hay renglón, o el almacén no es de Kepler) → NULL: no medido.
 */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface DeclaracionFechado {
  /** Existencia de Kepler de la celda (ODS). NULL = no se pudo leer. */
  stock_erp: number | null;
  /** Lo fechado (lotes con caducidad y cantidad) de la celda. */
  dated_qty: number | null;
  /**
   * Lo SIN fecha = existencia de Kepler − lo fechado. Negativo = lo fechado excede la existencia.
   * NULL = no se pudo saber.
   */
  na_qty: number | null;
  /**
   * true = el lote fechado puede estar (o está) ya vendido. NULL = no se pudo saber: nunca se dibuja
   * como «cierto».
   */
  dated_may_be_stale: boolean | null;
}

/** La declaración de un renglón de Por vencer a partir de la existencia ODS y lo fechado de su celda. */
export function declararFechado(stockErp: unknown, datedQty: unknown): DeclaracionFechado {
  const stock = num(stockErp);
  const dated = num(datedQty);
  if (stock === null || dated === null) {
    return { stock_erp: stock, dated_qty: dated, na_qty: null, dated_may_be_stale: null };
  }
  // Redondeo a 4 decimales: la existencia viene de un double de Kepler.
  const na = Math.round((stock - dated) * 10000) / 10000;
  return { stock_erp: stock, dated_qty: dated, na_qty: na, dated_may_be_stale: na !== 0 };
}
