/**
 * `[CG.42.1]` — **El veredicto de un arqueo de caja, en UN solo lugar.**
 *
 * ── Por qué vive acá y no en `libs/finance` ──────────────────────────────────────────────────
 *
 * Lo necesitan DOS lados que no se pueden importar entre sí: el motor
 * (`libs/finance/src/lib/caja/cash-cut.engine.ts`, que lo CALCULA) y la pantalla
 * (`apps/view/.../caja-general/caja-captura.util.ts`, que apaga el botón de cerrar con su motivo
 * en vez de dejar que la persona choque contra un 403). `apps/view` no puede importar de
 * `@megadulces/finance` — sólo `contracts`, `shared-scoring` y `ui-web`, y la compuerta de
 * fronteras lo hace cumplir.
 *
 * ⛔ **Estaba escrito a mano en los dos lados, y se cobró el 2026-10-06.** `[CG.42]` agregó
 * `sin_base` al motor y el espejo del front quedó atrás: el build se rompió con
 * `TS2345: Type '"sin_base"' is not assignable to type 'VeredictoCorte'`. Tuvo suerte de romperse
 * — el archivo del front decía *«ESTO ESPEJA al engine A PROPÓSITO»* y **nada comprobaba que
 * siguieran iguales**. Es la deuda que ADR-056 midió como «cinco familias de constantes
 * duplicadas a mano»: el día que una se mueve, las dos siguen siendo plausibles por separado.
 *
 * Acá el tipo es **uno**, así que divergir deja de ser posible en vez de ser improbable.
 *
 * ⚠️ Esto NO mueve la defensa. El candado del cierre y de la doble llave vive en la base
 * (`cut_cerrado_completo_chk`, `cut_doble_llave_chk`) y en el servicio. Lo de la pantalla sólo
 * puede ser IGUAL o MÁS ESTRICTO; si divergen, manda el servidor.
 */

/**
 * Cómo salió el arqueo. Los tres últimos **no son grados de «no cuadra»**: son razones distintas
 * por las que la pregunta «¿cuadra?» no tiene respuesta.
 *
 * · `cuadra`      — |contado − esperado| ≤ 1 centavo.
 * · `sobra`       — contado por encima del esperado.
 * · `falta`       — contado por debajo.
 * · `sin_contar`  — nadie contó. ⛔ **No es `cuadra`**: si un corte sin conteo devolviera 0
 *                   contra 0, un día que nadie contó se vería igual que uno que cuadró al centavo.
 * · `sin_base`    — `[CG.42]` no se midió con cuánto arrancó la caja (`fondo_inicial IS NULL`,
 *                   `fondo_origen = 'sin_medir'`). El `esperado` arranca de un supuesto, así que
 *                   decir `cuadra` sería afirmar que coincide con algo que nadie midió — y el
 *                   error se vería como un sobrante del tamaño exacto del fondo de cambio, todos
 *                   los días.
 */
export type VeredictoCorte = 'cuadra' | 'sobra' | 'falta' | 'sin_contar' | 'sin_base';

/**
 * Los veredictos en los que **no se puede afirmar si la caja cuadra**. Sirve para que la pantalla
 * no los pinte como un faltante ni como un cuadre: no son un resultado, son la ausencia de uno.
 */
export const VEREDICTOS_SIN_RESPUESTA: readonly VeredictoCorte[] = ['sin_contar', 'sin_base'] as const;

/** ¿Este veredicto responde «¿cuadra?», o declara que no se puede saber? */
export function veredictoConcluyente(v: VeredictoCorte | null | undefined): boolean {
  return v != null && !VEREDICTOS_SIN_RESPUESTA.includes(v);
}
