import type { Knex } from 'knex';
import type { AutorizacionNorma, ReglaNorma } from '@megadulces/contracts/finance/norma-fiscal-cfdi';

/**
 * `[PGP.224]` **Las decisiones vivas de Administración o Contabilidad sobre estos CFDI**, una por regla
 * (`finance.cfdi_norm_authorizations`; revocada = ya no cuenta). Es el único lector: lo usa el freno del
 * Calendario (`[PGP.225]`) y lo usarán Gastos y Compras (`[PGP.226]`/`[PGP.227]`).
 *
 * Parámetros: `[tenant, uuids en minúsculas]`.
 */
export const SQL_AUTORIZACIONES_NORMA = `
SELECT a.cfdi_uuid, a.norm_rule, a.decision, a.created_by
  FROM finance.cfdi_norm_authorizations a
 WHERE a.tenant_id = ? AND a.revoked_at IS NULL AND a.cfdi_uuid = ANY(?::text[])`;

/** Por UUID en minúsculas, la lista de decisiones vivas (vacía = nadie ha decidido). */
export async function leerAutorizacionesNorma(
  trx: Knex | Knex.Transaction, tenantId: string, uuids: readonly string[],
): Promise<Map<string, AutorizacionNorma[]>> {
  const out = new Map<string, AutorizacionNorma[]>();
  const llaves = [...new Set(uuids.map((u) => String(u ?? '').trim().toLowerCase()).filter(Boolean))];
  if (!llaves.length) return out;
  const filas = (await trx.raw(SQL_AUTORIZACIONES_NORMA, [tenantId, llaves])).rows as {
    cfdi_uuid: string; norm_rule: string; decision: string; created_by: string | null;
  }[];
  for (const f of filas) {
    const lista = out.get(f.cfdi_uuid) ?? [];
    lista.push({ regla: f.norm_rule as ReglaNorma, decision: f.decision as AutorizacionNorma['decision'], por: f.created_by });
    out.set(f.cfdi_uuid, lista);
  }
  return out;
}
