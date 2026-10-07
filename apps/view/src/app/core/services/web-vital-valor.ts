/**
 * `[RA-PERF.5]` El valor de un Core Web Vital, guardado sin destruirlo.
 *
 * ── Qué estaba mal ──────────────────────────────────────────────────────────────────────────
 * `UsoService.medirWebVitals()` guardaba `Math.round(m.value)` para las tres métricas por igual.
 * INP y LCP son MILISEGUNDOS y redondear está bien. **CLS no: es un score SIN UNIDAD entre 0 y
 * ~1**, cuyos propios umbrales son 0.1 y 0.25 — así que `Math.round(0.31)` da **0**, y un
 * desplazamiento de layout malo quedaba archivado como un score perfecto.
 *
 * Medido en prod el 2026-10-07, sobre las 795 muestras de CLS que ya existían:
 *   · `needs-improvement` → **145 de 145 (100 %)** guardadas con valor 0
 *   · `poor`              → **91 de 188 (48 %)**  guardadas con valor 0
 * O sea **236 mediciones malas con cara de score perfecto**. Es el caso que ADR-056 nombra al
 * revés de lo habitual: no se dibujó un cero donde faltaba el dato, se dibujó un cero donde el
 * dato existía y era malo.
 *
 * ⭐ Lo que permitió medir el daño es que el `rating` viaja al lado y **lo calcula la librería**,
 * no nosotros: siempre dijo la verdad. Un valor y su calificación que se contradicen son la
 * señal; por eso la calificación se sigue guardando aunque parezca redundante.
 *
 * ⚠️ Lo ya guardado NO se puede reparar — el valor original se perdió en el redondeo. El análisis
 * histórico de CLS tiene que agrupar por `rating`, no por `value`. Desde este cambio sirven los dos.
 *
 * ── La regla ────────────────────────────────────────────────────────────────────────────────
 * **La unidad decide el redondeo, no la comodidad del entero.** Métrica sin unidad = 3 decimales
 * (la precisión con la que la especificación de CLS publica sus umbrales). Si mañana entra otra
 * métrica sin unidad, se agrega al conjunto de abajo y no hay que tocar nada más.
 */

/** Métricas cuyo valor es un SCORE, no milisegundos. Redondearlas a entero las destruye. */
export const WEB_VITALS_SIN_UNIDAD = new Set<string>(['CLS']);

/** Umbral de CLS a partir del cual la especificación lo llama `poor`. Sólo para pruebas y lectura. */
export const CLS_UMBRAL_POOR = 0.25;

export function valorWebVital(metrica: string, valor: number): number {
  return WEB_VITALS_SIN_UNIDAD.has(metrica)
    ? Math.round(valor * 1000) / 1000   // 3 decimales: 0.312 sigue siendo 0.312, no 0
    : Math.round(valor);                // ms: el entero es la precisión útil
}
