import type { Knex } from 'knex';

/**
 * `[KR.7]` Dónde está una requisición de compra (`X-A-30`) en Kepler, leído de la RÉPLICA
 * (`kepler_ods.kdm1`), junto con las órdenes de compra (`X-A-35`) que la referencian por la liga de
 * Kepler (`c37 = 30`, `c39` = folio de la requisición, misma sucursal).
 *
 * Por qué existe (anexo K §3e, medido el 2026-11-14):
 * - Una persona puede cancelar la OC, o la requisición, A MANO en Kepler, y la Suite no se entera:
 *   21 requisiciones de la Suite estaban reabiertas en Kepler (su OC se canceló a mano) y la Suite las
 *   seguía dando por «ordered». La ficha tiene que decir lo que pasó allá, no lo que la Suite cree.
 * - Es la entrada de la regla de KR.7: Kepler sólo cancela una requisición que ya no tiene OC viva
 *   (100 de 100 canceladas en la historia).
 *
 * ⚠️ Al cancelar, Kepler SOBRESCRIBE `c67` (capturista) con quien cancela y `c68`/`c69` con la fecha y
 * hora de la cancelación (§3c, §3e). Por eso `cancelada` sólo se llena en estado C: en los demás estados
 * esas columnas son la captura, no un acto.
 *
 * Mismas llaves y la misma forma que `OcCancelacionService.leerReplica` (en la réplica `c4` y `c37` son
 * `numeric`). Medido en prod: 4 ms la requisición, 2 ms sus OC.
 */
export interface DocKeplerReplica {
  folio: string;
  /** `c43`: N nueva · A pendiente · R parcial · F terminada · C cancelada. */
  estado: string;
  /** Sólo en estado C: quién la canceló y cuándo (`AAAA-MM-DD HH:MM`, hora de Kepler). */
  cancelada: { por: string | null; en: string } | null;
}

export interface RequisicionEnReplica {
  /** `null` = el folio no está en la réplica (recién escrito, o la liga está mal). */
  requisicion: DocKeplerReplica | null;
  ocs: DocKeplerReplica[];
}

const COLS = `btrim(c6) AS folio, btrim(c43) AS estado, nullif(btrim(c67), '') AS por,
              to_char(c68, 'YYYY-MM-DD') AS fecha, nullif(btrim(c69), '') AS hora`;

/** `null` = la base no tiene la réplica de Kepler: no se pudo leer (nunca «no pasó nada»). */
export async function leerRequisicionEnReplica(
  trx: Knex | Knex.Transaction, sucursal: string, folio: string,
): Promise<RequisicionEnReplica | null> {
  if (!(await trx.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0]?.t) return null;
  const rq = (await trx.raw(
    `SELECT ${COLS} FROM kepler_ods.kdm1
      WHERE btrim(c1) = ? AND c2 = 'X' AND c3 = 'A' AND c4::numeric = 30 AND btrim(c6) = ? LIMIT 1`,
    [sucursal, folio])).rows[0] as FilaDoc | undefined;
  const ocs = (await trx.raw(
    `SELECT ${COLS} FROM kepler_ods.kdm1
      WHERE btrim(c1) = ? AND c2 = 'X' AND c3 = 'A' AND c4::numeric = 35 AND c37::numeric = 30 AND btrim(c39) = ?
      ORDER BY btrim(c6)`,
    [sucursal, folio])).rows as FilaDoc[];
  return { requisicion: rq ? aDoc(rq) : null, ocs: ocs.map(aDoc) };
}

interface FilaDoc { folio: string; estado: string | null; por: string | null; fecha: string | null; hora: string | null }

export function aDoc(r: FilaDoc): DocKeplerReplica {
  const estado = String(r.estado ?? '').trim();
  return {
    folio: String(r.folio),
    estado,
    cancelada: estado === 'C' ? { por: r.por ?? null, en: [r.fecha, r.hora].filter(Boolean).join(' ') } : null,
  };
}
