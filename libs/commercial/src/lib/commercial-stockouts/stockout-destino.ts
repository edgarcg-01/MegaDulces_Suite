/**
 * `[FLT.21]` A QUIÉN le toca un faltante de piso. Módulo PURO, a propósito.
 *
 * Vive aparte del servicio por una razón medible: acá no entra Nest, ni Knex, ni el tenant, así
 * que la regla se puede probar sin una base de datos. La regla la usan TRES consumidores —la
 * confirmación que ve la cajera, la bandeja de Compras y el resumen— y si viviera copiada en los
 * tres, el día que cambie quedarían tres respuestas distintas a la misma pregunta.
 *
 * ── El destino se DERIVA, nunca se guarda ───────────────────────────────────────────────────
 * Guardarlo sería una segunda copia de algo calculable; el día que cambie la regla quedarían
 * filas viejas afirmando un destino que la regla nueva no les daría. Se recalcula al leer.
 */

export type StockoutKind =
  | 'agotado'
  | 'no_en_anaquel'
  | 'no_en_sucursal'
  | 'no_en_catalogo'
  | 'codigo_no_pasa';

/**
 *  · `piso`       — hay existencia y no estaba en el anaquel. **Se recupera el mismo día.**
 *  · `compras`    — no hay en la tienda, o no lo trabajamos. Reposición o alta.
 *  · `inventario` — dijo "no hay" y el sistema dice que sí, **después de buscarlo**. Descuadre
 *                   afirmado por una persona, no supuesto por el sistema.
 *  · `catalogo`   — el código existe y el lector no lo toma. Es dato maestro, no mercancía.
 */
export type StockoutDestino = 'piso' | 'compras' | 'inventario' | 'catalogo';

export const STOCKOUT_KINDS: readonly StockoutKind[] = [
  'agotado', 'no_en_anaquel', 'no_en_sucursal', 'no_en_catalogo', 'codigo_no_pasa',
];

/**
 * La regla del destino, en UN lugar.
 *
 * ⚠️ El orden de las ramas NO es cosmético: `codigo_no_pasa` y `no_en_anaquel` se deciden por el
 * motivo SOLO, antes de mirar la existencia. Si la rama de existencia fuera primero, un
 * `codigo_no_pasa` sobre algo que sí hay en la tienda se iría a "inventario" — y no hay ningún
 * descuadre: el producto está, lo que falla es el código de barras.
 *
 * ⚠️ `onHand == null` significa NO SE PUDO MEDIR, no cero (ADR-056). Por eso la rama de descuadre
 * exige `!= null` explícito: sin ese chequeo, un `null` compararía `null > 0 === false` y el
 * faltante se iría a Compras como si la existencia se hubiera medido y fuera cero.
 */
export function destinoDe(kind: StockoutKind, onHand: number | null): StockoutDestino {
  if (kind === 'codigo_no_pasa') return 'catalogo';
  if (kind === 'no_en_anaquel') return 'piso';
  // "No hay" sobre algo que el sistema cree tener: lo afirma una persona que fue a buscarlo.
  if (kind === 'agotado' && onHand != null && onHand > 0) return 'inventario';
  return 'compras';
}
