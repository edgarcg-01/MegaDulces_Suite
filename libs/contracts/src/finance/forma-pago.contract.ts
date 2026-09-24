/**
 * `[GX.14]` — **Cómo se pagó el gasto**, declarado por quien lo hizo.
 *
 * Kepler NO lo pregunta al capturar la solicitud (`X-A-15-1`). Medido en prod el
 * 2026-09-23 sobre `analytics.expense_requests`: de **10,082 solicitudes, 5,410 (54%)
 * traen `forma_pago` vacía**, y son **$20,283,721.89**. Para un solicitante concreto
 * (LEONARDO CAZARES, 1,513 folios / $4.8 M en 12 meses) la declaró en **5**. O sea: el
 * campo existe en el ERP y nadie lo llena, porque nada se lo pide.
 *
 * Por eso este catálogo es **cerrado** y vive en `libs/contracts`: lo consumen el
 * backend (que valida) y el frontend (que dibuja los botones). Antes de centralizarlo,
 * la lista habría nacido duplicada a mano en los dos lados — el defecto que ADR-056
 * midió ocho veces.
 *
 * ## Los códigos no los inventamos
 * Cada opción lleva el código con el que Kepler guarda `forma_pago` (`kdm1.c90`), que a
 * su vez sigue el catálogo del SAT. Así lo declarado acá es **conmensurable** con lo que
 * el ERP ya tiene, y el día que se concilie no hay que traducir nada.
 *
 * ⚠️ **Lo que se deja fuera, se declara.** En los datos de prod aparecen además `06`
 * (dinero electrónico, 9 solicitudes) y `98` (13). No se ofrecen: entre los dos son
 * **22 de 10,082 (0.2%)**, y `98` ni siquiera es del catálogo SAT. Quien tenga uno de
 * esos elige `otro` y lo escribe — queda con texto, no con un código falso.
 */

/** Identificador estable de la forma de pago. Es lo que viaja en el DTO y en la columna. */
export type FormaPagoId = 'efectivo' | 'tarjeta' | 'transferencia' | 'cheque' | 'vales' | 'otro';

export interface FormaPago {
  id: FormaPagoId;
  /** Lo que lee la persona. */
  label: string;
  /** Código con el que Kepler/SAT guardan esta forma de pago (`kdm1.c90`). */
  codigo_kepler: string;
  /**
   * Qué se le pregunta además, o `null` si no se le pregunta nada.
   *
   * No es decoración: sin el dato, «efectivo» no dice de qué caja salió y «transferencia»
   * no se puede casar nunca con el movimiento del banco (Fase CB).
   */
  detalle_label: string | null;
  /** Ejemplo para el placeholder. Nunca se guarda. */
  detalle_ejemplo: string | null;
}

/** El catálogo. Cerrado: agregar una opción es tocar este archivo y su prueba. */
export const FORMAS_PAGO: readonly FormaPago[] = [
  { id: 'efectivo',      label: 'Efectivo',      codigo_kepler: '01', detalle_label: '¿De qué caja salió?',  detalle_ejemplo: 'Caja chica logística' },
  { id: 'tarjeta',       label: 'Tarjeta',       codigo_kepler: '04', detalle_label: 'Últimos 4 dígitos',    detalle_ejemplo: '0000' },
  { id: 'transferencia', label: 'Transferencia', codigo_kepler: '03', detalle_label: 'Referencia del banco', detalle_ejemplo: '882301' },
  { id: 'cheque',        label: 'Cheque',        codigo_kepler: '02', detalle_label: 'Número de cheque',     detalle_ejemplo: '1204' },
  { id: 'vales',         label: 'Vales',         codigo_kepler: '07', detalle_label: null,                   detalle_ejemplo: null },
  { id: 'otro',          label: 'Otro',          codigo_kepler: '99', detalle_label: '¿Cuál?',               detalle_ejemplo: 'Escribilo' },
] as const;

/** Los ids, para un CHECK de base de datos o una validación rápida. */
export const FORMAS_PAGO_IDS: readonly FormaPagoId[] = FORMAS_PAGO.map((f) => f.id);

/** La forma de pago con ese id, o `undefined` si no está en el catálogo. */
export function formaPago(id: string | null | undefined): FormaPago | undefined {
  return FORMAS_PAGO.find((f) => f.id === id);
}

/** ¿Es un id del catálogo? */
export function esFormaPagoValida(id: string | null | undefined): id is FormaPagoId {
  return !!formaPago(id ?? undefined);
}

/**
 * ¿Esta forma de pago exige que además se escriba el detalle?
 *
 * Una forma que no está en el catálogo devuelve `false` a propósito: el error que hay
 * que reportar es «forma de pago inválida», no «falta el detalle». Quien valida pregunta
 * primero por `esFormaPagoValida`.
 */
export function exigeDetalle(id: string | null | undefined): boolean {
  return formaPago(id ?? undefined)?.detalle_label != null;
}

/** El código Kepler de esa forma, o `null` si no está en el catálogo. */
export function codigoKepler(id: string | null | undefined): string | null {
  return formaPago(id ?? undefined)?.codigo_kepler ?? null;
}
