/**
 * `[COT.54]` Cuánto costó capturar una cotización — viaja en el alta (`POST /commercial/quotes`,
 * campo `capture`) y se guarda en `commercial.quotes.capture_*`. Se reporta SÓLO agregado (por
 * sucursal o semana), nunca un ranking por persona (decisión de Francisco, 2026-11-22).
 */
export interface CapturaCotizacion {
  /** Del primer artículo agregado a la bandeja hasta guardar. */
  segundos: number;
  /** Búsquedas de artículo en esa captura. */
  busquedas: number;
  /** Se recuperó de un respaldo del navegador (COT.50): los segundos cuentan desde que se recuperó; lo de antes del corte no se midió. */
  recuperada: boolean;
}

/** Más que un turno no es una captura: es una pestaña olvidada. Se guarda como no medido. */
export const TOPE_SEGUNDOS_CAPTURA = 8 * 3600;

/**
 * La captura que se guarda, o null = no medida. No se recorta ni se corrige nada: un valor
 * imposible se DECLARA sin dato (regla 11), no se convierte en uno creíble.
 */
export function capturaLimpia(c: unknown): CapturaCotizacion | null {
  if (!c || typeof c !== 'object') return null;
  const { segundos, busquedas, recuperada } = c as Record<string, unknown>;
  const entero = (v: unknown, tope: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= tope;
  if (!entero(segundos, TOPE_SEGUNDOS_CAPTURA) || !entero(busquedas, 100_000) || typeof recuperada !== 'boolean') return null;
  return { segundos: segundos as number, busquedas: busquedas as number, recuperada };
}
