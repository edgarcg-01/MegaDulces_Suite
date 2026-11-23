-- [anexo CL] El Calendario contra la realidad (2026-11-23). R6 (cancelado con dinero fuera), D3 (importe del banco), D5 (doble programada), D7 (liga a pago cancelado), R7.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '300s';
SELECT 'sysid', system_identifier FROM pg_control_system();

-- D7. Pagos de la Suite ligados a un documento de Kepler que hoy esta CANCELADO
SELECT 'D7_liga_a_cancelado', a.kepler_payment_linked_by, count(*), round(sum(a.amount_assigned))
  FROM finance.payment_allocations a
 WHERE a.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND a.status = 'executed' AND a.kepler_payment_folio IS NOT NULL
   AND EXISTS (SELECT 1 FROM kepler_ods.kdm1 m WHERE m.c3 = 'D' AND m.c43 = 'C' AND btrim(m.c1) = m.sucursal
                 AND m.sucursal = a.kepler_payment_sucursal AND btrim(m.c6) = btrim(a.kepler_payment_folio)
                 AND m.c4::text = substr(a.kepler_payment_doc_prefix, 3, 2)::int::text)
   AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 m WHERE m.c3 = 'D' AND coalesce(m.c43, '') <> 'C' AND btrim(m.c1) = m.sucursal
                 AND m.sucursal = a.kepler_payment_sucursal AND btrim(m.c6) = btrim(a.kepler_payment_folio)
                 AND m.c4::text = substr(a.kepler_payment_doc_prefix, 3, 2)::int::text)
 GROUP BY 2;

-- D3. Pagos ejecutados por el banco cuyo importe del banco no es el del pago
SELECT 'D3_banco_distinto', count(*), round(sum(abs(a.paid_bank_amount - a.amount_assigned)))
  FROM finance.payment_allocations a
 WHERE a.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND a.status = 'executed' AND a.paid_bank_amount IS NOT NULL
   AND abs(a.paid_bank_amount - a.amount_assigned) >= 1;

-- D6. Pagos CANCELADOS en la Suite con una salida del banco por su importe despues de su dia, que ningun otro pago explica
WITH c AS MATERIALIZED (
  SELECT a.id, a.amount_assigned AS monto, l.lot_date, a.updated_at::date AS cancelado, a.payment_method
    FROM finance.payment_allocations a JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
   WHERE a.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND a.status = 'cancelled' AND a.amount_assigned >= 1000
), s AS MATERIALIZED (
  SELECT c.*, (SELECT count(*) FROM finance.bank_movements b WHERE b.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND b.deleted_at IS NULL
                  AND abs(b.amount_out - c.monto) < 1 AND b.movement_date BETWEEN c.lot_date - 3 AND c.lot_date + 30) AS salidas,
              (SELECT count(*) FROM finance.payment_allocations a2 JOIN finance.payment_calendar_lots l2 ON l2.id = a2.lot_id
                WHERE a2.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND a2.status = 'executed' AND a2.id <> c.id
                  AND abs(coalesce(a2.paid_bank_amount, a2.amount_assigned) - c.monto) < 1 AND l2.lot_date BETWEEN c.lot_date - 10 AND c.lot_date + 30) AS otros_pagos,
              (SELECT count(*) FROM finance.bank_movements b WHERE b.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND b.deleted_at IS NULL
                  AND abs(b.amount_out - (c.monto + 100)) < 1 AND b.movement_date BETWEEN c.lot_date - 3 AND c.lot_date + 30) AS control_mas100
    FROM c
)
SELECT 'D6_cancelado_que_salio', count(*) FILTER (WHERE salidas > otros_pagos), round(sum(monto) FILTER (WHERE salidas > otros_pagos)),
       count(*) AS universo, count(*) FILTER (WHERE control_mas100 > 0) AS control
  FROM s;

-- D5. Una factura de Kepler en dos pagos VIVOS (pendiente+pendiente o pendiente+ejecutado) que juntos cubren mas que su importe
WITH it AS MATERIALIZED (
  SELECT i.obligation_id, a.id, a.status, (i.applied_amount + coalesce(i.discount_amount, 0)) AS cub, a.split_from_id
    FROM finance.payment_allocation_items i JOIN finance.payment_allocations a ON a.id = i.allocation_id
   WHERE i.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND i.obligation_source = 'kepler_payable' AND a.status IN ('pending', 'executed')
), g AS (
  SELECT obligation_id, count(*) AS n, count(*) FILTER (WHERE status = 'pending') AS pend, sum(cub) AS cub
    FROM it GROUP BY 1 HAVING count(*) > 1 AND count(*) FILTER (WHERE status = 'pending') > 0
), k AS (
  SELECT g.*, (SELECT e.c11 FROM kepler_ods.kdxe e WHERE btrim(e.c1) = e.sucursal AND e.c3 = 'A'
                 AND md5('kepler_payable|' || e.sucursal || '|' || e.c4 || '|' || e.c5 || '|' || btrim(e.c6))::uuid = g.obligation_id LIMIT 1) AS importe
    FROM g
)
SELECT 'D5_doble_programada', count(*) FILTER (WHERE cub > importe + 1), round(sum(cub - importe) FILTER (WHERE cub > importe + 1)), count(*) FROM k;
ROLLBACK;

-- R7: pagos del Calendario que salieron del banco y no estan en Kepler, separados con el banco (mismo pago / OTRO pago)
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '240s';
SELECT 'sysid', system_identifier FROM pg_control_system();
-- Pagos dobles con dinero: la Suite pago una factura (sin escribir) que Kepler ya tenia pagada con OTRO documento con dinero,
-- y ese otro documento tiene su propia salida en el banco. Incluye obligaciones capturadas (supplier_payable).
WITH ex AS MATERIALIZED (
  SELECT a.id, a.paid_bank_movement_id, a.paid_bank_date, a.paid_bank_amount, i.applied_amount AS cub,
         coalesce(o.kepler_sucursal, NULL) AS osuc, o.kepler_doc_tipo AS otipo, o.kepler_doc_sub AS osub, btrim(o.kepler_folio) AS ofol,
         i.obligation_source, i.obligation_id
    FROM finance.payment_allocations a
    JOIN finance.payment_allocation_items i ON i.allocation_id = a.id
    LEFT JOIN commercial.supplier_payment_obligations o ON i.obligation_source = 'supplier_payable' AND o.id = i.obligation_id
   WHERE a.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND a.status = 'executed' AND a.kepler_payment_folio IS NULL
     AND (a.paid_bank_movement_id IS NOT NULL OR a.paid_proof_id IS NOT NULL)
), doc AS MATERIALIZED (
  SELECT ex.id AS aid, ex.paid_bank_date, ex.paid_bank_amount, ex.cub, e.sucursal, btrim(e.c2) AS prov, e.c4, e.c5, btrim(e.c6) AS folio, e.c11 AS importe
    FROM ex
    JOIN kepler_ods.kdxe e ON btrim(e.c1) = e.sucursal AND e.c3 = 'A'
     AND ((ex.obligation_source = 'kepler_payable' AND md5('kepler_payable|' || e.sucursal || '|' || e.c4 || '|' || e.c5 || '|' || btrim(e.c6))::uuid = ex.obligation_id)
       OR (ex.obligation_source = 'supplier_payable' AND e.sucursal = ex.osuc AND e.c4::text = ex.otipo::text AND e.c5::text = ex.osub::text AND btrim(e.c6) = ex.ofol))
), kpag AS MATERIALIZED (
  SELECT d.aid, d.sucursal, d.prov, d.folio, d.importe, d.cub, d.paid_bank_date, d.paid_bank_amount,
         x.c4 AS ptipo, btrim(x.c6) AS pfol, x.c3::date AS pfecha,
         (SELECT sum(y.c10) FROM kepler_ods.kdxf y WHERE y.sucursal = x.sucursal AND y.c1 = x.c1 AND y.c2 = x.c2 AND y.c4 = x.c4 AND y.c5 = x.c5 AND y.c6 = x.c6) AS doc_total
    FROM doc d
    JOIN kepler_ods.kdxf x ON x.sucursal = d.sucursal AND btrim(x.c1) = x.sucursal AND x.c7 = d.c4 AND x.c8 = d.c5 AND btrim(x.c9) = d.folio
   WHERE x.c4 IN (25, 26)
     AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 m WHERE m.c3 = 'D' AND m.c43 = 'C' AND btrim(m.c1) = m.sucursal AND m.sucursal = x.sucursal
                       AND m.c1 = x.c1 AND m.c10 = x.c2 AND m.c4 = x.c4 AND m.c5 = x.c5 AND m.c6 = x.c6)
)
SELECT '6_doble?', left(k.aid::text, 8), k.sucursal, k.prov, k.folio, round(k.importe, 2), round(k.cub, 2), k.paid_bank_date, round(k.paid_bank_amount, 2),
       k.ptipo || '-' || k.pfol, k.pfecha, round(k.doc_total, 2),
       (SELECT count(*) FROM finance.bank_statement_lines s WHERE s.tenant_id = '00000000-0000-0000-0000-00000000d01c'
           AND abs(s.amount_out - k.doc_total) < 0.05 AND s.movement_date BETWEEN k.pfecha - 3 AND k.pfecha + 5) AS salidas_descarga,
       (SELECT count(*) FROM finance.bank_movements b WHERE b.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND b.deleted_at IS NULL
           AND abs(b.amount_out - k.doc_total) < 0.05 AND b.movement_date BETWEEN k.pfecha - 3 AND k.pfecha + 5) AS salidas_libro,
       CASE WHEN abs(k.doc_total - k.paid_bank_amount) < 1 AND abs(k.pfecha - k.paid_bank_date) <= 3 THEN 'mismo pago' ELSE 'OTRO pago' END
  FROM kpag k ORDER BY k.paid_bank_date, k.aid;

-- Kepler pagado de mas por si solo (dinero aplicado > importe), facturas desde septiembre
WITH f AS MATERIALIZED (
  SELECT x.sucursal, btrim(x.c2) AS prov, x.c7, x.c8, btrim(x.c9) AS folio, sum(x.c10) AS dinero, count(DISTINCT x.c6) AS docs,
         string_agg(x.c4 || '-' || btrim(x.c6) || '@' || x.c3::date || ':' || round(x.c10, 2), ' ; ' ORDER BY x.c3) AS det
    FROM kepler_ods.kdxf x
   WHERE btrim(x.c1) = x.sucursal AND x.c4 IN (25, 26) AND x.c7 IN (10, 20) AND x.c3 >= '2026-10-01'
     AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 m WHERE m.c3 = 'D' AND m.c43 = 'C' AND btrim(m.c1) = m.sucursal AND m.sucursal = x.sucursal
                       AND m.c1 = x.c1 AND m.c10 = x.c2 AND m.c4 = x.c4 AND m.c5 = x.c5 AND m.c6 = x.c6)
   GROUP BY 1, 2, 3, 4, 5 HAVING count(DISTINCT x.c6) > 1
)
SELECT '6_kepler_de_mas', f.sucursal, f.prov, f.c7 || '-' || f.folio, round(e.c11, 2), round(f.dinero, 2), f.det
  FROM f JOIN kepler_ods.kdxe e ON e.sucursal = f.sucursal AND btrim(e.c1) = e.sucursal AND e.c3 = 'A' AND e.c4 = f.c7 AND e.c5 = f.c8 AND btrim(e.c6) = f.folio
 WHERE f.dinero > e.c11 + 1
 ORDER BY f.dinero - e.c11 DESC;
ROLLBACK;

-- R6 detalle: los pagos cancelados cuyo dinero salio, con sus facturas en Kepler y en otros pagos vivos
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '300s';
SELECT 'sysid', system_identifier FROM pg_control_system();
WITH c AS MATERIALIZED (
  SELECT a.id, a.amount_assigned AS monto, l.lot_date, a.reprogram_reason, a.failure_reason, a.notes,
         (SELECT h.event || '@' || (h.created_at AT TIME ZONE 'America/Mexico_City')::date || ' ' || coalesce(h.created_by, '')
            FROM finance.payment_allocation_history h WHERE h.allocation_id = a.id ORDER BY h.created_at DESC LIMIT 1) AS ultimo
    FROM finance.payment_allocations a JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
   WHERE a.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND a.status = 'cancelled' AND a.amount_assigned >= 1000
), s AS MATERIALIZED (
  SELECT c.*,
         (SELECT string_agg(ba.bank || ' ' || ba.account_label || ' ' || b.movement_date || ' ' || left(coalesce(b.concept, ''), 28), ' ; ')
            FROM finance.bank_movements b JOIN finance.bank_accounts ba ON ba.id = b.bank_account_id
           WHERE b.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND b.deleted_at IS NULL
             AND abs(b.amount_out - c.monto) < 1 AND b.movement_date BETWEEN c.lot_date - 3 AND c.lot_date + 30) AS salida,
         (SELECT count(*) FROM finance.bank_movements b WHERE b.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND b.deleted_at IS NULL
             AND abs(b.amount_out - c.monto) < 1 AND b.movement_date BETWEEN c.lot_date - 3 AND c.lot_date + 30) AS salidas,
         (SELECT count(*) FROM finance.payment_allocations a2 JOIN finance.payment_calendar_lots l2 ON l2.id = a2.lot_id
           WHERE a2.tenant_id = '00000000-0000-0000-0000-00000000d01c' AND a2.status = 'executed' AND a2.id <> c.id
             AND abs(coalesce(a2.paid_bank_amount, a2.amount_assigned) - c.monto) < 1 AND l2.lot_date BETWEEN c.lot_date - 10 AND c.lot_date + 30) AS otros
    FROM c
), it AS (
  SELECT s.id, i.obligation_source, i.obligation_id,
         CASE WHEN i.obligation_source = 'kepler_payable' THEN
           (SELECT v.pendiente FROM analytics.v_supplier_payables v WHERE v.tenant_id = '00000000-0000-0000-0000-00000000d01c'
              AND md5('kepler_payable|' || v.sucursal || '|' || v.doc_tipo || '|' || v.doc_sub || '|' || v.folio)::uuid = i.obligation_id) END AS pend,
         EXISTS (SELECT 1 FROM finance.payment_allocation_items i2 JOIN finance.payment_allocations a2 ON a2.id = i2.allocation_id
                  WHERE i2.obligation_id = i.obligation_id AND i2.allocation_id <> s.id AND a2.status IN ('pending', 'executed')) AS en_otro_vivo
    FROM s JOIN finance.payment_allocation_items i ON i.allocation_id = s.id
   WHERE s.salidas > s.otros
)
SELECT 'D6', left(s.id::text, 8), s.lot_date, round(s.monto, 2), left(coalesce(s.ultimo, '-'), 55), left(coalesce(s.reprogram_reason, s.failure_reason, ''), 25),
       (SELECT count(*) FROM it WHERE it.id = s.id) AS facturas,
       (SELECT count(*) FROM it WHERE it.id = s.id AND it.obligation_source = 'kepler_payable' AND it.pend IS NULL) AS saldadas_kepler,
       (SELECT count(*) FROM it WHERE it.id = s.id AND it.pend IS NOT NULL) AS abiertas_kepler,
       (SELECT count(*) FROM it WHERE it.id = s.id AND it.en_otro_vivo) AS en_otro_pago_vivo,
       left(s.salida, 70)
  FROM s WHERE s.salidas > s.otros ORDER BY s.monto DESC;
ROLLBACK;
