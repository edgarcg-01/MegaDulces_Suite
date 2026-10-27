/**
 * `[OPS-AUD.11.6]` (ADR-104) — El veredicto del árbitro de las tablas mantenidas POR CAMBIO.
 *
 * Los triggers mantienen `analytics.bank_movement_legs` (tesorería) y el reporte de pólizas de
 * Kepler (`analytics.gl_polizas`/`gl_poliza_lines`, source='kepler'). Un trigger con un hueco no
 * falla: deja la tabla desfasada EN SILENCIO. Este árbitro es lo único que lo nota.
 *
 * Reglas, puras para poder probarlas sin base:
 *   · una diferencia (faltan o sobran) es una FALLA aunque se haya reparado: significa que el
 *     trigger tiene un hueco, y repararla en silencio lo escondería para siempre;
 *   · un error registrado por el trigger en la ventana también es falla;
 *   · lo que no se pudo medir se declara (`sin_medir`), nunca se cuenta como cero.
 */

export interface MedicionArbitro {
  /** Qué se arbitró: `tesoreria` o `polizas:kdc22610`. */
  objeto: string;
  faltan: number | null;
  sobran: number | null;
  /** Diferencias que quedaron DESPUÉS de reparar (null = no se intentó). */
  tras_reparar?: { faltan: number; sobran: number } | null;
  /** Mensaje si la medición misma falló. */
  error?: string | null;
}

export interface VeredictoArbitro {
  fallas: string[];
  /** Objetos medidos sin diferencias. */
  limpios: number;
  /** Objetos que no se pudieron medir. */
  sin_medir: number;
  nota: string;
}

export function veredictoArbitro(
  mediciones: readonly MedicionArbitro[],
  erroresTrigger: Record<string, number>,
  /**
   * `[OPS-AUD.13.2]` Pólizas del ODS a una hora que no es 00:00, por tabla. La normalización del
   * 2026-10-27 las dejó TODAS a medianoche (como el origen): una nueva prueba que algún carril
   * sigue escribiendo la fecha corrida 6 h, y cada una es un duplicado en potencia.
   */
  polizasFueraDeHora: Record<string, number> = {},
): VeredictoArbitro {
  const fallas: string[] = [];
  const fuera = Object.entries(polizasFueraDeHora).filter(([, n]) => n > 0);
  if (fuera.length) {
    fallas.push(`pólizas del ODS fuera de las 00:00 (un carril escribe la fecha corrida): `
      + fuera.map(([t, n]) => `${t} ${n}`).join(', '));
  }
  let limpios = 0;
  let sinMedir = 0;
  for (const m of mediciones) {
    if (m.error || m.faltan == null || m.sobran == null) {
      sinMedir++;
      fallas.push(`${m.objeto}: NO MEDIDO (${(m.error ?? 'sin resultado').slice(-160)})`);
      continue;
    }
    if (m.faltan === 0 && m.sobran === 0) { limpios++; continue; }
    const rep = m.tras_reparar
      ? (m.tras_reparar.faltan === 0 && m.tras_reparar.sobran === 0
        ? 'reparado'
        : `NO se reparó (quedan faltan ${m.tras_reparar.faltan} · sobran ${m.tras_reparar.sobran})`)
      : 'sin reparar';
    fallas.push(`${m.objeto}: faltan ${m.faltan} · sobran ${m.sobran} — el trigger tiene un hueco (${rep})`);
  }
  for (const [tabla, n] of Object.entries(erroresTrigger)) {
    if (n > 0) fallas.push(`${tabla}: ${n} error(es) del trigger en las últimas 25 h`);
  }
  return {
    fallas,
    limpios,
    sin_medir: sinMedir,
    nota: `${limpios} de ${mediciones.length} sin diferencias`,
  };
}
