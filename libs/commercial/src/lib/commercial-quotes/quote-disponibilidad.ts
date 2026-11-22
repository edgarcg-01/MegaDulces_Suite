/**
 * `[COT.51]` **¿Había para surtir lo que se cotizó?** — la existencia al momento de cotizar.
 *
 * `commercial.quote_lines` nació con `availability` (`available · partial · unavailable ·
 * not_carried · unmatched · unknown`) y `stock_at_quote` (snapshot). Medido el 2026-11-22 sobre
 * 9,163 renglones en prod: `stock_at_quote` vacío en los 9,163 y `availability = 'available'` en
 * los 9,163 — que en el código significaba «el SKU casó con el catálogo», no «había». O sea que la
 * columna afirmaba existencia sin haberla medido (regla 11), y la pantalla consultaba la
 * existencia 45,098 veces en 28 días y la tiraba.
 *
 * Con la existencia de HOY sobre los renglones de los últimos 3 días: 77 % alcanza, 11 % alcanza
 * en parte, 9 % no hay y 3 % sin dato. Es la señal que la demanda negada (DN) y cualquier modelo
 * de demanda necesitan, y sólo existe si se guarda en el momento.
 *
 * ── Unidades (regla 0 de `ERP_KEPLER.md`) ─────────────────────────────────────────────────────
 * La existencia viene en la unidad BASE de Kepler (`analytics.v_erp_stock_on_hand.qty_stock_units`)
 * y el renglón se cotiza en su presentación (`qty_unit`, con `qty_factor` = bases por presentación;
 * null = la base). Es la misma conversión de `checkQuote` («hay 6, faltan 1», `[E.29]`): lo
 * requerido en base = cantidad × factor. Probado contra prod: 1 CJA de 24 contra 1,423 piezas.
 * `stock_at_quote` se guarda en BASE (comparable entre presentaciones del mismo SKU).
 */

/** Los valores del CHECK `commercial_quote_lines_availability_valid`. */
export type Disponibilidad = 'available' | 'partial' | 'unavailable' | 'not_carried' | 'unmatched' | 'unknown';

/**
 * La disponibilidad que se guarda en el renglón.
 *
 * @param delMotor  Lo que dijo el motor de precios. Sólo `'available'` («casó y tiene precio») se
 *                  vuelve a juzgar contra la existencia; `unavailable`/`not_carried` (sin precio en
 *                  esa sucursal) y `unmatched` (no casó) se conservan: hablan de otra cosa.
 * @param base      Existencia en unidad base. `null` = el ERP no la da para ese SKU en esa sucursal
 *                  (sin dato, que NO es cero).
 * @param cantidad  Lo cotizado, en la presentación del renglón.
 * @param factor    Bases por presentación; `null` = la base. `'desconocido'` = la presentación no
 *                  declara cuántas bases trae (el regalo del ERP): sólo se puede afirmar «no hay».
 */
export function disponibilidadAlCotizar(
  delMotor: string,
  base: number | null,
  cantidad: number,
  factor: number | null | 'desconocido',
): Disponibilidad {
  if (delMotor !== 'available') return delMotor as Disponibilidad;
  if (base === null || !Number.isFinite(base)) return 'unknown';
  if (base <= 0) return 'unavailable';
  if (factor === 'desconocido') return 'unknown';
  const requerido = cantidad * (factor !== null && factor > 0 ? factor : 1);
  return base < requerido ? 'partial' : 'available';
}
