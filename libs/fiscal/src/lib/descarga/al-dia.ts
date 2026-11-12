/**
 * `[PGP.110c]` **Qué le pide la Suite al SAT cuando se pone al día sola.** Edgar, 2026-11-12: «debemos
 * automatizar ese proceso» y, sobre la frecuencia, «hagámoslo así»: una vez al día por rol, sin cron.
 *
 * ── Por qué una vez al día y no más (lo que el SAT limita, 2026-11-12) ───────────────────────────────
 * La Suite pide días completos (00:00–23:59, `sat-soap-nodecfdi.service.ts`). Dos solicitudes el mismo día
 * llevarían los mismos parámetros, y el SAT limita las repetidas (código 5002). Tampoco hay que pedir
 * mientras otra está en proceso: el servicio v1.5 se satura. El 27-oct el SAT tardó ~35 min en tener
 * listos los paquetes. Para los REP (días o semanas después del pago) y la DIOT (mensual) un día alcanza.
 *
 * ── Por qué se FRENA sola en vez de reintentar ───────────────────────────────────────────────────────
 * Cada paquete se puede bajar sólo 2 veces (código 5008). El 27-oct un defecto de la ingesta (`[PGP.110b]`)
 * hizo que el job reintentara la descarga hasta agotar ese cupo y se perdieron 16,195 de 16,845 CFDI. Si una
 * solicitud dejó días sin cubrir, pedir encima no los recupera: una persona tiene que mirarla. Mientras
 * tanto se DICE por qué está frenada (el resultado del job, `fiscal.jobs.result`), no se calla.
 *
 * Función pura: recibe las solicitudes previas de un RFC y un rol, y la fecha de hoy en México.
 */

/** Una solicitud previa, con sus fechas ya como día de México (`YYYY-MM-DD`). */
export interface SolicitudPrevia {
  estado: string;
  codigo_estado: string | null;
  fecha_ini: string;
  fecha_fin: string;
  /** Día de México en que se creó. */
  creada: string;
  packages_total: number | null;
  packages_done: number | null;
}

export type MotivoFreno = 'sin_base' | 'dias_sin_cubrir' | 'atorada';

export type DecisionAlDia =
  | { accion: 'pedir'; desde: string; hasta: string }
  | { accion: 'nada'; motivo: 'ya_pedida_hoy' | 'una_en_curso' | 'al_dia' }
  | { accion: 'frenada'; motivo: MotivoFreno; detalle: string };

/** Estados de una solicitud que el pipeline todavía mueve (`descarga-orchestrator.service.ts`). */
const EN_CURSO = new Set(['nueva', 'solicitada', 'en_proceso', 'terminada']);

/**
 * Más de esto en curso ya no es «el SAT tarda»: la verificación se rinde a los 120 sondeos, con esperas que
 * crecen hasta 30 min (~2.5 días). Una solicitud más vieja que eso y sin cerrar está atorada.
 */
export const DIAS_PARA_ATORADA = 3;

/** «No se encontró la información»: el rango no tenía CFDI. Cubre sus días igual que una que bajó todo. */
const SIN_INFORMACION = '5004';

/** Cubrió sus días: bajó todos sus paquetes, o el SAT dijo que en ese rango no había nada. */
export function cubrioSusDias(s: SolicitudPrevia): boolean {
  if (s.codigo_estado === SIN_INFORMACION) return true;
  return s.estado === 'descargada' && (s.packages_done ?? 0) >= (s.packages_total ?? 0);
}

const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function decidirAlDia(previas: readonly SolicitudPrevia[], hoy: string): DecisionAlDia {
  const enCurso = previas.filter((s) => EN_CURSO.has(s.estado));
  const atorada = enCurso.find((s) => diasEntre(s.creada, hoy) > DIAS_PARA_ATORADA);
  if (atorada) {
    return { accion: 'frenada', motivo: 'atorada', detalle: `la solicitud del ${atorada.creada} (${atorada.fecha_ini} a ${atorada.fecha_fin}) sigue «${atorada.estado}» después de ${DIAS_PARA_ATORADA} días` };
  }
  if (enCurso.length) return { accion: 'nada', motivo: 'una_en_curso' };
  if (previas.some((s) => s.creada === hoy)) return { accion: 'nada', motivo: 'ya_pedida_hoy' };

  const buenas = previas.filter(cubrioSusDias);
  if (!buenas.length) {
    return { accion: 'frenada', motivo: 'sin_base', detalle: 'ninguna descarga de este rol terminó completa: falta una completa, pedida a mano, para saber desde dónde seguir' };
  }
  // Hasta dónde está cubierto: el fin más tardío de una que cubrió sus días.
  const base = buenas.map((s) => s.fecha_fin).reduce((a, b) => (b > a ? b : a));
  // Una que falló y llega más allá de la base dejó días que nadie cubrió: pedir encima no los recupera.
  const hueco = previas.find((s) => !cubrioSusDias(s) && !EN_CURSO.has(s.estado) && s.fecha_fin > base);
  if (hueco) {
    return { accion: 'frenada', motivo: 'dias_sin_cubrir', detalle: `la solicitud del ${hueco.creada} (${hueco.fecha_ini} a ${hueco.fecha_fin}) quedó «${hueco.estado}» y lo cubierto llega al ${base}` };
  }
  if (base > hoy) return { accion: 'nada', motivo: 'al_dia' };
  // Desde el último día cubierto, INCLUSIVE: esa solicitud se hizo a media jornada y lo que se timbró después
  // todavía no está. Lo repetido no duplica: la ingesta fusiona por UUID.
  return { accion: 'pedir', desde: base, hasta: hoy };
}
