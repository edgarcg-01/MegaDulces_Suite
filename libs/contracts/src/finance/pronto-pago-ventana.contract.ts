/**
 * `[TP.20.4]`/`[TP.20.5]` — **La ventana de pronto pago, en un solo lugar.**
 *
 * La regla vive aquí porque la usan **tres** consumidores y por motivos distintos: *Pronto pago* la
 * publica como su razón de ser, y el *Calendario* la muestra como la urgencia de una factura
 * mientras se arma el día (`[TP.20.4]`); y la **ficha de la obligación** (`[TP.20.5]`) la publica
 * como un dato más de la vida de esa factura.
 *
 * ⛔ Por eso está en `libs/contracts` y no en `libs/finance`: la ficha la resuelve el
 * `entity-ref`, que es `scope:commercial`, y la compuerta de fronteras le prohíbe importar
 * `scope:finance`. El lugar donde los dos pueden verla es el contrato compartido.
 *
 * ⛔ **Por qué no se copió al Calendario.** Serían dos definiciones de «hasta cuándo conviene
 * pagar», y la primera vez que alguien ajuste el mínimo de observaciones o los días de aviso, las
 * dos pantallas dirían fechas distintas de la misma factura. El repo ya tiene cinco familias de
 * constantes duplicadas a mano (ADR-056) y ésta decide dinero.
 *
 * ── Lo que la regla dice, y lo que NO ────────────────────────────────────────────────────────
 *
 * ⚠️ La ventana es **OBSERVADA, no pactada**: sale de los pagos que de hecho obtuvieron descuento
 * (`analytics.mv_supplier_prompt_discount`), no de una condición acordada con el proveedor — ese
 * dato no existe en ninguna parte. Es una guía defendible, no una promesa.
 *
 * ⚠️ `fuera_de_ventana` **no significa «perdido»**: significa que se pasó la mediana de lo que
 * históricamente funcionó. Todavía puede cobrarse, y llamarlo perdido haría que Tesorería dejara
 * de intentarlo.
 *
 * ⚠️ `sin_medir` **no significa «no da descuento»**: significa que no hay observaciones
 * suficientes. No es lo mismo no saber que saber que no.
 */

/** Mínimo de observaciones para publicar una ventana. Medido: con 3 se conserva el 99.7 % del descuento. */
export const PRONTO_PAGO_MIN_OBS = 3;

/** Días antes del límite en que un renglón pasa a «por vencer». Es aviso, no regla de negocio. */
export const PRONTO_PAGO_DIAS_AVISO = 5;

export type EstadoVentana = 'capturable' | 'por_vencer' | 'fuera_de_ventana' | 'sin_medir';

/**
 * Los tres campos que decide la ventana, en SQL, como lista de columnas lista para un `SELECT`.
 *
 * @param v alias de la fuente con `fecha` y `pendiente` (`analytics.v_supplier_payables`)
 * @param d alias de `analytics.mv_supplier_prompt_discount`
 *
 * ⛔ `fecha_limite` queda **NULL** cuando no hay ventana medible: un `COALESCE` a hoy pondría
 * «vence hoy» sobre algo que nadie midió.
 */
export function sqlVentanaProntoPago(v = 'v', d = 'd'): string {
  const limite = `CASE WHEN ${d}.n_observaciones >= ${PRONTO_PAGO_MIN_OBS} AND ${v}.fecha IS NOT NULL
                       THEN ${v}.fecha + ${d}.dias_mediana END`;
  return `
    ${limite} AS pronto_fecha_limite,
    CASE WHEN ${d}.n_observaciones >= ${PRONTO_PAGO_MIN_OBS} AND ${d}.tasa_observada IS NOT NULL
         THEN round(${v}.pendiente * ${d}.tasa_observada, 2) END AS pronto_beneficio,
    CASE
      WHEN (${limite}) IS NULL                                               THEN 'sin_medir'
      WHEN (${limite}) <  CURRENT_DATE                                       THEN 'fuera_de_ventana'
      WHEN (${limite}) <= CURRENT_DATE + ${PRONTO_PAGO_DIAS_AVISO}           THEN 'por_vencer'
      ELSE 'capturable'
    END AS pronto_estado`;
}
