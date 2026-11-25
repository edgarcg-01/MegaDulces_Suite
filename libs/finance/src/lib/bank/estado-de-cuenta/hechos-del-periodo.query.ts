/**
 * `[BFU.4.5.6]` **Los hechos de cada renglón de la descarga del banco de un periodo**, para decidir su área y si está
 * explicado (`leerFila`, en `cobertura-de-categoria.ts`). Es la ÚNICA consulta de esos hechos: la usan la cifra
 * «quién explica cada peso» del diagnóstico y el filtro por área de la lista de movimientos, para que el número y la
 * lista que abre cuenten lo mismo.
 *
 * Universo: el del motor de categoría (`sync_source = 'banco'`, sin borrar), el mismo de `cobertura_categoria`.
 *   · documento = casado con un documento de Kepler (`bank_recon_matches`);
 *   · pago      = ligado a un pago del Calendario EJECUTADO (`payment_allocations.paid_bank_movement_id`; sólo las
 *                 ejecutadas lo tienen: 192 de 275, medido el 2026-11-24);
 *   · cliente   = cliente declarado (`customer_code`, CC.11).
 *
 * `[BFU.4.5.12]` Y el ORIGEN de su documento (`origen-del-renglon.ts`): un cobro aplicado a un corte de caja POS
 * (`kdm5` → `U-D-23`) es venta de tienda, con la sucursal del corte; otro cobro, cobranza; `N-*-26`, traspaso.
 * ⛔ El cobro se busca en `kdm5` por su llave de ABONO (`ix_kdm5_abono`) y el cargo se compara DESPUÉS, concatenado: con
 * `c8/c9/c10` sueltos en el WHERE el planner elige `ix_kdm5_aplicacion_factura` (todas las aplicaciones a cortes de la
 * sucursal) y la consulta tarda 1.1 s; así, ~50 ms (prod, noviembre de 2026, 1,480 cobros casados, mediana de 3).
 * Se lee `kdm5` y no la vista de aplicaciones vigentes: un cobro cancelado sigue diciendo a QUÉ se aplicó.
 */
import type { Knex } from 'knex';
import type { FilaDeCobertura } from './cobertura-de-categoria';

export interface HechosDelRenglon extends FilaDeCobertura { id: string }

const SQL = `
WITH mov AS MATERIALIZED (
  SELECT bm.id, bm.statement_id, bm.category_id, bm.category_reason, bm.category_evidence, bm.movement_date, bm.amount_in,
         bm.amount_out, bm.classified_by, bm.customer_code, bm.concept
    FROM finance.bank_movements bm
    JOIN finance.bank_statements st ON st.id = bm.statement_id
   WHERE st.period = ? AND bm.deleted_at IS NULL AND bm.sync_source = 'banco'
),
m AS MATERIALIZED (
  SELECT r.bank_movement_id, r.kepler_sucursal AS suc, r.kepler_doc_tipo AS tipo, btrim(r.kepler_doc_folio) AS folio
    FROM finance.bank_recon_matches r JOIN mov ON mov.id = r.bank_movement_id
),
venta AS MATERIALIZED (
  SELECT m.bank_movement_id, min(m.suc) AS suc
    FROM m
    JOIN kepler_ods.kdm5 k
      ON k.c2 = 'U' AND btrim(k.c1) = m.suc AND btrim(k.c3) = 'A' AND btrim(k.c4::text) = split_part(m.tipo, '-', 3)
     AND btrim(k.c5::text) = '1' AND btrim(k.c6) = m.folio
   WHERE m.tipo LIKE 'U-A-%' AND k.sucursal = m.suc
     AND (btrim(k.c8) || '-' || btrim(k.c9::text) || '-' || btrim(k.c10::text)) = 'D-23-1'
   GROUP BY 1
),
origen AS MATERIALIZED (
  SELECT m.bank_movement_id,
         CASE WHEN bool_or(v.bank_movement_id IS NOT NULL) THEN 'venta_tienda'
              WHEN bool_or(m.tipo LIKE 'U-A-%') THEN 'cobranza'
              WHEN bool_or(m.tipo LIKE 'N-_-26') THEN 'traspaso'
              ELSE 'otro_documento' END AS origen_doc,
         min(v.suc) AS sucursal_doc
    FROM m LEFT JOIN venta v ON v.bank_movement_id = m.bank_movement_id
   GROUP BY 1
)
SELECT mov.id, (mov.category_id IS NOT NULL) AS con_categoria, mov.category_reason AS motivo,
       mov.category_evidence->>'responsable' AS responsable, to_char(mov.movement_date, 'YYYY-MM-DD') AS fecha,
       mc.owner_department_code AS area, (mov.amount_in > 0) AS entra, mc.code AS categoria, mov.classified_by,
       mov.category_evidence->>'fuente' AS fuente,
       EXISTS (SELECT 1 FROM finance.bank_recon_matches r WHERE r.bank_movement_id = mov.id) AS documento,
       EXISTS (SELECT 1 FROM finance.payment_allocations pa WHERE pa.paid_bank_movement_id = mov.id AND pa.status = 'executed') AS pago,
       (mov.customer_code IS NOT NULL) AS cliente,
       mov.concept AS concepto, o.origen_doc, o.sucursal_doc,
       1 AS n, (mov.amount_in + mov.amount_out)::numeric AS monto
  FROM mov
  LEFT JOIN finance.movement_categories mc ON mc.id = mov.category_id
  LEFT JOIN origen o ON o.bank_movement_id = mov.id`;

export async function leerHechosDelPeriodo(trx: Knex | Knex.Transaction, period: string): Promise<HechosDelRenglon[]> {
  const r = await trx.raw(SQL, [period]);
  return (r.rows ?? r) as HechosDelRenglon[];
}
