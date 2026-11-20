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
 * ── `[PGP.110e]` Se recupera SOLA de una descarga que falló (Edgar, 2026-11-13: «te dije que
 * automaticemos este proceso») ───────────────────────────────────────────────────────────────────────
 * Antes, una solicitud que dejaba días sin cubrir FRENABA todo hasta que una persona pidiera a mano. Pero
 * lo que se pierde es el PAQUETE (cada uno se baja sólo 2 veces, código 5008; el 27-oct un defecto de la
 * ingesta, `[PGP.110b]`, agotó ese cupo), no el derecho a pedir: una solicitud NUEVA trae paquetes nuevos.
 * Y una solicitud nueva nunca repite parámetros, porque termina hoy. Así que el hueco se cubre pidiendo
 * otra vez desde el último día cubierto; sin base, desde el 1-ene del año en curso. La ingesta fusiona por
 * UUID: lo que llegue repetido no se duplica.
 *
 * ── Lo que SÍ frena, porque pedir otra vez no lo arregla ─────────────────────────────────────────────
 * - **`rechazo_del_sat`**: la última solicitud la rechazó el SAT por la e.firma (300–305: hay que cargar
 *   otra) o por el tope de la consulta (5003: hay que partir el rango). Repetirla daría lo mismo.
 * - **`fallas_seguidas`**: `MAX_FALLAS_SEGUIDAS` solicitudes seguidas sin cubrir sus días. A una por día,
 *   son tres días de intentos; el cuarto ya no es «el SAT tuvo un mal día» y alguien tiene que mirarla.
 * - **`atorada`**: una solicitud en curso desde hace más de `DIAS_PARA_ATORADA` días.
 * El motivo queda en el resultado del job (`fiscal.jobs.result`) y en el log en `warn`; no se calla.
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

export type MotivoFreno = 'atorada' | 'rechazo_del_sat' | 'fallas_seguidas';

export type DecisionAlDia =
  /** `recupera`: por qué este rango es más largo que «desde ayer» — lo dice el log. */
  | { accion: 'pedir'; desde: string; hasta: string; recupera?: string }
  | { accion: 'nada'; motivo: 'ya_pedida_hoy' | 'una_en_curso' | 'al_dia' }
  | { accion: 'frenada'; motivo: MotivoFreno; detalle: string };

/** Estados de una solicitud que el pipeline todavía mueve (`descarga-orchestrator.service.ts`). */
const EN_CURSO = new Set(['nueva', 'solicitada', 'en_proceso', 'terminada']);

/**
 * Más de esto en curso ya no es «el SAT tarda»: la verificación se rinde a los 120 sondeos, con esperas que
 * crecen hasta 30 min (~2.5 días). Una solicitud más vieja que eso y sin cerrar está atorada.
 */
export const DIAS_PARA_ATORADA = 3;

/** Tres días seguidos sin cubrir (una solicitud por día): ya no es mala suerte. */
export const MAX_FALLAS_SEGUIDAS = 3;

/** «No se encontró la información»: el rango no tenía CFDI. Cubre sus días igual que una que bajó todo. */
const SIN_INFORMACION = '5004';

/**
 * Rechazos que una solicitud nueva repetiría: la e.firma (300–305) y el tope de la consulta (5003). Los demás
 * permanentes de `COD_PERMANENTES` no frenan aquí: 5002 y 5011 son de ESOS parámetros o de ese día, y la
 * solicitud de mañana termina en otro día; 5004 cubre sus días.
 */
const RECHAZO_QUE_SE_REPITE = new Set(['300', '301', '302', '303', '304', '305', '5003']);

/** Cubrió sus días: bajó todos sus paquetes, o el SAT dijo que en ese rango no había nada. */
export function cubrioSusDias(s: SolicitudPrevia): boolean {
  if (s.codigo_estado === SIN_INFORMACION) return true;
  return s.estado === 'descargada' && (s.packages_done ?? 0) >= (s.packages_total ?? 0);
}

const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * `[PGP.164]` **Hasta dónde está cubierto SIN huecos desde `inicio`.** Junta las solicitudes que cubrieron sus
 * días, de la que empieza antes a la que empieza después, mientras cada una arranque a más tardar donde
 * terminó la anterior (el día final cuenta: se pidió a media jornada y la siguiente lo vuelve a pedir).
 * Devuelve el primer día que ninguna cubrió y, si después hay otra cubierta, dónde empieza.
 *
 * El caso que lo pidió (prod, 2026-11-20): recibidas tenía buenas del 1-jul en adelante y la de ene–oct del
 * 27-oct en «error» (0 de 5 paquetes). La regla tomaba el fin más tardío (hoy) como «cubierto», y de enero a
 * junio no se volvió a pedir: llegaron 10–65 complementos de pago al mes contra ~250–340 desde julio.
 */
export function primerHueco(buenas: readonly SolicitudPrevia[], inicio: string): { desde: string; siguiente: string | null } {
  let cursor = inicio;
  const orden = [...buenas].sort((a, b) => (a.fecha_ini < b.fecha_ini ? -1 : a.fecha_ini > b.fecha_ini ? 1 : 0));
  for (const s of orden) {
    if (s.fecha_ini > cursor) return { desde: cursor, siguiente: s.fecha_ini };
    if (s.fecha_fin > cursor) cursor = s.fecha_fin;
  }
  return { desde: cursor, siguiente: null };
}

export function decidirAlDia(previas: readonly SolicitudPrevia[], hoy: string): DecisionAlDia {
  const enCurso = previas.filter((s) => EN_CURSO.has(s.estado));
  const atorada = enCurso.find((s) => diasEntre(s.creada, hoy) > DIAS_PARA_ATORADA);
  if (atorada) {
    return { accion: 'frenada', motivo: 'atorada', detalle: `la solicitud del ${atorada.creada} (${atorada.fecha_ini} a ${atorada.fecha_fin}) sigue «${atorada.estado}» después de ${DIAS_PARA_ATORADA} días` };
  }
  if (enCurso.length) return { accion: 'nada', motivo: 'una_en_curso' };
  if (previas.some((s) => s.creada === hoy)) return { accion: 'nada', motivo: 'ya_pedida_hoy' };

  const buenas = previas.filter(cubrioSusDias);
  // Hasta dónde está cubierto: el fin más tardío de una que cubrió sus días.
  const base = buenas.length ? buenas.map((s) => s.fecha_fin).reduce((a, b) => (b > a ? b : a)) : null;
  // Las que fallaron DESPUÉS de la última buena (por día de creación), de la más nueva a la más vieja.
  const ultimaBuena = buenas.length ? buenas.map((s) => s.creada).reduce((a, b) => (b > a ? b : a)) : '';
  const fallasSeguidas = previas.filter((s) => !cubrioSusDias(s) && s.creada > ultimaBuena)
    .sort((a, b) => (a.creada < b.creada ? 1 : -1));

  const ultima = fallasSeguidas[0];
  if (ultima && ultima.codigo_estado && RECHAZO_QUE_SE_REPITE.has(ultima.codigo_estado)) {
    return { accion: 'frenada', motivo: 'rechazo_del_sat', detalle: `el SAT rechazó la solicitud del ${ultima.creada} (${ultima.fecha_ini} a ${ultima.fecha_fin}) con el código ${ultima.codigo_estado}: pedir otra vez daría lo mismo` };
  }
  if (fallasSeguidas.length >= MAX_FALLAS_SEGUIDAS) {
    return { accion: 'frenada', motivo: 'fallas_seguidas', detalle: `${fallasSeguidas.length} solicitudes seguidas sin cubrir sus días (la última, del ${ultima.creada}, quedó «${ultima.estado}»)` };
  }

  if (!base) {
    // Sin ninguna completa: desde el 1-ene del año en curso (lo que piden los REP y la DIOT del año).
    return { accion: 'pedir', desde: `${hoy.slice(0, 4)}-01-01`, hasta: hoy, recupera: 'ninguna descarga de este rol terminó completa' };
  }
  if (base > hoy) return { accion: 'nada', motivo: 'al_dia' };
  // [PGP.164] Un hueco ANTES de lo último cubierto (desde el 1-ene del año): se pide desde ahí hasta hoy.
  // Termina hoy, así que no repite los parámetros de ninguna anterior (código 5002); lo ya bajado se fusiona por UUID.
  const h = primerHueco(buenas, `${hoy.slice(0, 4)}-01-01`);
  if (h.siguiente && h.desde < base) {
    return { accion: 'pedir', desde: h.desde, hasta: hoy, recupera: `del ${h.desde} al ${h.siguiente} ninguna descarga de este rol terminó completa` };
  }
  // Desde el último día cubierto, INCLUSIVE: esa solicitud se hizo a media jornada y lo que se timbró después
  // todavía no está. Lo repetido no duplica: la ingesta fusiona por UUID.
  const hueco = previas.find((s) => !cubrioSusDias(s) && s.fecha_fin > base);
  return hueco
    ? { accion: 'pedir', desde: base, hasta: hoy, recupera: `la solicitud del ${hueco.creada} (${hueco.fecha_ini} a ${hueco.fecha_fin}) quedó «${hueco.estado}» sin cubrir sus días` }
    : { accion: 'pedir', desde: base, hasta: hoy };
}
