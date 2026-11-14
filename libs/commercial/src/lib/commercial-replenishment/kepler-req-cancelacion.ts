/**
 * `[KR.7]` — **Cancelar una requisición de compra (`X-A-30`) en Kepler igual que la cancela Kepler.**
 *
 * Anexo: [`FASE_PQ_ANEXO_MENU_COMPRAS_KEPLER.md` §3e](../../../../../docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_MENU_COMPRAS_KEPLER.md).
 * Hermano de `kepler-oc-cancelacion.ts` (`[PQ.110]`): misma llave, mismas tablas, mismos permisos.
 * Sin base de datos a propósito: la REGLA y las SENTENCIAS se prueban solas en `kepler-req-cancelacion.spec.ts`.
 *
 * ── Lo medido (2026-11-14, `pg-prod` + respaldos nocturnos de `md` del 5 y del 6 de noviembre) ──────
 *
 *  · **La regla de Kepler:** de las 100 requisiciones canceladas en toda la historia, NINGUNA tiene una OC
 *    viva que la referencie (64 sólo OC canceladas, 36 nunca tuvieron OC); de las 5,477 terminadas, 5,476
 *    sí la tienen. Es lo que Kepler llama «documento referenciado» (`FASE_KR` §6).
 *  · **Lo que escribe**, testigo completo (CEDIS `0003143`, escrita por la Suite, cancelada a mano por `07`
 *    el 6-nov, después de que `42YAGL` cancelara su OC `0007296`): cabecera `c43` → C · `c14`, `c15`, `c16`
 *    → 0 · `c42` en 0 · `c67` → quien cancela · `c68`/`c69` → fecha y hora de la cancelación; renglones
 *    (`kdm2`) borrados (33 → 0). Las 22 canceladas a mano en 90 días: `c42` = 0 y sin renglones, todas.
 *
 * ── Lo que esto se niega a hacer (fail-closed) ──────────────────────────────────────────────────────
 *
 *  · Requisición con una **OC viva**: primero se cancela la OC (`[PQ.110]`), que la reabre.
 *  · Requisición que no está en `N` (nueva) o `A` (pendiente, o reabierta por su OC cancelada): una `F` o
 *    `R` sin OC viva casi no existe (1 en la historia) y no se vio cómo la cancela Kepler.
 */

import { llave, TABLAS_KEPLER, type Sentencia, type Tablas } from './kepler-oc-cancelacion';

/** Lo que el adaptador lee de Kepler vivo, ya plano. */
export interface RequisicionACancelar {
  /** `kdm1.c5`: la serie. La llave es `(c1, c2, c3, c4, c5, c6)`. */
  serie: string;
  folio: string;
  /** `c43`. */
  estado: string;
  /** `c16`. */
  total: number;
  /** Capturista, fecha y hora ORIGINALES (`c67`/`c68`/`c69`): Kepler los sobrescribe al cancelar. */
  capturista: string;
  fecha_captura: string;
  hora_captura: string;
  /** Renglones en `kdm2`. */
  renglones: number;
}

export interface EntradaCancelacionRequisicion {
  requisicion: RequisicionACancelar | null;
  /** Coincidencias por sucursal + folio (más de una = series distintas con el mismo folio). */
  coincidencias: number;
  /** Folios de las OC (`X-A-35`, `c37 = 30`, `c39` = folio) que la referencian y no están canceladas. */
  oc_vivas: string[];
}

export type DecisionRequisicion = { ok: true } | { ok: false; motivo: string };

/** Palabras del estado de una requisición (`c43`), para que el rechazo se entienda sin el ERP. */
const ESTADO_RQ: Record<string, string> = {
  N: 'nueva', A: 'pendiente', R: 'convertida en parte', F: 'convertida en orden de compra', C: 'cancelada',
};

/** Los estados en que se cancela: los observados. */
export const ESTADOS_CANCELABLES: readonly string[] = ['N', 'A'];

/** ¿Se puede cancelar? La regla de Kepler (sin OC viva) y sólo los estados observados. */
export function decidirCancelacionRequisicion(e: EntradaCancelacionRequisicion): DecisionRequisicion {
  if (e.coincidencias === 0 || !e.requisicion) return { ok: false, motivo: 'Kepler no tiene esa requisición en esa sucursal' };
  if (e.coincidencias > 1) {
    return { ok: false, motivo: `Kepler tiene ${e.coincidencias} requisiciones con ese folio en la sucursal (series distintas): no se sabe cuál cancelar` };
  }
  const rq = e.requisicion;
  if (rq.estado === 'C') return { ok: false, motivo: 'La requisición ya está cancelada en Kepler' };
  // La regla de Kepler va ANTES que el estado: es la que la persona puede resolver (cancelando la OC).
  if (e.oc_vivas.length) {
    return {
      ok: false,
      motivo: `Tiene viva la orden de compra ${e.oc_vivas.slice(0, 3).join(', ')}: primero se cancela la OC (Kepler no cancela una requisición con OC viva)`,
    };
  }
  if (!ESTADOS_CANCELABLES.includes(rq.estado)) {
    const como = ESTADO_RQ[rq.estado] ?? `en estado ${rq.estado}`;
    return { ok: false, motivo: `La requisición está ${como} y sin OC viva: no se ha visto cómo la cancela Kepler en ese caso` };
  }
  return { ok: true };
}

/** Lo que se va a escribir. `estado` es el que se LEYÓ: va en el `WHERE` como candado. */
export interface PlanCancelacionRequisicion {
  sucursal: string;
  requisicion: { serie: string; folio: string; estado: string; renglones: number };
  /** `c67`: quién cancela, como Kepler lo escribe. */
  capturista: string;
  /** `c68` (`YYYY-MM-DD`) y `c69` (`HH:MM`), hora de México. */
  fecha: string;
  hora: string;
}

/**
 * Las sentencias, en orden. La cabecera repite en el `WHERE` el estado leído y que no haya OC viva: si
 * alguien la convirtió o la tocó en Kepler entre la lectura y la escritura, afecta 0 filas y todo se
 * deshace en vez de pisar su cambio.
 */
export function sentenciasCancelacionRequisicion(p: PlanCancelacionRequisicion, t: Tablas = TABLAS_KEPLER): Sentencia[] {
  if (!ESTADOS_CANCELABLES.includes(p.requisicion.estado)) {
    throw new Error(`[KR.7] estado ${p.requisicion.estado} no cancelable: la regla debió rechazarla antes`);
  }
  const rq = [p.sucursal, p.requisicion.serie, p.requisicion.folio];
  return [
    {
      que: 'cabecera de la requisición',
      sql: `UPDATE ${t.kdm1} SET c43 = 'C', c13 = 0, c14 = 0, c15 = 0, c16 = 0, c42 = 0, c67 = $5, c68 = $6, c69 = $7
             WHERE ${llave('30', 1)} AND btrim(c43) = $4
               AND NOT EXISTS (SELECT 1 FROM ${t.kdm1} o
                                WHERE btrim(o.c1) = $1 AND o.c2 = 'X' AND o.c3 = 'A' AND btrim(o.c4::text) = '35'
                                  AND btrim(o.c37::text) = '30' AND btrim(o.c39) = $3 AND btrim(o.c43) <> 'C')`,
      params: [...rq, p.requisicion.estado, p.capturista, p.fecha, p.hora],
      esperadas: 1,
    },
    {
      que: 'renglones de la requisición',
      sql: `DELETE FROM ${t.kdm2} WHERE ${llave('30', 1)}`,
      params: rq,
      esperadas: p.requisicion.renglones,
    },
  ];
}
