import type { Knex } from 'knex';
import { CORTE_OFICINAS, sueltaPorCorte, type CorteSueltaRow } from '@megadulces/contracts';

/**
 * `[PGP.113]` **Las facturas de sucursal anteriores al corte que Oficinas nunca registró.**
 *
 * La regla y su porqué viven en `libs/contracts/src/finance/corte-suelta.contract.ts`; acá sólo se MIDE,
 * por factura bloqueada, si Oficinas (`00`) tiene un cargo o un pago/anticipo del mismo acreedor por el
 * mismo importe (±$1). Decide `sueltaPorCorte`.
 *
 * ⛔ El cruce es UNA pasada por acreedor (`LEFT JOIN … GROUP BY`). Con `EXISTS` correlacionado contra las
 * ~45 mil partidas de Oficinas costaba **3.4–3.9 s** (medido 2026-11-10, 4 corridas, el plan se iba a un
 * nested loop de 2.1 s); así, **435–517 ms** con el mismo resultado (67 de 205).
 * Se pide UNA vez al abrir la pantalla y en paralelo con la lista, como el crédito a favor.
 */
export const SQL_CORTE_SUELTAS = `
  WITH lock AS MATERIALIZED (
    SELECT p.sucursal, p.proveedor, p.doc_tipo, p.doc_sub, p.folio, p.importe, p.pendiente
      FROM analytics.v_supplier_payables p
     WHERE p.tenant_id = ? AND p.sucursal <> '00' AND p.vencimiento < ?::date AND p.proveedor NOT LIKE 'TI%'
  ), ofi AS MATERIALIZED (
    SELECT btrim(e.c2) AS proveedor, e.c3, e.c11 AS importe
      FROM kepler_ods.kdxe e
     WHERE e.sucursal = '00' AND btrim(e.c1) = '00'
       AND (e.c3 = 'A' OR (e.c3 = 'D' AND e.c4::int IN (25, 26, 60)))
  )
  SELECT l.sucursal, l.proveedor, btrim(l.folio) AS folio,
         'oblig:' || l.sucursal || '|' || l.doc_tipo || '|' || l.doc_sub || '|' || btrim(l.folio) AS entity_ref,
         l.importe::float8 AS importe, l.pendiente::float8 AS pendiente,
         COALESCE(bool_or(o.c3 = 'A'), false) AS copia_en_oficinas,
         COALESCE(bool_or(o.c3 = 'D'), false) AS pago_en_oficinas
    FROM lock l
    LEFT JOIN ofi o ON o.proveedor = l.proveedor AND abs(o.importe - l.importe) <= 1
   GROUP BY l.sucursal, l.proveedor, l.doc_tipo, l.doc_sub, l.folio, l.importe, l.pendiente`;

interface FilaCorte {
  sucursal: string; proveedor: string; folio: string; entity_ref: string;
  importe: number; pendiente: number; copia_en_oficinas: boolean; pago_en_oficinas: boolean;
}

export async function leerCorteSueltas(trx: Knex | Knex.Transaction, tenantId: string): Promise<CorteSueltaRow[]> {
  const { rows } = await trx.raw(SQL_CORTE_SUELTAS, [tenantId, CORTE_OFICINAS]) as { rows: FilaCorte[] };
  return rows
    .filter((r) => sueltaPorCorte(r))
    .map((r) => ({ entity_ref: r.entity_ref, sucursal: r.sucursal, proveedor: r.proveedor, folio: r.folio, importe: Number(r.importe) }));
}
