/**
 * `[PGP.119]` Las lecturas de la solicitud de anticipo. Viven aparte del servicio para que el texto
 * que corre en producción sea el MISMO que se mide contra prod (los scripts lo leen de aquí).
 *
 * ⛔ El `X-D-60` se busca por acreedor + sucursal + importe ±$1, desde 5 días antes del alta hasta 60
 *    después. El uno a uno lo decide `parearSolicitudes` (contrato). Control negativo medido el
 *    2026-11-13: 4 de 143 anticipos de 12 meses tienen un gemelo así.
 */

/**
 * Las solicitudes de anticipo de 180 días con su pago del Calendario y sus candidatos de Kepler.
 * Parámetros: `[tenant_id]`.
 */
export const SQL_ANTICIPOS_SOLICITADOS = `WITH s AS (
  SELECT o.id, btrim(sp.code) AS proveedor, sp.name AS proveedor_nombre, o.kepler_sucursal AS sucursal,
         o.original_amount::float8 AS monto, o.paid_amount::float8 AS pagado, o.status,
         o.notes AS motivo, o.created_by, o.created_at, to_char(o.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS creado,
         to_char(o.original_due_date, 'YYYY-MM-DD') AS fecha_deseada, po.folio AS oc_folio
    FROM commercial.supplier_payment_obligations o
    JOIN catalog.suppliers sp ON sp.id = o.supplier_id
    LEFT JOIN commercial.purchase_orders po ON po.id = o.purchase_order_id
   WHERE o.tenant_id = ? AND o.nature = 'anticipo' AND o.created_at >= now() - interval '180 days'
), pg AS (
  SELECT DISTINCT ON (i.obligation_id) i.obligation_id, a.id::text AS allocation_id, to_char(l.lot_date, 'YYYY-MM-DD') AS dia
    FROM finance.payment_allocation_items i
    JOIN finance.payment_allocations a ON a.id = i.allocation_id AND a.status <> 'cancelled'
    JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
   WHERE i.obligation_source = 'supplier_payable' AND i.obligation_id IN (SELECT id FROM s)
   ORDER BY i.obligation_id, l.lot_date DESC
), cand AS (
  SELECT k.sucursal, btrim(k.c2) AS acreedor, btrim(k.c6) AS folio, k.c7::date AS fecha,
         k.c11::float8 AS importe, coalesce(k.c20, 0)::float8 AS remanente
    FROM kepler_ods.kdxe k
   WHERE btrim(k.c1) = k.sucursal AND btrim(k.c3) = 'D' AND k.c4::int = 60
     AND k.sucursal IN (SELECT DISTINCT sucursal FROM s WHERE sucursal IS NOT NULL)
     AND btrim(k.c2) IN (SELECT DISTINCT proveedor FROM s)
     AND k.c7 >= (SELECT min(created_at)::date - 5 FROM s)
)
SELECT s.id::text AS obligation_id, s.proveedor, s.proveedor_nombre, s.sucursal, s.monto, s.pagado, s.status AS estado_obligacion,
       s.motivo, s.created_by AS creado_por, s.creado, s.fecha_deseada, s.oc_folio,
       pg.allocation_id, pg.dia AS programado_dia,
       coalesce((SELECT json_agg(json_build_object('folio', c.folio, 'fecha', to_char(c.fecha, 'YYYY-MM-DD'), 'importe', c.importe, 'remanente', c.remanente))
                   FROM cand c
                  WHERE c.sucursal = s.sucursal AND c.acreedor = s.proveedor AND abs(c.importe - s.monto) <= 1
                    AND c.fecha BETWEEN s.created_at::date - 5 AND s.created_at::date + 60), '[]'::json) AS candidatos
  FROM s
  LEFT JOIN pg ON pg.obligation_id = s.id
 ORDER BY s.created_at DESC`;

/**
 * Las OC abiertas de UN proveedor con lo ya pedido de anticipo sobre cada una.
 * Parámetros: `[tenant_id, supplier_id]`.
 */
export const SQL_ANTICIPO_OCS = `SELECT po.id::text AS id, po.folio, w.code AS sucursal, po.estado, po.total_cost::float8 AS total,
       coalesce((SELECT sum(o.original_amount) FROM commercial.supplier_payment_obligations o
                  WHERE o.purchase_order_id = po.id AND o.nature = 'anticipo' AND o.status <> 'cancelled'), 0)::float8 AS anticipado,
       to_char(po.created_at, 'YYYY-MM-DD') AS creada
  FROM commercial.purchase_orders po
  LEFT JOIN commercial.warehouses w ON w.tenant_id = po.tenant_id AND w.id = po.warehouse_id
 WHERE po.tenant_id = ? AND po.supplier_id = ?::uuid AND po.estado IN ('open', 'partial')
 ORDER BY po.created_at DESC
 LIMIT 50`;
