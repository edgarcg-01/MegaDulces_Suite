import type { Knex } from 'knex';
import { CORTE_OFICINAS, copiaEnOficinas, sueltaPorCorte, type CorteSueltaRow } from '@megadulces/contracts';

/**
 * `[PGP.113]` **Las facturas de sucursal anteriores al corte que Oficinas nunca registró.**
 *
 * La regla y su porqué viven en `libs/contracts/src/finance/corte-suelta.contract.ts`; acá sólo se MIDE,
 * por factura bloqueada:
 *  - `refs_en_oficinas`: la referencia de cada cargo de Oficinas (`00`) del mismo acreedor por el importe
 *    o —`[PGP.147]`— por lo pendiente (±$1). Si alguno es copia lo decide `copiaEnOficinas` (`[PGP.147]`:
 *    la factura de otra sucursal no es copia).
 *  - `pago_en_oficinas`: un pago o anticipo de Oficinas por el importe o —`[PGP.147]`— por lo pendiente.
 *  - `nota_aplicada` (`[PGP.147]`): se le aplicó algo que no es pago ni anticipo de su propia sucursal. Con
 *    la MISMA llave con la que la vista calcula lo aplicado (sucursal, tipo, subtipo, folio; sin acreedor),
 *    para que todo lo que baja el pendiente se vea aquí.
 * Decide `sueltaPorCorte`.
 *
 * ⛔ El cruce con Oficinas es UNA pasada por acreedor (`LEFT JOIN … GROUP BY`). Con `EXISTS` correlacionado
 * contra las ~45 mil partidas de Oficinas costaba **3.4–3.9 s** (medido 2026-11-10); así, 435–517 ms.
 * ⛔ `[PGP.147]` Las notas se marcan sobre las ~200 bloqueadas ANTES de ese cruce y con `IN (…)` (se
 * resuelve con hash): unidas después del cruce, el planificador las cruzaba en ciclo anidado contra
 * ~1,800 filas (5.7 millones de comparaciones, **1.1–1.2 s**, medido 2026-11-18).
 * Se pide UNA vez al abrir la pantalla y en paralelo con la lista, como el crédito a favor.
 */
export const SQL_CORTE_SUELTAS = `
  WITH lock AS MATERIALIZED (
    SELECT p.sucursal, p.proveedor, p.doc_tipo, p.doc_sub, p.folio, p.referencia, p.importe, p.pendiente
      FROM analytics.v_supplier_payables p
     WHERE p.tenant_id = ? AND p.sucursal <> '00' AND p.vencimiento < ?::date AND p.proveedor NOT LIKE 'TI%'
  ), notas AS MATERIALIZED (
    -- La llave de la vista (v_supplier_payables, CTE apl): sucursal + c7/c8/c9, sin acreedor. Un tipo vacío
    -- cuenta como nota: sólo un pago o anticipo DECLARADO (25/26/60) deja de bloquear.
    SELECT f.sucursal, f.c7 AS t, f.c8 AS s, btrim(f.c9) AS folio
      FROM kepler_ods.kdxf f
     WHERE btrim(f.c1) = f.sucursal AND f.sucursal <> '00' AND f.c10 > 0
       AND (f.c4 IS NULL OR f.c4::int NOT IN (25, 26, 60))
       -- Sin factura a la cual atribuirla no baja ningún pendiente; con un NULL dentro, el IN de abajo daría
       -- «desconocido» (y por el COALESCE, bloqueada) a todas las de su sucursal que coincidan en lo demás.
       AND f.c7 IS NOT NULL AND f.c8 IS NOT NULL AND f.c9 IS NOT NULL
  ), marcada AS MATERIALIZED (
    SELECT l.*,
           (l.sucursal, l.doc_tipo, l.doc_sub, btrim(l.folio))
             IN (SELECT n.sucursal, n.t, n.s, n.folio FROM notas n) AS nota_aplicada
      FROM lock l
  ), ofi AS MATERIALIZED (
    SELECT btrim(e.c2) AS proveedor, e.c3, e.c11 AS importe, btrim(e.c16) AS ref
      FROM kepler_ods.kdxe e
     WHERE e.sucursal = '00' AND btrim(e.c1) = '00'
       AND (e.c3 = 'A' OR (e.c3 = 'D' AND e.c4::int IN (25, 26, 60)))
  )
  SELECT l.sucursal, l.proveedor, btrim(l.folio) AS folio, l.referencia,
         'oblig:' || l.sucursal || '|' || l.doc_tipo || '|' || l.doc_sub || '|' || btrim(l.folio) AS entity_ref,
         l.importe::float8 AS importe, l.pendiente::float8 AS pendiente,
         COALESCE(array_agg(o.ref) FILTER (WHERE o.c3 = 'A'), '{}') AS refs_en_oficinas,
         COALESCE(bool_or(o.c3 = 'D'), false) AS pago_en_oficinas,
         COALESCE(l.nota_aplicada, true) AS nota_aplicada
    FROM marcada l
    -- Por el importe o por lo pendiente, el cargo (copia) y el pago: si la sucursal pagó una parte y
    -- Oficinas registró o pagó el resto, el resto se ve.
    LEFT JOIN ofi o ON o.proveedor = l.proveedor
                   AND (abs(o.importe - l.importe) <= 1 OR abs(o.importe - l.pendiente) <= 1)
   GROUP BY l.sucursal, l.proveedor, l.doc_tipo, l.doc_sub, l.folio, l.referencia, l.importe, l.pendiente, l.nota_aplicada`;

interface FilaCorte {
  sucursal: string; proveedor: string; folio: string; referencia: string | null; entity_ref: string;
  importe: number; pendiente: number; refs_en_oficinas: Array<string | null> | null;
  pago_en_oficinas: boolean; nota_aplicada: boolean;
}

export async function leerCorteSueltas(trx: Knex | Knex.Transaction, tenantId: string): Promise<CorteSueltaRow[]> {
  const { rows } = await trx.raw(SQL_CORTE_SUELTAS, [tenantId, CORTE_OFICINAS]) as { rows: FilaCorte[] };
  return rows
    .filter((r) => sueltaPorCorte({
      copia_en_oficinas: copiaEnOficinas(r.refs_en_oficinas, r),
      pago_en_oficinas: r.pago_en_oficinas,
      nota_aplicada: r.nota_aplicada,
      importe: r.importe,
      pendiente: r.pendiente,
    }))
    .map((r) => ({ entity_ref: r.entity_ref, sucursal: r.sucursal, proveedor: r.proveedor, folio: r.folio, importe: Number(r.importe) }));
}
