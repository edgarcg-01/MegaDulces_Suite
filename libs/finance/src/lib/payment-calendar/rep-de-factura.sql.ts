import type { Knex } from 'knex';
import type { RepDeFactura } from '@megadulces/contracts/finance/momento-poliza';

/**
 * `[PGP.109]` **Los REP de unas facturas, y hasta cuándo sabe la réplica.** Lee
 * `analytics.v_rep_de_factura` (`[PGP.110]`, vista sobre `contpaqi_ods`); la búsqueda por
 * `factura_uuid` usa el índice `upper(iddocumento)` de la réplica.
 *
 * `sincronizado_hasta` es la última copia de la réplica (`_synced_at`): si el pago salió DESPUÉS, que no
 * haya REP no prueba nada y la póliza se declara «sin medir» (la réplica está detenida desde el
 * 2026-10-30). Sin la vista (dev, CI) no se mide nada: `null`.
 */
export async function leerRepsDeFacturas(trx: Knex | Knex.Transaction, uuids: readonly string[]): Promise<{ reps: RepDeFactura[]; sincronizado_hasta: string | null }> {
  const { rows: [hay] } = await trx.raw(`SELECT to_regclass('analytics.v_rep_de_factura') IS NOT NULL AS vista, to_regclass('contpaqi_ods.add_pagos_doc_rel') IS NOT NULL AS replica`);
  if (!hay.vista || !hay.replica) return { reps: [], sincronizado_hasta: null };
  const { rows: [s] } = await trx.raw(`SELECT to_char(max(_synced_at) AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS hasta FROM contpaqi_ods.add_pagos_doc_rel`);
  const lista = [...new Set(uuids.map((u) => u.toUpperCase()))];
  if (!lista.length) return { reps: [], sincronizado_hasta: s?.hasta ?? null };
  const reps = ((await trx.raw(`
    SELECT factura_uuid, rep_uuid, pagado::float8 AS pagado, to_char(fecha_pago, 'YYYY-MM-DD') AS fecha_pago, (cancelado_en IS NOT NULL) AS cancelado
      FROM analytics.v_rep_de_factura WHERE factura_uuid = ANY(?::text[])`, [lista])).rows as RepDeFactura[])
    .map((r) => ({ ...r, pagado: Number(r.pagado) }));
  return { reps, sincronizado_hasta: s?.hasta ?? null };
}
