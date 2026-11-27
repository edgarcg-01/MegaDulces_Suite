import type { Knex } from 'knex';
import type { AutorizacionNorma, ReglaNorma } from '@megadulces/contracts/finance/norma-fiscal-cfdi';
import type { DecisionNorma, DecisionTomada } from '@megadulces/contracts';

/**
 * `[PGP.224]` **Las decisiones vivas de Administración o Contabilidad sobre los CFDI**, una por regla
 * (`finance.cfdi_norm_authorizations`; revocada = ya no cuenta). Es el único lector: lo usan el freno del
 * Calendario (`[PGP.225]`), la bandeja «Facturas fuera de norma» (`[PGP.229]`) y lo usarán Gastos y Compras.
 *
 * Parámetros: `[tenant]` y, con `SQL_AUTORIZACIONES_NORMA`, además `[uuids en minúsculas]`.
 */
export const SQL_DECISIONES_VIVAS = `
SELECT a.id::text AS id, a.cfdi_uuid, a.norm_rule, a.decision, a.reason, a.created_by, a.created_at
  FROM finance.cfdi_norm_authorizations a
 WHERE a.tenant_id = ? AND a.revoked_at IS NULL`;

export const SQL_AUTORIZACIONES_NORMA = `${SQL_DECISIONES_VIVAS} AND a.cfdi_uuid = ANY(?::text[])`;

/** Una decisión viva con el UUID (en minúsculas) de su factura. */
export type DecisionDeFactura = DecisionTomada & { uuid: string };

/**
 * Las decisiones vivas, por UUID en minúsculas. `uuids` null = todas las del tenant (la bandeja); una lista vacía
 * no lee nada.
 */
export async function leerDecisionesNorma(
  trx: Knex | Knex.Transaction, tenantId: string, uuids: readonly string[] | null,
): Promise<Map<string, DecisionDeFactura[]>> {
  const out = new Map<string, DecisionDeFactura[]>();
  const llaves = uuids == null ? null : [...new Set(uuids.map((u) => String(u ?? '').trim().toLowerCase()).filter(Boolean))];
  if (llaves && !llaves.length) return out;
  const filas = (await (llaves ? trx.raw(SQL_AUTORIZACIONES_NORMA, [tenantId, llaves]) : trx.raw(SQL_DECISIONES_VIVAS, [tenantId]))).rows as {
    id: string; cfdi_uuid: string; norm_rule: string; decision: string; reason: string; created_by: string; created_at: Date | string;
  }[];
  for (const f of filas) {
    const lista = out.get(f.cfdi_uuid) ?? [];
    lista.push({
      id: f.id, uuid: f.cfdi_uuid, regla: f.norm_rule as ReglaNorma, decision: f.decision as DecisionNorma, motivo: f.reason,
      por: f.created_by, cuando: new Date(f.created_at).toISOString(),
    });
    out.set(f.cfdi_uuid, lista);
  }
  return out;
}

/** Lo que la regla necesita de cada decisión: por UUID en minúsculas (vacía = nadie ha decidido). */
export async function leerAutorizacionesNorma(
  trx: Knex | Knex.Transaction, tenantId: string, uuids: readonly string[],
): Promise<Map<string, AutorizacionNorma[]>> {
  const out = new Map<string, AutorizacionNorma[]>();
  for (const [uuid, ds] of await leerDecisionesNorma(trx, tenantId, uuids)) {
    out.set(uuid, ds.map((d) => ({ regla: d.regla, decision: d.decision, por: d.por })));
  }
  return out;
}
