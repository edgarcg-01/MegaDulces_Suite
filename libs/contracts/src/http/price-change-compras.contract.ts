/**
 * `[ETQ-CAMBIOS.11]` Lo que Compras pidió que traiga «Cambios de precio» (su reporte en PDF): proveedor,
 * UXC, costo anterior y actual CON impuesto, precio de caja («mayoreo») y tipo de cambio.
 *
 * Lógica PURA, sin I/O: la usan el servicio (para elegir el «anterior» de la historia) y la pantalla
 * (para casar una línea con su costo y calcular el costo con impuesto). Una regla, dos consumidores.
 *
 * ⚠️ Reglas que la sostienen (ADR-056: lo que no se sabe se DECLARA, nunca se dibuja como cero):
 *  · el costo ANTERIOR sólo existe desde que el cron empezó a guardar la foto diaria; antes es `null`;
 *  · el costo CON impuesto exige la tasa observada en ventas; sin ella es `null`, no «sin impuesto».
 */

/** El costo de UNA presentación de la ficha (pieza / paquete / caja), SIN impuesto, tal como lo tiene Kepler. */
export interface CostoPresentacion {
  /** Rótulo que Kepler le pone a la presentación (`PZA`, `CJA`, `500`…). */
  unidad: string;
  costo_actual: number;
  /** `null` = no hay historia anterior: producto nuevo o foto diaria todavía sin cambios. */
  costo_anterior: number | null;
  /** Día (`YYYY-MM-DD`) desde el que la foto vio ese costo anterior. */
  anterior_desde: string | null;
}

/** Los datos de Compras de UN código, en la plaza consultada. */
export interface FichaCompras {
  sku: string;
  proveedor: string | null;
  /** Unidades por caja de la ficha de la plaza (`null` si el producto no tiene presentación de caja). */
  uxc: number | null;
  /** Precio de la presentación CAJA (decisión de Edgar, 2026-10-15). `null` = no hay caja o no tiene precio. */
  mayoreo_caja: number | null;
  /** Tasa de impuesto observada en ventas. `null` = el producto no tiene ventas: no se sabe, no es 0. */
  impuesto_pct: number | null;
  costos: CostoPresentacion[];
}

/** Una fila de la historia del costo (`analytics.product_cost_history`), SIN impuesto. */
export interface HistorialCosto {
  costo: number;
  /** `YYYY-MM-DD` del día que el cron vio ese costo. */
  desde: string;
}

const EPS = 0.00005;

/**
 * Elige el costo ANTERIOR de una presentación. `historial` va del más nuevo al más viejo.
 *
 *  · si la última foto ya es el costo de hoy, el anterior es la foto de antes;
 *  · si el costo de hoy todavía no se fotografió (cambió después del cron), el anterior es la última foto.
 *
 * Con una sola foto igual al costo de hoy no hay anterior: es la siembra, no un cambio.
 */
export function elegirAnterior(
  historial: readonly HistorialCosto[],
  actual: number,
): { costo_anterior: number | null; anterior_desde: string | null } {
  const ultima = historial[0];
  if (!ultima) return { costo_anterior: null, anterior_desde: null };
  const fila = Math.abs(ultima.costo - actual) < EPS ? historial[1] : ultima;
  return fila ? { costo_anterior: fila.costo, anterior_desde: fila.desde } : { costo_anterior: null, anterior_desde: null };
}

/** Mismo rótulo, sin importar mayúsculas ni espacios. */
export const normalizarUnidad = (u: string | null | undefined): string => String(u ?? '').trim().toUpperCase();

/**
 * El costo de la presentación a la que se refiere una línea de la lista. Casa por RÓTULO exacto (normalizado):
 * si no hay un solo costo con ese rótulo, devuelve `null` y la pantalla dice «sin dato». Nunca se adivina por
 * posición: los rótulos de Kepler vienen sucios (`500`) y casar a ciegas pondría el costo de la caja junto al
 * precio de la pieza.
 */
export function costoDeLinea(ficha: FichaCompras | null | undefined, unidad: string | null): CostoPresentacion | null {
  if (!ficha) return null;
  const buscado = normalizarUnidad(unidad);
  if (!buscado) return null;
  const hay = ficha.costos.filter((c) => normalizarUnidad(c.unidad) === buscado);
  return hay.length === 1 ? hay[0] : null;
}

/** Costo con impuesto. Sin tasa conocida (o sin costo) → `null`: no se publica como si no llevara impuesto. */
export function costoConImpuesto(sinImpuesto: number | null, impuestoPct: number | null): number | null {
  if (sinImpuesto == null || impuestoPct == null) return null;
  return Math.round(sinImpuesto * (1 + impuestoPct / 100) * 100) / 100;
}

/**
 * Tipo de cambio del PDF de Compras: `N` = sin costo anterior (producto nuevo, o la foto todavía no tiene
 * historia), `S` = el costo cambió. `null` = el costo no se movió, o no se conoce el de hoy.
 */
export type TipoCambio = 'N' | 'S';

export function tipoCambio(costo: CostoPresentacion | null): TipoCambio | null {
  if (!costo) return null;
  if (costo.costo_anterior == null) return 'N';
  return Math.abs(costo.costo_actual - costo.costo_anterior) < EPS ? null : 'S';
}
