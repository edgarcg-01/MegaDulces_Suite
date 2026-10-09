/**
 * `[GX.75]` **La transferencia `XD2601` que pagó un gasto `XA1001`** — el tercer número del
 * expediente (solicitud `XA1501` → gasto `XA1001` → transferencia `XD2601`).
 *
 * ## De dónde sale, medido antes de construirlo
 * Kepler guarda la aplicación de cada egreso en `kdm5`: qué documento pagó (`c2..c6`) a qué
 * documento (`c8..c11`) y cuánto (`c13`). Para egresos la única combinación es
 * `XD26 tipo 1 → XA10 tipo 1` (18,352 renglones en la sucursal 00). Se comprobó contra un
 * testigo independiente: el acreedor de la transferencia coincide con el del gasto en el
 * **100%** de los vínculos, contra **4.7%** de un emparejamiento al azar (placebo).
 *
 * ## ⚠️ Por qué es una LISTA
 * Un gasto se paga en varias transferencias (2,269 gastos en 12 meses) y una transferencia
 * paga varios gastos (193). Un campo singular escondería el resto sin un error.
 *
 * ## ⛔ Kepler NO borra la aplicación de una transferencia cancelada
 * Medido en la 00: **113 aplicaciones por $399,161** siguen en `kdm5` con su `XD2601`
 * cancelada (`c43 = 'C'`). Se mandan marcadas, y **no cuentan como pagado**.
 */
export interface TransferenciaGasto {
  /** El folio del gasto `XA1001` que pagó (un vale puede tener varios gastos). */
  gasto_folio: string;
  /** El folio de la transferencia `XD2601`, tal como se teclea en Kepler. */
  folio: string;
  /** El día de la transferencia (`YYYY-MM-DD`). `null` = no se encontró su encabezado. */
  fecha: string | null;
  /**
   * El importe del documento `XD2601` completo. Puede ser MAYOR que lo aplicado a este gasto
   * (la transferencia pagó varios) o incluso menor: Kepler deja aplicar de más.
   */
  importe: number | null;
  /** Lo que esta transferencia aplicó a ESTE gasto. Es la cifra que se suma. */
  aplicado: number;
  cancelada: boolean;
}

/** Lo que la pantalla necesita para decir «pagado» sin sumar cancelaciones. */
export interface ResumenTransferencias {
  /** `false` = no se pudo medir en este entorno (no hay ODS de Kepler). Se declara, no se dibuja cero. */
  medido: boolean;
  vigentes: number;
  canceladas: number;
  /** Suma de lo aplicado por transferencias vigentes. */
  aplicado: number;
  /** El día de la transferencia vigente más reciente. */
  ultima_fecha: string | null;
}

/**
 * `[GX.75]` ¿El vale ya está pagado? La lee «Mis gastos» para separar «Sin pago» de «Pagados».
 *  · `pagado`     — lo transferido (sin canceladas) cubre el importe del vale.
 *  · `parcial`    — hay transferencia vigente, pero cubre menos que el vale.
 *  · `sin_pago`   — Kepler no tiene ninguna transferencia vigente aplicada.
 *  · `sin_medir`  — no se pudo consultar (`null`): NO se afirma que falte el pago.
 *
 * Tolerancia: $1 o 1% (la misma de `cuadraImporte` en el expediente). Medido en prod el
 * 2026-10-07: en los **58 de 58** vales con transferencia lo aplicado coincide con el importe del
 * vale; `parcial` no ocurre hoy, pero si ocurre no se pinta como pagado.
 */
export type EstadoPagoVale = 'pagado' | 'parcial' | 'sin_pago' | 'sin_medir';

export function estadoPagoDelVale(
  ts: readonly TransferenciaGasto[] | null | undefined,
  importeVale: number,
): EstadoPagoVale {
  const r = resumenTransferencias(ts);
  if (!r.medido) return 'sin_medir';
  if (!r.vigentes) return 'sin_pago';
  const imp = Number(importeVale) || 0;
  return r.aplicado >= imp - Math.max(1, Math.abs(imp) * 0.01) ? 'pagado' : 'parcial';
}

/**
 * Resume las transferencias de un vale. Pura: la usan la pantalla y el PDF, y se prueba sin base.
 * `null` significa «no medido» y se propaga como `medido: false`, no como «sin transferencias».
 */
export function resumenTransferencias(ts: readonly TransferenciaGasto[] | null | undefined): ResumenTransferencias {
  if (ts == null) return { medido: false, vigentes: 0, canceladas: 0, aplicado: 0, ultima_fecha: null };
  const vigentes = ts.filter((t) => !t.cancelada);
  const aplicado = Math.round(vigentes.reduce((s, t) => s + (Number(t.aplicado) || 0), 0) * 100) / 100;
  const ultima = vigentes.map((t) => t.fecha).filter((f): f is string => !!f).sort().pop() ?? null;
  return { medido: true, vigentes: vigentes.length, canceladas: ts.length - vigentes.length, aplicado, ultima_fecha: ultima };
}
