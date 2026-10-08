/**
 * `[MS.7.6]` Acceso por cola. Funciones puras. `FASE_MS7_MANTENIMIENTO.md` (M1, M11).
 *
 *     poder efectivo sobre un ticket  =  capacidad (clave SERVICIO_*)  ∩  pertenencia a SU cola (`queue_members`)
 *
 * · `atiende`  — colas donde la persona tiene la capacidad de atender (`esAgente`) Y es miembro (cualquier rol).
 * · `coordina` — colas donde tiene la capacidad de repartir (`esCoordinador`) Y es miembro con rol `coordinador`.
 * · `todas`    — el god-mode (se resuelve por NOMBRE de rol, ADR-054): ve y puede todo. Es la única excepción.
 *
 * Quien tiene la clave pero ninguna membresía NO ve ningún ticket de nadie: la clave sola ya no abre la bandeja
 * (es el cambio de fondo). Y quien es miembro pero no tiene la clave tampoco puede nada: la pertenencia sola no basta.
 *
 * `accesoATicket` ya nace con el hueco de la confidencialidad (Fase MSH): `completo | basico | ninguno`.
 * Hoy ningún ticket es confidencial (la columna llega con MSH.1), así que `basico` sólo existe aquí, probado y
 * sin uso: reescribir esta función dos veces —una por Mantenimiento y otra por RH— sería peor que una.
 */

export interface AccesoColas {
  /** God-mode: todas las colas. */
  todas: boolean;
  atiende: ReadonlySet<string>;
  coordina: ReadonlySet<string>;
}

export const SIN_COLAS: AccesoColas = Object.freeze({ todas: false, atiende: new Set<string>(), coordina: new Set<string>() });
export const TODAS_LAS_COLAS: AccesoColas = Object.freeze({ todas: true, atiende: new Set<string>(), coordina: new Set<string>() });

export interface Membresia {
  queue_id: string;
  role: 'coordinador' | 'tecnico';
}

export function construirAcceso(e: { god: boolean; esAgente: boolean; esCoordinador: boolean; membresias: readonly Membresia[] }): AccesoColas {
  if (e.god) return TODAS_LAS_COLAS;
  const atiende = new Set<string>();
  const coordina = new Set<string>();
  for (const m of e.membresias) {
    if (e.esAgente) atiende.add(m.queue_id);
    if (e.esCoordinador && m.role === 'coordinador') coordina.add(m.queue_id);
  }
  return { todas: false, atiende, coordina };
}

export const puedeAtenderCola = (a: AccesoColas, queueId: string): boolean => a.todas || a.atiende.has(queueId);
export const puedeCoordinarCola = (a: AccesoColas, queueId: string): boolean => a.todas || a.coordina.has(queueId);

/**
 * Las colas a las que se acota una lectura de quien atiende. `null` = no acotar (god-mode). Un arreglo vacío
 * significa «ninguna»: la consulta debe devolver vacío, NO todo (`whereIn` con `[]` se lee como falso).
 */
export function colasDeLectura(a: AccesoColas, que: 'atiende' | 'coordina' = 'atiende'): string[] | null {
  if (a.todas) return null;
  return [...(que === 'atiende' ? a.atiende : a.coordina)];
}

/**
 * `[MSH.2]` H1 — ¿quién ADMINISTRA una cola (sus miembros, categorías, campos, ajustes)? Una cola NORMAL la administra su coordinación o el
 * god-mode (como siempre). Una cola CONFIDENCIAL **sólo su coordinación**: el god-mode NO, porque podría agregarse a sí mismo como miembro y
 * leerlo todo (hallazgo H1 del plan). La excepción de ver el contenido ya no existe para el administrador; tampoco la de editar quién lo ve.
 */
export function puedeAdministrarCola(a: AccesoColas, queueId: string, confidencial: boolean): boolean {
  return confidencial ? a.coordina.has(queueId) : puedeCoordinarCola(a, queueId);
}

export type AccesoTicket = 'completo' | 'basico' | 'ninguno';

/**
 * Qué puede ver `ctx` de un ticket.
 *  · El solicitante ve SU ticket completo, siempre (aun confidencial).
 *  · No confidencial: quien atiende esa cola lo ve completo; el resto, nada.
 *  · Confidencial: sólo los miembros que atienden esa cola lo ven completo; el god-mode ve lo BÁSICO (que existe y
 *    cómo va), nunca el contenido; el resto, nada.
 */
export function accesoATicket(
  ctx: { userId: string; colas: AccesoColas },
  t: { requester_id: string; queue_id: string; confidential?: boolean },
): AccesoTicket {
  if (t.requester_id === ctx.userId) return 'completo';
  if (t.confidential === true) {
    if (ctx.colas.atiende.has(t.queue_id)) return 'completo';
    return ctx.colas.todas ? 'basico' : 'ninguno';
  }
  return puedeAtenderCola(ctx.colas, t.queue_id) ? 'completo' : 'ninguno';
}
