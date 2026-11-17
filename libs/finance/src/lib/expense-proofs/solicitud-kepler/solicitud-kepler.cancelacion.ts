/**
 * `[PGP.122]` F3 (anexo S §17, DS40 firmada por Edgar el 2026-11-17) — **Cancelar desde la Suite una solicitud de gasto
 * (`X-A-15`) que la Suite escribió en Kepler, igual que la cancela Kepler.** Hermano de `[KR.7]`
 * (`libs/commercial/.../kepler-req-cancelacion.ts`): la REGLA y la SENTENCIA son puras y se prueban solas.
 *
 * ── Lo medido (ODS, sólo lectura, 2026-11-17: las 156 X-A-15 canceladas en Kepler desde el 1-oct) ─────────────
 *  · Cabecera: `c43` → C · `c14` (IVA), `c16` (total) y `c42` (saldo) → 0 en las 156 · `c67` → quien cancela
 *    (Tesorería, sobre todo) · `c68`/`c69` → fecha y hora de la cancelación. `c13` y `c15` ya van en 0 en TODAS
 *    (vivas y canceladas): no se tocan.
 *  · Renglones (`kdm6`): se CONSERVAN con su importe (364 de 364). A diferencia de la requisición, no se borran.
 *  · El contador (`sqliov`) no se mueve.
 *  · El gasto X-A-10 apunta a su solicitud por `c37 = 15`, `c38 = 1`, `c39 = folio` (2,066 de 2,066).
 *  · Permisos: `kepler_push` ya tiene `UPDATE` de `c14`, `c16`, `c42`, `c43`, `c67`–`c69` en los 9 servidores
 *    (`[PQ.110]`, verificado el 2026-11-17). No hay GRANT nuevo.
 *
 * ── Lo que se niega a hacer (fail-closed) ─────────────────────────────────────────────────────────────────────────
 *  · Con un gasto X-A-10 vivo (DS40): ése se cancela en Kepler, como hoy.
 *  · Una solicitud que no lleva la marca de ESTE vale: no se cancela un documento ajeno aunque tenga el folio.
 *  · Una que no está en A ni en N (F = ejecutada): no se vio cómo la cancela Kepler.
 */

/** Una sentencia con las filas que debe tocar: si toca otras, se deshace todo. */
export interface SentenciaKepler {
  que: string;
  sql: string;
  params: unknown[];
  esperadas: number;
}

/** Lo que se lee del Kepler vivo, con candado, antes de decidir. */
export interface EntradaCancelacionSolicitud {
  /** Cuántas X-A-15 hay con ese folio en la sucursal (más de una = series distintas). */
  coincidencias: number;
  solicitud: { folio: string; estado: string; marca: string } | null;
  /** La marca del vale (`kepler_request_mark`): tiene que ser la del documento. */
  marcaDelVale: string;
  /** Folios de los X-A-10 no cancelados que apuntan a esta solicitud. */
  gastosVivos: string[];
}

export type DecisionCancelacionSolicitud = { ok: true } | { ok: false; motivo: string; yaCancelada?: boolean };

/** Los estados en que Kepler la cancela, los observados (de las 156 canceladas desde el 1-oct). */
export const ESTADOS_SOLICITUD_CANCELABLES: readonly string[] = ['A', 'N'];

const ESTADO: Record<string, string> = { N: 'nueva', A: 'autorizada', F: 'ejecutada (ya tiene gasto aplicado)', C: 'cancelada' };

/** ¿Se puede cancelar desde la Suite? */
export function decidirCancelacionSolicitud(e: EntradaCancelacionSolicitud): DecisionCancelacionSolicitud {
  if (!e.solicitud || e.coincidencias === 0) return { ok: false, motivo: 'Kepler no tiene esa solicitud en esa sucursal' };
  if (e.coincidencias > 1) return { ok: false, motivo: `Kepler tiene ${e.coincidencias} solicitudes con ese folio en la sucursal: no se sabe cuál cancelar` };
  const marca = String(e.marcaDelVale ?? '').trim();
  if (!marca || e.solicitud.marca.trim() !== marca) {
    return { ok: false, motivo: `La solicitud ${e.solicitud.folio} de Kepler no lleva la marca de este vale (${marca || 'sin marca'}): no se cancela un documento ajeno` };
  }
  if (e.solicitud.estado === 'C') return { ok: false, motivo: `La solicitud ${e.solicitud.folio} ya está cancelada en Kepler`, yaCancelada: true };
  // DS40 va antes que el estado: es lo que la persona puede resolver (cancelando el gasto en Kepler).
  if (e.gastosVivos.length) {
    return { ok: false, motivo: `Ya tiene el gasto ${e.gastosVivos.slice(0, 3).join(', ')} en Kepler: se cancela allá, como hoy (DS40)` };
  }
  if (!ESTADOS_SOLICITUD_CANCELABLES.includes(e.solicitud.estado)) {
    return { ok: false, motivo: `La solicitud está ${ESTADO[e.solicitud.estado] ?? `en estado ${e.solicitud.estado}`}: no se ha visto cómo la cancela Kepler en ese caso` };
  }
  return { ok: true };
}

/** Lo que se va a escribir. `estado` y `marca` son los LEÍDOS: van en el `WHERE` como candado. */
export interface PlanCancelacionSolicitud {
  sucursal: string;
  folio: string;
  estado: string;
  marca: string;
  /** `c67`: quién cancela, como lo escribe la Suite (`CAPTURISTA_SUITE`). */
  capturista: string;
  /** `c68` (`YYYY-MM-DD`) y `c69` (`HH:MM`), hora de México. */
  fecha: string;
  hora: string;
}

/**
 * La sentencia. Repite en el `WHERE` el estado y la marca leídos y que no haya gasto vivo: si alguien la aplicó o la
 * tocó en Kepler entre la lectura y la escritura, afecta 0 filas y todo se deshace en vez de pisar su cambio.
 */
export function sentenciasCancelacionSolicitud(p: PlanCancelacionSolicitud): SentenciaKepler[] {
  if (!ESTADOS_SOLICITUD_CANCELABLES.includes(p.estado)) {
    throw new Error(`[PGP.122] estado ${p.estado} no cancelable: la regla debió rechazarla antes`);
  }
  return [{
    que: 'cabecera de la solicitud',
    sql: `UPDATE md.kdm1 SET c43 = 'C', c14 = 0, c16 = 0, c42 = 0, c67 = $5, c68 = $6, c69 = $7
           WHERE c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND btrim(c6) = $2
             AND btrim(c43) = $3 AND btrim(c26) = $4
             AND NOT EXISTS (SELECT 1 FROM md.kdm1 g
                              WHERE g.c1 = $1 AND g.c2 = 'X' AND g.c3 = 'A' AND g.c4 = 10 AND g.c5 = 1
                                AND btrim(g.c37::text) = '15' AND btrim(g.c39) = $2 AND btrim(g.c43) <> 'C')`,
    params: [p.sucursal, p.folio, p.estado, p.marca, p.capturista, p.fecha, p.hora],
    esperadas: 1,
  }];
}

/** El motivo que queda en el vale (`motivo_rechazo`): un inicio fijo separa este cierre de un rechazo de quien firma. */
export const SOLICITUD_CANCELADA_DESDE_LA_SUITE = 'Cancelada en Kepler desde la Suite';
/** Un motivo de menos de esto no explica nada a quien lo lea después. */
export const SOLICITUD_CANCELAR_MOTIVO_MIN = 10;
