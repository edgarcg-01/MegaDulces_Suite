/**
 * Fase RH · frente NE · `[NE.0.4]` — EL PERIODO DE NÓMINA COMO LLAVE.
 *
 * Cierra el patrón B1 de `FASE_RH_FRENTE_NE_DISENO.md`: «la llave de periodo escrita a mano, en
 * texto libre». En el sistema que vamos a reemplazar, el periodo se nombra de tres formas y ninguna
 * sirve como llave:
 *
 *  · En el ERP vive en una glosa escrita a mano: **555 escrituras distintas** en el centro de
 *    nómina. Reconciliar por ella falla (`VERDAD_ABSOLUTA.md` §40.3).
 *  · En el sistema de nómina hay un «número de semana» que **no es una semana**: va de 23 a 726 con
 *    504 valores distintos en un solo año, y 335 de esos números apuntan a más de una fecha. Es un
 *    **consecutivo por centro** — 44 centros, cada uno con su contador.
 *  · La **fecha de pago es viernes en los 1,088 casos de 2026**. Es el único dato consistente.
 *
 * → **La llave es la fecha de pago.** El consecutivo del centro entra como alias
 *   (`hr.person_aliases` guarda los de persona; el del periodo, en `notes`), nunca como llave.
 *
 * ⛔ **Qué días cubre un periodo NO está registrado en ninguna parte** — ni en el recibo ni en el
 * consecutivo, que sólo dice «7 días». Por eso este módulo **no tiene** una función que, dada una
 * fecha, diga a qué periodo pertenece: inventarla sería adivinar. El rango se DECLARA (ADR-056) o
 * se dice que no se sabe, y quien lo declare es RH.
 */

/** Fecha civil `YYYY-MM-DD`. Sin hora y sin zona: un periodo es un día del calendario, no un instante. */
export type FechaCivil = string;

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const VIERNES = 5; // ISO: lunes = 1 … domingo = 7

/** Qué días cubre el periodo. O se sabe entero, o no se sabe: medio rango es peor que ninguno. */
export type RangoDelPeriodo =
  | { readonly declarado: true; readonly iniciaEl: FechaCivil; readonly terminaEl: FechaCivil; readonly dias: number }
  | { readonly declarado: false };

export interface PeriodoDeNomina {
  /** La llave. Siempre un viernes. */
  readonly pagadoEl: FechaCivil;
  readonly rango: RangoDelPeriodo;
}

export class PeriodoInvalido extends Error {}

function aUTC(fecha: FechaCivil): number {
  if (!RE_FECHA.test(fecha)) throw new PeriodoInvalido(`fecha no es YYYY-MM-DD: ${JSON.stringify(fecha)}`);
  const [a, m, d] = fecha.split('-').map(Number);
  const t = Date.UTC(a, m - 1, d);
  const v = new Date(t);
  // Rechaza 2026-02-31 y compañía: el Date se corre solo y el bug aparece semanas después.
  if (v.getUTCFullYear() !== a || v.getUTCMonth() !== m - 1 || v.getUTCDate() !== d) {
    throw new PeriodoInvalido(`fecha inexistente: ${fecha}`);
  }
  return t;
}

/** Día ISO de la semana: lunes = 1 … domingo = 7. */
export function diaIso(fecha: FechaCivil): number {
  return new Date(aUTC(fecha)).getUTCDay() || 7;
}

/** Medido: la fecha de pago de la nómina es viernes en 1,088 de 1,088 casos de 2026. */
export function esViernes(fecha: FechaCivil): boolean {
  return diaIso(fecha) === VIERNES;
}

/** Días entre dos fechas civiles, inclusive en ambos extremos. */
export function diasInclusive(iniciaEl: FechaCivil, terminaEl: FechaCivil): number {
  return Math.round((aUTC(terminaEl) - aUTC(iniciaEl)) / 86_400_000) + 1;
}

/** El rango que RH declara. `dias` se calcula, no se recibe: no puede contradecir a las fechas. */
export function rangoDeclarado(iniciaEl: FechaCivil, terminaEl: FechaCivil): RangoDelPeriodo {
  const dias = diasInclusive(iniciaEl, terminaEl);
  if (dias < 1) throw new PeriodoInvalido(`el periodo termina antes de empezar: ${iniciaEl} → ${terminaEl}`);
  return { declarado: true, iniciaEl, terminaEl, dias };
}

/** Lo honesto mientras nadie lo haya declarado. NO es «cero días» ni «la semana anterior». */
export function rangoDesconocido(): RangoDelPeriodo {
  return { declarado: false };
}

/**
 * Construye un periodo. Rechaza lo que el CHECK de `hr.payroll_periods` también rechaza, para que
 * el error salga en la capa de dominio y no como un 23514 desde la base.
 */
export function nuevoPeriodo(pagadoEl: FechaCivil, rango: RangoDelPeriodo = rangoDesconocido()): PeriodoDeNomina {
  if (!esViernes(pagadoEl)) {
    throw new PeriodoInvalido(`la nómina se paga en viernes; ${pagadoEl} es ${NOMBRE_DIA[diaIso(pagadoEl)]}`);
  }
  return { pagadoEl, rango };
}

/** La llave del periodo. Existe como función para que nadie use el consecutivo del centro por error. */
export function llaveDePeriodo(p: PeriodoDeNomina): FechaCivil {
  return p.pagadoEl;
}

export function mismoPeriodo(a: PeriodoDeNomina, b: PeriodoDeNomina): boolean {
  return a.pagadoEl === b.pagadoEl;
}

const NOMBRE_DIA: Record<number, string> = {
  1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes', 6: 'sábado', 7: 'domingo',
};
const MES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * Cómo se nombra el periodo para una persona. Si el rango no está declarado **lo dice**: una
 * pantalla que calla lo que no sabe es la que produjo estos catorce patrones.
 */
export function describePeriodo(p: PeriodoDeNomina): string {
  const [a, m, d] = p.pagadoEl.split('-').map(Number);
  const cabeza = `Nómina pagada el viernes ${d} de ${MES[m - 1]} de ${a}`;
  if (!p.rango.declarado) return `${cabeza} · días que cubre: sin declarar`;
  return `${cabeza} · cubre ${p.rango.dias} día(s), del ${p.rango.iniciaEl} al ${p.rango.terminaEl}`;
}
