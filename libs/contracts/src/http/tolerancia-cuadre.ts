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

/**
 * `[RE.79]` ¿El papel de una evidencia (`finance.goods_receipt_proofs`) cuadra con la entrada? Se DERIVA de
 * lo guardado, no se copia: `monto_match` se calculó al capturar con ±$1 (`receipt_settings.match_tolerance`)
 * y la regla de Francisco la deja corta. Cuadra si `monto_match` ya decía que sí (incluye el cuadre contra
 * la captura de oficinas, que no se guarda aparte) o si el total o el subtotal leídos caben en la
 * tolerancia contra `receipt_monto`. Sin lectura (`monto_match` nulo) sigue siendo `null`.
 *
 * Medido en prod (2026-11-14): 35 evidencias pendientes y 5 validadas pasan a cuadrar. 2 pendientes que
 * cuadraron con ±$1 sobre montos chicos (donde $1 ya es más del 0.25 %) SIGUEN cuadrando: un `true`
 * guardado no se revoca al leer.
 */
export interface EvidenciaMonto {
  monto_match: boolean | null;
  ocr_monto: number | string | null;
  ocr_subtotal: number | string | null;
  receipt_monto: number | string | null;
}
export function evidenciaCuadra(e: EvidenciaMonto): boolean | null {
  if (e.monto_match == null) return null;
  if (e.monto_match) return true;
  const r = e.receipt_monto == null ? null : Number(e.receipt_monto);
  if (r == null || !Number.isFinite(r)) return false;
  const dentro = (v: number | string | null) => v != null && Number.isFinite(Number(v)) && cuadraDentroDeTolerancia(Number(v) - r, r);
  return dentro(e.ocr_monto) || dentro(e.ocr_subtotal);
}

/** El gemelo SQL de `evidenciaCuadra`, sobre una fila de `finance.goods_receipt_proofs` (prefijo opcional, p. ej. `p.`). */
export function sqlEvidenciaCuadra(p = ''): string {
  const r = `${p}receipt_monto`;
  const dentro = (v: string) => `(${v} IS NOT NULL AND ${r} IS NOT NULL AND abs(${v} - ${r}) < ${TOLERANCIA_ABS} AND abs(${v} - ${r}) < ${TOLERANCIA_PCT} * abs(${r}))`;
  return `(CASE WHEN ${p}monto_match IS NULL THEN NULL ELSE (${p}monto_match OR ${dentro(`${p}ocr_monto`)} OR ${dentro(`${p}ocr_subtotal`)}) END)`;
}

/** La regla escrita para una persona: «menos de 0.25 % y de $200». */
export const TOLERANCIA_TEXTO = `menos de ${(TOLERANCIA_PCT * 100).toFixed(2)} % y de $${TOLERANCIA_ABS}`;
