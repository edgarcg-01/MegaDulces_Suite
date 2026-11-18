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
         to_char(o.original_due_date, 'YYYY-MM-DD') AS fecha_deseada, po.folio AS oc_folio,
         -- [PGP.127]/[PGP.129] Lo que el Calendario necesita para ofrecerlo en su día sin otra llamada.
         o.supplier_id::text AS supplier_id, o.tenant_id,
         (o.original_amount - o.reserved_amount - o.paid_amount)::float8 AS disponible,
         coalesce(o.kepler_ocs, '[]'::jsonb) AS ocs, (o.quote_file_key IS NOT NULL) AS tiene_cotizacion, o.payee_clabe
    FROM commercial.supplier_payment_obligations o
    JOIN catalog.suppliers sp ON sp.id = o.supplier_id
    LEFT JOIN commercial.purchase_orders po ON po.id = o.purchase_order_id
   WHERE o.tenant_id = ? AND o.nature = 'anticipo' AND o.created_at >= now() - interval '180 days'
), pg AS (
  SELECT DISTINCT ON (i.obligation_id) i.obligation_id, a.id::text AS allocation_id, to_char(l.lot_date, 'YYYY-MM-DD') AS dia,
         -- [PGP.144] Cuándo quedó CUBIERTO: el día (hora de México) en que su pago del Calendario se dio por pagado.
         CASE WHEN a.status = 'executed' AND a.executed_at IS NOT NULL
              THEN to_char((a.executed_at AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') END AS cubierto_el
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
       pg.allocation_id, pg.dia AS programado_dia, pg.cubierto_el,
       s.supplier_id, s.disponible, s.ocs, s.tiene_cotizacion, s.payee_clabe,
       -- [PGP.127] La cuenta se DERIVA del catálogo y de su última solicitud con esa CLABE: no se copia.
       (SELECT a.bank_name FROM commercial.supplier_payment_accounts a
         WHERE a.tenant_id = s.tenant_id AND a.supplier_id::text = s.supplier_id AND a.clabe = s.payee_clabe AND a.status = 'activa'
         ORDER BY a.created_at LIMIT 1) AS banco_aprobada,
       r.status AS solicitud_estado, r.proposed_bank_name AS solicitud_banco,
       coalesce((SELECT json_agg(json_build_object('folio', c.folio, 'fecha', to_char(c.fecha, 'YYYY-MM-DD'), 'importe', c.importe, 'remanente', c.remanente))
                   FROM cand c
                  WHERE c.sucursal = s.sucursal AND c.acreedor = s.proveedor AND abs(c.importe - s.monto) <= 1
                    AND c.fecha BETWEEN s.created_at::date - 5 AND s.created_at::date + 60), '[]'::json) AS candidatos
  FROM s
  LEFT JOIN pg ON pg.obligation_id = s.id
  LEFT JOIN LATERAL (
    SELECT q.status, q.proposed_bank_name FROM commercial.supplier_payment_account_change_requests q
     WHERE q.tenant_id = s.tenant_id AND q.supplier_id::text = s.supplier_id AND q.proposed_clabe = s.payee_clabe AND NOT q.deactivate
     ORDER BY q.requested_at DESC LIMIT 1
  ) r ON s.payee_clabe IS NOT NULL
 ORDER BY s.created_at DESC`;

/**
 * `[PGP.127]` **Las OC de Kepler (`X-A-35`) de UN acreedor**, pendientes (`N`) o recibidas en parte (`R`),
 * de 180 días, con los anticipos de la Suite (no cancelados) que incluyen cada una. Es la MISMA regla para
 * la lista de la pantalla y para la verificación del servidor al pedir.
 *
 * Medido en prod el 2026-11-17: 88 ms por `idx_kdm1_xa_doc`. 44 de 49 anticipos de mercancía de 120 días
 * tenían una OC así del mismo acreedor y sucursal en los 45 días previos.
 * ⚠️ El estado `A` (9 en 90 días) no se midió y queda fuera; `F` (surtida) ya tiene su factura: se paga ésa.
 *
 * Parámetros: `[codigo_acreedor, llaves, llaves, tenant_id]`. `llaves` = JSON de `sucursal|serie|folio`
 * para verificar sólo ésas (al pedir); `null` = la lista (hasta 50, lo más nuevo primero). Va como JSON y
 * no como arreglo: `knex.raw` expande un arreglo en `?, ?, ?` y el `::text[]` dejaría de ser uno.
 */
export const SQL_ANTICIPO_OCS_KEPLER = `WITH oc AS (
  SELECT k.sucursal, btrim(k.c5::text) AS serie, btrim(k.c6) AS folio, to_char(k.c9::date, 'YYYY-MM-DD') AS fecha,
         btrim(k.c43) AS estado, coalesce(k.c16, 0)::float8 AS total
    FROM kepler_ods.kdm1 k
   WHERE k.c2 = 'X' AND k.c3 = 'A' AND btrim(k.c4::text) = '35' AND btrim(k.c1) = k.sucursal
     AND btrim(k.c10) = ? AND btrim(k.c43) IN ('N', 'R')
     AND k.c9::date >= (now() AT TIME ZONE 'America/Mexico_City')::date - 180
     AND (?::jsonb IS NULL OR (k.sucursal || '|' || btrim(k.c5::text) || '|' || btrim(k.c6)) IN (SELECT jsonb_array_elements_text(?::jsonb)))
   ORDER BY k.c9 DESC, btrim(k.c6) DESC
   LIMIT 50
)
SELECT oc.sucursal, oc.serie, oc.folio, oc.fecha, oc.estado, oc.total,
       coalesce((SELECT json_agg(json_build_object('id', o.id::text, 'monto', o.original_amount::float8) ORDER BY o.created_at)
                   FROM commercial.supplier_payment_obligations o
                  WHERE o.tenant_id = ? AND o.nature = 'anticipo' AND o.status <> 'cancelled'
                    AND o.kepler_ocs @> jsonb_build_array(jsonb_build_object('sucursal', oc.sucursal, 'serie', oc.serie, 'folio', oc.folio))), '[]'::json) AS pedidos
  FROM oc
 ORDER BY oc.fecha DESC, oc.folio DESC`;

/**
 * `[PGP.144]` **Los anticipos de mercancía que Kepler tiene** (`X-D-60` de acreedores `C*`) desde una fecha: el
 * otro lado del embudo. El servicio quita los que ya están pareados con una solicitud de la Suite; lo que queda
 * se pagó fuera del embudo. Gasto (`G*`) y tarjeta (`TC*`) no entran: no se piden aquí (D2).
 *
 * Medido en prod el 2026-11-17: 33 ms; 83 documentos ($7.6 M) en 180 días, 38 en 90.
 * Parámetros: `[tenant_id, desde (YYYY-MM-DD)]`.
 */
export const SQL_ANTICIPOS_KEPLER_MERCANCIA = `SELECT k.sucursal, btrim(k.c2) AS proveedor,
       (SELECT sp.name FROM catalog.suppliers sp WHERE sp.tenant_id = ? AND btrim(sp.code) = btrim(k.c2) LIMIT 1) AS proveedor_nombre,
       btrim(k.c6) AS folio, to_char(k.c7::date, 'YYYY-MM-DD') AS fecha,
       k.c11::float8 AS importe, coalesce(k.c20, 0)::float8 AS remanente, NULLIF(btrim(k.c16), '') AS referencia
  FROM kepler_ods.kdxe k
 WHERE btrim(k.c1) = k.sucursal AND btrim(k.c3) = 'D' AND k.c4::int = 60 AND btrim(k.c2) LIKE 'C%'
   AND k.c7::date >= ?::date
 ORDER BY k.c7 DESC, btrim(k.c6) DESC`;
