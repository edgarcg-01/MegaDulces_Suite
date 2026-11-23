import type { Knex } from 'knex';

/**
 * `[RE.86]` La factura COMPARTIDA: una liga de `fiscal.cfdi_assignments` con `shared_reason` (el motivo) liga una
 * entrada a una factura que ya citan otras entradas del mismo proveedor. Una sola definición para el servicio que
 * la crea, el expediente que la compara en grupo y la lista que deja de pedirle papel.
 */

/** El mínimo del motivo: el mismo que el CHECK de la migración `20261123165526`. */
export const MOTIVO_LIGA_MIN = 10;

/** ¿Ya está la columna `shared_reason`? El código puede llegar a prod antes que la migración. */
export async function hayLigaCompartida(trx: Knex | Knex.Transaction): Promise<boolean> {
  const r = await trx.raw(`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('fiscal.cfdi_assignments')
    AND attname = 'shared_reason' AND NOT attisdropped) AS ok`);
  return !!(r.rows[0] as { ok: boolean }).ok;
}

/**
 * Condición SQL «la entrada `c` tiene una factura compartida ligada»: cuenta como papel (su documento ES la
 * factura original). Sin la migración, `false` — la lista se comporta como antes.
 */
export const tieneLigaCompartidaSql = (hay: boolean, alias = 'c'): string => (hay
  ? `EXISTS (SELECT 1 FROM fiscal.cfdi_assignments fa WHERE fa.tenant_id = ${alias}.tenant_id AND fa.sucursal = ${alias}.sucursal
       AND fa.doc_folio = ${alias}.folio AND fa.status = 'confirmed' AND fa.shared_reason IS NOT NULL)`
  : 'false');
