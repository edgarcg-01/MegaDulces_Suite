/**
 * `[CGP-L.10]` El sensor del corte abierto, en funciones PURAS.
 *
 * ⛔ El corte del 12-oct (`CC-2026-00001`) estuvo trabado tres jornadas y NINGÚN sistema avisó. Un
 * corte en borrador bloquea abrir los siguientes de su sucursal (`ux_cash_cut_abierto`), así que los
 * días se acumulan en silencio: el 13 y el 14 tuvieron movimientos y no tuvieron corte. Lo descubrió
 * una persona, no una alarma.
 *
 * Dos señales, porque fallan distinto:
 *  · un corte en BORRADOR viejo — la causa (algo impide cerrarlo);
 *  · jornadas con movimientos y SIN corte — la consecuencia (lo que se está acumulando).
 * Una puede estar sin la otra: si alguien nunca abre el corte, no hay borrador viejo pero sí
 * jornadas sin corte.
 *
 * Los umbrales son los del resto de lo diario del módulo (`caja_fecha_futura`: 26 h aviso, 50 h
 * crítico): una jornada se cierra el mismo día; 26 h deja holgura para cerrar al día siguiente.
 */

export const UMBRAL_CORTE_ABIERTO_H = { aviso: 26, critico: 50 } as const;

export interface CorteAbiertoFila { folio: string; fecha: string; horas: number }

export interface MedicionCortesAbiertos {
  /** Cortes en borrador, con cuántas horas llevan abiertos. */
  abiertos: CorteAbiertoFila[];
  /** Jornadas (YYYY-MM-DD) con movimientos vivos del libro y sin corte del cajón. */
  jornadasSinCorte: string[];
  /** Desde cuándo hay cortes: antes de eso no hay jornada que reclamar. */
  inicioLibro: string | null;
}

export interface AvisoCorteAbierto {
  key: 'caja_corte_abierto';
  severity: 'warn' | 'critical';
  title: string;
  message: string;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** 'YYYY-MM-DD' → '12-oct'. Sin `Date`: una fecha de calendario no tiene zona horaria. */
export function diaCorto(fecha: string): string {
  const [, m, d] = String(fecha).slice(0, 10).split('-');
  const mes = MESES[Number(m) - 1];
  return mes ? `${Number(d)}-${mes}` : String(fecha);
}

function cuanto(horas: number): string {
  return horas >= 48 ? `${Math.floor(horas / 24)} días` : `${Math.floor(horas)} h`;
}

/** Cada cuánto se RECUERDA un aviso que no cambió. */
export const RECORDAR_CADA_MS = 6 * 60 * 60 * 1000;

/**
 * ¿Se manda este aviso, o ya se dijo?
 *
 * El canal de avisos no agrupa: un sensor que corre cada hora con un corte trabado mandaría 24
 * avisos críticos al día, y una alarma que grita de más enseña a ignorarla. Se avisa cuando la
 * situación CAMBIA (otro corte, otra jornada, otra gravedad) y, si sigue igual, cada 6 horas.
 */
export function debeAvisar(
  previo: { huella: string; at: number } | null, huella: string, ahoraMs: number, cadaMs = RECORDAR_CADA_MS,
): boolean {
  if (!previo || previo.huella !== huella) return true;
  return ahoraMs - previo.at >= cadaMs;
}

/** La identidad de una situación: qué cortes, qué jornadas y con qué gravedad. Sin las horas. */
export function huellaDeSituacion(m: MedicionCortesAbiertos, aviso: AvisoCorteAbierto): string {
  const viejos = m.abiertos.filter((c) => c.horas > UMBRAL_CORTE_ABIERTO_H.aviso).map((c) => c.folio).sort();
  return `${aviso.severity}|${viejos.join(',')}|${[...m.jornadasSinCorte].sort().join(',')}`;
}

/**
 * ¿Hay que avisar, y con qué fuerza? `null` = nada que decir.
 *
 * Crítico si algún corte pasó el umbral crítico o si ya hay DOS o más jornadas sin corte (el patrón
 * del 13 y el 14-oct); aviso con lo demás que pase el umbral.
 */
export function avisoCortesAbiertos(m: MedicionCortesAbiertos): AvisoCorteAbierto | null {
  const viejos = m.abiertos.filter((c) => c.horas > UMBRAL_CORTE_ABIERTO_H.aviso);
  const sinCorte = m.jornadasSinCorte;
  if (viejos.length === 0 && sinCorte.length === 0) return null;

  const critico = viejos.some((c) => c.horas > UMBRAL_CORTE_ABIERTO_H.critico) || sinCorte.length >= 2;
  const partes: string[] = [];
  for (const c of viejos) {
    partes.push(`El corte ${c.folio} (${diaCorto(c.fecha)}) lleva ${cuanto(c.horas)} abierto: mientras no se cierre, `
      + 'no se puede abrir el de los días siguientes.');
  }
  if (sinCorte.length) {
    const dias = sinCorte.map(diaCorto).join(', ');
    partes.push(sinCorte.length === 1
      ? `La jornada del ${dias} tiene movimientos y no tiene corte.`
      : `Hay ${sinCorte.length} jornadas con movimientos y sin corte: ${dias}.`);
  }
  return {
    key: 'caja_corte_abierto',
    severity: critico ? 'critical' : 'warn',
    title: critico ? 'Caja General: el corte lleva días sin cerrarse' : 'Caja General: hay un corte pendiente',
    message: partes.join(' '),
  };
}
