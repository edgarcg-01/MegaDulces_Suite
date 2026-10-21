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

import { diaCorto } from '@megadulces/contracts';
import type { BandejaSinConfirmar } from './caja-jornadas.query';

export const UMBRAL_CORTE_ABIERTO_H = { aviso: 26, critico: 50 } as const;

export interface CorteAbiertoFila { folio: string; fecha: string; horas: number }

export interface MedicionCortesAbiertos {
  /** Cortes en borrador, con cuántas horas llevan abiertos. */
  abiertos: CorteAbiertoFila[];
  /** Jornadas (YYYY-MM-DD) con movimientos vivos del libro y sin corte del cajón. */
  jornadasSinCorte: string[];
  /** Desde cuándo hay cortes: antes de eso no hay jornada que reclamar. */
  inicioLibro: string | null;
  /**
   * `[CGP-L.13]` Lo que la bandeja propone y nadie confirmó, de ayer o antes.
   * ⚠️ `null` = **no se pudo medir** (la vista no está). No es «cero pendientes», y por eso no
   * dispara ni calla un aviso: se declara (ADR-056).
   */
  bandeja?: BandejaSinConfirmar | null;
}

/**
 * `[CGP-L.13]` Umbrales de la bandeja, en DÍAS porque un documento tiene fecha, no hora.
 * Aviso en cuanto algo de ayer sigue sin confirmar; crítico a los dos días.
 */
export const UMBRAL_BANDEJA_DIAS = { aviso: 1, critico: 2 } as const;

export interface AvisoCorteAbierto {
  /** `[CGS.3b]` `caja_corte_sin_revisar`: el escalamiento de las 12:00 a la suplente. */
  key: 'caja_corte_abierto' | 'caja_corte_sin_revisar';
  severity: 'warn' | 'critical';
  title: string;
  message: string;
}

/** `[CGP-L.4]` La copia única vive en `contracts`: la usa también la pantalla. */
export { diaCorto };

function cuanto(horas: number): string {
  return horas >= 48 ? `${Math.floor(horas / 24)} días` : `${Math.floor(horas)} h`;
}

/** El dinero, en el aviso, con la misma forma que lo escribe la pantalla. */
function pesos(n: number): string {
  return `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  /**
   * `[CGP-L.13]` De la bandeja entra **el día del más viejo**, no el conteo: confirmar 3 de 35 no
   * es una situación nueva y no tiene que volver a sonar. Lo que cambia la situación es que
   * aparezca un día más viejo (o que se vacíe).
   */
  const bandeja = m.bandeja && m.bandeja.movimientos > 0 ? `b:${m.bandeja.masViejo}` : '';
  return `${aviso.severity}|${viejos.join(',')}|${[...m.jornadasSinCorte].sort().join(',')}|${bandeja}`;
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
  // `[CGP-L.13]` `null` es NO MEDIDO y no habla; 0 movimientos es «al día» y tampoco.
  const bandeja = m.bandeja && m.bandeja.movimientos > 0 && m.bandeja.dias >= UMBRAL_BANDEJA_DIAS.aviso
    ? m.bandeja : null;
  if (viejos.length === 0 && sinCorte.length === 0 && !bandeja) return null;

  const critico = viejos.some((c) => c.horas > UMBRAL_CORTE_ABIERTO_H.critico)
    || sinCorte.length >= 2
    || (bandeja != null && bandeja.dias >= UMBRAL_BANDEJA_DIAS.critico);
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
  if (bandeja) {
    partes.push(`La bandeja tiene ${bandeja.movimientos} movimiento${bandeja.movimientos === 1 ? '' : 's'} `
      + `sin confirmar por ${pesos(bandeja.monto)}; el más viejo es del ${diaCorto(bandeja.masViejo)} `
      + `(${bandeja.dias} día${bandeja.dias === 1 ? '' : 's'}).`);
  }
  /**
   * El título nombra lo MÁS GRAVE que hay, no lo primero que se midió: quien lee la campana tiene
   * que saber de qué se trata sin abrirla. Un corte trabado tranca los días siguientes; la bandeja
   * sólo deja un hueco que después nadie recuerda — grave, pero no bloqueante.
   */
  const soloBandeja = viejos.length === 0 && sinCorte.length === 0;
  const title = soloBandeja
    ? (critico ? 'Caja General: la bandeja lleva días sin confirmarse' : 'Caja General: quedaron movimientos sin confirmar')
    : (critico ? 'Caja General: el corte lleva días sin cerrarse' : 'Caja General: hay un corte pendiente');
  return {
    key: 'caja_corte_abierto',
    severity: critico ? 'critical' : 'warn',
    title,
    message: partes.join(' '),
  };
}

// ── `[CGS.3b]` D2: a las 12:00 del día siguiente, el corte sin revisar escala a la suplente ──

/** La hora (México) del día SIGUIENTE a la jornada en que un corte cerrado ya debió revisarse. */
export const HORA_LIMITE_REVISION = 12;

export interface RevisionTardia { folio: string; fecha: string }

/**
 * ⭐ D2 de Edgar (2026-10-21): la supervisora revisa de mañana; **a las 12:00 sin revisar, el
 * aviso pasa también a la suplente** (Dirección). Antes de esa hora la revisión vive en «Mi
 * trabajo» de la supervisora y no se manda nada: avisar a Dirección por un corte de ayer a las
 * 9:00 sería ruido. La lista la arma el sensor con `fecha + 1 + 12 h <= ahora`.
 */
export function avisoRevisionTardia(tardios: RevisionTardia[]): AvisoCorteAbierto | null {
  if (!tardios.length) return null;
  const lista = tardios.map((t) => `${t.folio} (${diaCorto(t.fecha)})`).join(', ');
  return {
    key: 'caja_corte_sin_revisar',
    severity: tardios.length > 1 ? 'critical' : 'warn',
    title: tardios.length === 1 ? 'Un corte de caja sigue sin revisar' : `${tardios.length} cortes de caja siguen sin revisar`,
    message: `Pasaron las ${HORA_LIMITE_REVISION}:00 del día siguiente y nadie los autorizó ni observó: ${lista}. `
      + 'Si la supervisora no está, revisa la suplente.',
  };
}
