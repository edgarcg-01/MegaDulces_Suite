/**
 * `[RE.73]` — **Cuándo el total del papel del proveedor cuadra con la entrada de Kepler.** Una sola
 * regla para el expediente (servidor, check `E1_cuadre`) y para el panel de la orden de entrada.
 *
 * Decisión de Francisco (2026-10-06): la diferencia tiene que ser MENOR al 0.25 % del monto Y MENOR a
 * $200. Las dos.
 *
 * Por qué vive en `contracts`: el panel usaba ±$1 fijo y el expediente, justo debajo, esta regla.
 * Medido en prod el 2026-11-14 sobre 1,845 entradas con total leído: en **40** el panel decía «cobra de
 * más/menos» y el expediente «cuadra»; en **317** el panel decía «coinciden al centavo» con hasta $1
 * de diferencia. Dos copias de la misma regla ya divergieron en este dominio (ver `lectura-escala`).
 */

/** Tolerancia relativa: menor al 0.25 % del monto de la entrada. */
export const TOLERANCIA_PCT = 0.0025;
/** Tolerancia absoluta: menor a $200. */
export const TOLERANCIA_ABS = 200;
/** Por debajo de esto, dos importes son el mismo al centavo. */
export const CENTAVO = 0.005;

/** ¿La diferencia cabe en la tolerancia del cuadre? Las DOS condiciones. */
export function cuadraDentroDeTolerancia(diferencia: number, monto: number): boolean {
  const d = Math.abs(diferencia);
  return d < TOLERANCIA_ABS && d < TOLERANCIA_PCT * Math.abs(monto);
}

/** La regla escrita para una persona: «menos de 0.25 % y de $200». */
export const TOLERANCIA_TEXTO = `menos de ${(TOLERANCIA_PCT * 100).toFixed(2)} % y de $${TOLERANCIA_ABS}`;
