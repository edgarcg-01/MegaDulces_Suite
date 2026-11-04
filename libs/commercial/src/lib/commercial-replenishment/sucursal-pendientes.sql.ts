/**
 * `[AB.45]` Las consultas de «Pendientes de la sucursal», una por cola.
 *
 * ⚠️ **Este archivo no importa NADA, a propósito.** Así la validación contra prod
 * (`database/scripts/ab45-pendientes-sucursal.js`, sólo lectura) carga ESTE texto tal cual, sin
 * copiarlo. Si una consulta se copiara al script, lo que se mide ya no sería lo que corre.
 *
 * ⛔ Ningún literal con signo de interrogación dentro de una consulta: knex lo toma como parámetro
 * posicional y la consulta truena («could not determine data type of parameter $1»). Ya pasó aquí.
 *
 * Cada consulta devuelve las filas pendientes de UNA sucursal, las más viejas primero, con la misma
 * forma: `clave · folio · detalle · fecha (date) · monto · total` (`total` = `count(*) OVER()`, el
 * universo completo aunque el `LIMIT` recorte las filas). `clave` identifica la fila de forma estable
 * (el id de su tabla, o el documento de Kepler): con ella alguien se atribuye el pendiente (AB.46).
 *
 * Binds con nombre: `:t` tenant · `:wh` almacén (uuid) · `:suc` llave canónica de la sucursal
 * (`branchKeySql`, `'01'`) · `:kc` código Kepler del almacén (`kepler_code` o `code`).
 *
 * El predicado de cada una es el de su pantalla DUEÑA, citado en el registro
 * (`sucursal-pendientes.registry.ts`). Este es un read-model de esos predicados: si el dueño cambia
 * su regla, se cambia aquí.
 */

const HOY = `(now() AT TIME ZONE 'America/Mexico_City')::date`;
const LIM = 200;

/**
 * Lo que corre el servicio por cada cola: la consulta + los días contra el día de México. Los días se
 * calculan en SQL porque un `date` de pg llega al driver como medianoche UTC y en JS se leería como el
 * día anterior (LC.16). Vive aquí (y no en el servicio) para que la validación ejerza esto mismo.
 */
export function envolver(sql: string): string {
  return `SELECT x.clave, x.folio, x.detalle, x.monto, x.total, (${HOY} - x.fecha)::int AS dias
            FROM (${sql}) x
           ORDER BY x.fecha NULLS LAST, x.folio`;
}

/**
 * El almacén de cada orden de entrada sale de la MISMA cascada que el Andén (`arrivals`): el mapa de la
 * sucursal si existe, si no el almacén que trae la vista. ⚠️ Con sólo el mapa, Canindo (06) y Morelia
 * Madero (07) —que no tienen fila en `erp_sucursal_warehouse`— salían en 0.
 *
 * `:sucs` = los códigos de sucursal de Kepler que caen en este almacén (los calcula el servicio con
 * `SUCURSALES_DEL_ALMACEN_SQL`). Va como CONSTANTE para que el filtro llegue a `kdm1` debajo de la vista;
 * la cascada de abajo sigue siendo la que decide.
 */
export const SQL_LLEGADAS_SIN_VALE = `
SELECT r.sucursal || '/' || r.folio AS clave, r.folio::text AS folio, COALESCE(NULLIF(btrim(r.proveedor_nombre), ''), 'Proveedor sin nombre') AS detalle,
       r.receipt_date::date AS fecha, r.monto AS monto, count(*) OVER()::int AS total
  FROM analytics.erp_goods_receipts r
  LEFT JOIN commercial.erp_sucursal_warehouse m ON m.tenant_id = r.tenant_id AND m.sucursal = r.sucursal
 WHERE r.tenant_id = :t AND r.dup_of_folio IS NULL
   AND r.sucursal = ANY(CAST(:sucs AS text[]))
   AND COALESCE(m.warehouse_id, r.warehouse_id) = :wh
   AND r.receipt_date BETWEEN ${HOY} - 7 AND ${HOY}
   AND NOT EXISTS (SELECT 1 FROM commercial.receiving_sessions s
                    WHERE s.tenant_id = r.tenant_id AND s.status <> 'cancelled'
                      AND s.source_ref = r.sucursal || '/' || r.folio)
 ORDER BY r.receipt_date, r.folio
 LIMIT ${LIM}`;

/**
 * Los códigos de sucursal de Kepler cuyas órdenes de entrada caen en el almacén `:wh` por la cascada de
 * arriba: los que el mapa le asigna, más el `code` del almacén si el mapa no lo manda a otro. Devuelve
 * el arreglo como literal de Postgres (`{08,30}`) para pasarlo tal cual a `:sucs`.
 */
export const SUCURSALES_DEL_ALMACEN_SQL = `
SELECT '{' || COALESCE(string_agg(DISTINCT s, ','), '') || '}' AS sucs
  FROM (SELECT m.sucursal AS s FROM commercial.erp_sucursal_warehouse m WHERE m.tenant_id = :t AND m.warehouse_id = :wh
        UNION
        SELECT w.code FROM commercial.warehouses w
         WHERE w.tenant_id = :t AND w.id = :wh
           AND NOT EXISTS (SELECT 1 FROM commercial.erp_sucursal_warehouse m2
                            WHERE m2.tenant_id = w.tenant_id AND m2.sucursal = w.code AND m2.warehouse_id <> w.id)) x`;

/**
 * `source_ref` es `«sucursal»/«folio»` de Kepler («01/0000401»): el detalle dice QUÉ documento es y su
 * folio, sin el código de sucursal (la sucursal se nombra, jamás se numera; y el vale ya es de ésta).
 */
export const SQL_VALES_ABIERTOS = `
SELECT s.id::text AS clave, s.folio::text AS folio,
       CASE s.source_kind WHEN 'manual' THEN 'Vale manual'
         ELSE CASE s.source_kind WHEN 'erp_receipt' THEN 'Orden de entrada ' WHEN 'erp_transfer' THEN 'Traspaso ' ELSE 'Documento ' END
              || COALESCE(NULLIF(split_part(s.source_ref, '/', 2), ''), s.source_ref, '') END AS detalle,
       s.created_at::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM commercial.receiving_sessions s
 WHERE s.tenant_id = :t AND s.warehouse_id = :wh AND s.status IN ('open', 'validating')
 ORDER BY s.created_at
 LIMIT ${LIM}`;

export const SQL_SIN_FECHAR = `
SELECT l.id::text AS clave, s.folio::text AS folio, COALESCE(p.nombre, l.expected_name, l.expected_sku) AS detalle,
       s.closed_at::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM commercial.receiving_lines l
  JOIN commercial.receiving_sessions s ON s.tenant_id = l.tenant_id AND s.id = l.session_id
  LEFT JOIN public.products p ON p.id = l.product_id
 WHERE l.tenant_id = :t AND s.warehouse_id = :wh AND s.status = 'closed'
   AND l.product_id IS NOT NULL AND l.received_qty > 0
   AND l.received_qty > COALESCE((SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
                                   WHERE c.receiving_line_id = l.id AND c.status IN ('accepted', 'pending_authorization')), 0)
 ORDER BY s.closed_at, s.folio
 LIMIT ${LIM}`;

/**
 * El universo de `/compras/entradas` en su carril por defecto (`al_dia`): sin la copia CEDIS
 * (`dup_of_folio`) y desde `reception_start` de `finance.receipt_settings` — el mismo default que el
 * servicio dueño (`RECEPTION_START_DEFAULT`). Con 90 días a secas, CEDIS sumaba 253 copias.
 * Filtra por `sucursal` (como el alcance del dueño, `c.sucursal IN …`) y no por `warehouse_id`: la
 * constante llega a `kdm1` debajo de la vista; el `warehouse_id` sale de un join y no baja.
 */
export const SQL_ENTRADAS_SIN_COMPROBANTE = `
SELECT r.sucursal || '/' || r.folio AS clave, r.folio::text AS folio, COALESCE(NULLIF(btrim(r.proveedor_nombre), ''), 'Proveedor sin nombre') AS detalle,
       r.receipt_date::date AS fecha, r.monto AS monto, count(*) OVER()::int AS total
  FROM analytics.erp_goods_receipts r
  LEFT JOIN finance.goods_receipt_proofs p ON p.tenant_id = r.tenant_id AND p.sucursal = r.sucursal AND p.folio = r.folio
 WHERE r.tenant_id = :t AND r.sucursal = :suc AND r.dup_of_folio IS NULL AND p.folio IS NULL
   AND r.receipt_date >= COALESCE((SELECT s.reception_start FROM finance.receipt_settings s WHERE s.tenant_id = :t), DATE '2026-08-01')
 ORDER BY r.receipt_date, r.folio
 LIMIT ${LIM}`;

export const SQL_RECLAMOS = `
SELECT c.id::text AS clave, COALESCE(c.folio, c.source_ref, '')::text AS folio, COALESCE(c.product_name, c.sku) AS detalle,
       c.created_at::date AS fecha, c.amount AS monto, count(*) OVER()::int AS total
  FROM commercial.receiving_claims c
 WHERE c.tenant_id = :t AND c.status IN ('open', 'claimed')
   AND (c.warehouse_id = :wh OR c.responsible_warehouse_id = :wh)
 ORDER BY c.created_at
 LIMIT ${LIM}`;

export const SQL_OLAS = `
SELECT w.id::text AS clave, w.code::text AS folio,
       CASE w.status WHEN 'en_surtido' THEN 'A medias' ELSE 'Sin empezar' END
         || CASE WHEN w.prioridad = 1 THEN ' · urgente' ELSE '' END AS detalle,
       w.created_at::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM commercial.picking_waves w
 WHERE w.tenant_id = :t AND w.warehouse_id = :wh AND w.status IN ('abierta', 'en_surtido')
 ORDER BY w.created_at
 LIMIT ${LIM}`;

export const SQL_PREVENTA_SIN_TERMINAR = `
SELECT p.id::text AS clave, COALESCE(o.code, '')::text AS folio, 'Lo empezó ' || COALESCE(p.started_by_name, 'alguien') AS detalle,
       p.started_at::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM commercial.presale_picks p
  LEFT JOIN commercial.orders o ON o.id = p.order_id
 WHERE p.tenant_id = :t AND p.warehouse_id = :wh AND p.finished_at IS NULL
 ORDER BY p.started_at
 LIMIT ${LIM}`;

export const SQL_PREVENTA_POR_REVISAR = `
SELECT p.id::text AS clave, COALESCE(o.code, '')::text AS folio, 'Surtió ' || COALESCE(p.finished_by_name, 'alguien') AS detalle,
       p.finished_at::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM commercial.presale_picks p
  LEFT JOIN commercial.orders o ON o.id = p.order_id
 WHERE p.tenant_id = :t AND p.warehouse_id = :wh AND p.finished_at IS NOT NULL
   AND p.review_required AND p.reviewed_at IS NULL
 ORDER BY p.finished_at
 LIMIT ${LIM}`;

export const SQL_GUIAS = `
SELECT g.id::text AS clave, g.folio::text AS folio,
       CASE g.status WHEN 'abierta' THEN 'Abierta' ELSE 'Impresa, sin liquidar' END
         || COALESCE(' · ruta ' || NULLIF(btrim(g.sales_route), ''), '') AS detalle,
       g.business_date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM commercial.load_guides g
 WHERE g.tenant_id = :t AND g.branch = :suc AND g.status IN ('abierta', 'impresa') AND g.liquidation_id IS NULL
 ORDER BY g.business_date, g.folio
 LIMIT ${LIM}`;

export const SQL_CHECADO = `
SELECT c.id::text AS clave, COALESCE(c.order_code, c.kepler_folio, '')::text AS folio, c.destino_nombre AS detalle,
       c.created_at::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM commercial.order_checks c
 WHERE c.tenant_id = :t AND c.warehouse_id = :wh AND c.status = 'en_checado'
 ORDER BY c.created_at
 LIMIT ${LIM}`;

/**
 * Turno de Kepler CERRADO en 7 días sin su arqueo de cierre (el mismo NOT EXISTS que `turnosPendientes`).
 * El cajero, por su nombre del catálogo de Wincaja (`pos_cashiers`, el mismo join que `blind-count`); sin
 * nombre en el catálogo queda su clave, no se inventa.
 */
export const SQL_TURNOS_SIN_ARQUEO = `
SELECT k.sucursal || '/' || btrim(k.c2::text) || '/' || k.c3::bigint::text AS clave, k.c3::bigint::text AS folio,
       'Caja ' || btrim(k.c2::text) || COALESCE(' · ' || COALESCE(NULLIF(btrim(pc.nombre), ''), NULLIF(btrim(k.c8), '')), '') AS detalle,
       k.c5::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM kepler_ods.kdpv_folio_caja k
  LEFT JOIN analytics.pos_cashiers pc ON pc.tenant_id = :t AND pc.warehouse_code = k.sucursal AND pc.cajero_code = btrim(k.c8)
 WHERE k.sucursal = :kc
   AND k.c10::date <> DATE '1800-01-01'
   AND k.c5::date >= ${HOY} - 7
   AND NOT EXISTS (SELECT 1 FROM reconciliation.blind_counts b
                    WHERE b.tenant_id = :t AND b.warehouse_code = k.sucursal AND b.tipo = 'cierre'
                      AND b.cash_cut_folio = k.c3::bigint::text AND b.caja = k.c2 AND b.business_date = k.c5::date)
 ORDER BY k.c5, k.c2
 LIMIT ${LIM}`;

/**
 * Arqueo de cierre sin la firma de la encargada (`validado_at IS NULL`), 7 días.
 * ⛔ Sin importe: esta pantalla la ve TODA la sucursal (AB.46) y el arqueo es ciego; lo contado por
 * una cajera no se le enseña a las demás.
 * Quien contó, por nombre: el usuario de la Suite (como `cortes-sucursales`) o el catálogo de Wincaja; si
 * ninguno lo conoce, su clave.
 */
export const SQL_ARQUEOS_POR_VALIDAR = `
SELECT b.id::text AS clave, COALESCE(b.cash_cut_folio, '')::text AS folio,
       'Caja ' || COALESCE(b.caja, 'sin caja')
         || COALESCE(' · ' || COALESCE(NULLIF(btrim(u.nombre), ''), NULLIF(btrim(pc.nombre), ''), NULLIF(btrim(b.cajero_code), '')), '') AS detalle,
       b.business_date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM reconciliation.blind_counts b
  LEFT JOIN LATERAL (SELECT x.nombre FROM identity.users x
                      WHERE x.tenant_id = b.tenant_id AND upper(x.username) = upper(b.cajero_code) AND x.deleted_at IS NULL
                      LIMIT 1) u ON true
  LEFT JOIN analytics.pos_cashiers pc ON pc.tenant_id = b.tenant_id AND pc.warehouse_code = b.warehouse_code AND pc.cajero_code = btrim(b.cajero_code)
 WHERE b.tenant_id = :t AND b.warehouse_code = :kc AND b.tipo = 'cierre' AND b.validado_at IS NULL
   AND b.business_date >= ${HOY} - 7
 ORDER BY b.business_date, b.caja
 LIMIT ${LIM}`;

export const SQL_CONTEOS = `
SELECT c.id::text AS clave, c.folio::text AS folio, COALESCE(c.ritmo, c.type) AS detalle,
       c.created_at::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM commercial.inventory_counts c
 WHERE c.tenant_id = :t AND c.warehouse_id = :wh AND c.status IN ('open', 'counting', 'review', 'ready_to_reconcile')
 ORDER BY c.created_at
 LIMIT ${LIM}`;

/**
 * `desde` = el momento en que el gasto quedó en ESTE estado: «Días» cuenta lo que lleva esperando a la
 * sucursal, no lo que lleva desde la captura (folio 0008783: decía 66 días y lo devolvieron hace 29).
 * Sin ese momento la fecha queda NULL y los días se pintan «—»: no se rellena con la captura.
 */
const GASTO = (estados: string, desde: string) => `
SELECT e.id::text AS clave, COALESCE(NULLIF(btrim(e.folio_solicitud), ''), 'sin folio') AS folio,
       COALESCE(NULLIF(btrim(e.proveedor), ''), e.solicitante, 'Gasto')
         || COALESCE(' · ' || NULLIF(btrim(e.motivo_rechazo), ''), '') AS detalle,
       (${desde} AT TIME ZONE 'America/Mexico_City')::date AS fecha, e.importe AS monto, count(*) OVER()::int AS total
  FROM finance.expense_proofs e
 WHERE e.tenant_id = :t AND e.sucursal = :suc AND e.status IN (${estados})
 ORDER BY ${desde} NULLS LAST, e.created_at
 LIMIT ${LIM}`;
/** `rechazada` = «Te lo devolvieron, hay que corregirlo» (`expense-capture-links.service.ts`); el rechazo sella `validated_at`. */
export const SQL_GASTOS_DEVUELTOS = GASTO(`'rechazada'`, 'e.validated_at');
/** `aprobada` = aprobado con cotización, espera su factura (`mis-gastos-abiertos.ts`); la firma sella `aprobado_at` (CGA-A.62). */
export const SQL_GASTOS_ESPERAN_FACTURA = GASTO(`'aprobada'`, 'e.aprobado_at');
/** `recibida` / `revision` = lo revisa Finanzas; espera desde la captura. */
export const SQL_GASTOS_EN_REVISION = GASTO(`'recibida', 'revision'`, 'e.created_at');

/** Ticket que espera a la sucursal: resuelto por confirmar, o en pausa esperando al solicitante. Sin confidenciales. */
export const SQL_TICKETS = `
SELECT r.id::text AS clave, r.folio::text AS folio,
       CASE WHEN r.status = 'resuelto' THEN 'Confírmalo: ' ELSE 'Te piden información: ' END || r.title AS detalle,
       COALESCE(r.resolved_at, r.paused_at, r.created_at)::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM servicedesk.requests r
 WHERE r.tenant_id = :t AND r.warehouse_code = :suc AND r.deleted_at IS NULL
   AND NOT COALESCE(r.is_test, false) AND NOT COALESCE(r.confidential, false)
   AND (r.status = 'resuelto' OR (r.status = 'en_espera' AND r.pause_reason = 'solicitante'))
 ORDER BY 3
 LIMIT ${LIM}`;

export const SQL_COTIZACIONES = `
SELECT q.id::text AS clave, q.code::text AS folio, COALESCE(NULLIF(btrim(q.erp_customer_name), ''), NULLIF(btrim(q.contact_name), ''), 'Cliente sin nombre') AS detalle,
       q.quote_date AS fecha, q.total AS monto, count(*) OVER()::int AS total
  FROM commercial.quotes q
 WHERE q.tenant_id = :t AND q.source_branch = :suc AND q.deleted_at IS NULL
   AND q.status = 'draft' AND q.valid_until >= ${HOY}
 ORDER BY q.quote_date, q.code
 LIMIT ${LIM}`;

export const SQL_FICHAS = `
SELECT s.id::text AS clave, COALESCE(NULLIF(btrim(s.sku), ''), NULLIF(btrim(s.ean), ''), 'sin código') AS folio, s.supplier_name AS detalle,
       s.created_at::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM catalog.product_sheets s
 WHERE s.tenant_id = :t AND s.branch_code = :suc AND s.deleted_at IS NULL
   AND s.origin = 'levantamiento' AND s.status IN ('en_captura', 'recapturar')
 ORDER BY s.created_at
 LIMIT ${LIM}`;

// ── De otra área: abierto de la sucursal, lo atiende alguien más ─────────────────────────────

export const SQL_FALTANTES_PISO = `
SELECT f.id::text AS clave, COALESCE(f.sku, f.scanned_code, '')::text AS folio, f.product_name AS detalle,
       f.first_reported_at::date AS fecha, f.est_lost_revenue AS monto, count(*) OVER()::int AS total
  FROM commercial.floor_stockouts f
 WHERE f.tenant_id = :t AND f.warehouse_id = :wh AND f.status IN ('open', 'in_progress')
 ORDER BY f.first_reported_at
 LIMIT ${LIM}`;

/**
 * Foto del momento: la existencia negativa no tiene fecha. Sin revisión viva (`negative_stock_reviews`).
 * ⛔ Por `kepler_code`, NO por `warehouse_id`: la vista agrega `kdil` por sucursal en un CTE, y sólo una
 * constante sobre la columna que viene de ese CTE baja al `GROUP BY`. Por `warehouse_id` agregaba la red
 * entera (36,510 renglones) para quedarse con una sucursal: 130–400 ms → 21–37 ms, mismos totales 9/9.
 */
export const SQL_NEGATIVOS = `
SELECT v.sku::text AS clave, v.sku::text AS folio, COALESCE(p.nombre, v.sku) || ' · ' || v.existencia::text AS detalle,
       NULL::date AS fecha, NULL::numeric AS monto, count(*) OVER()::int AS total
  FROM analytics.v_kepler_negative_stock v
  LEFT JOIN public.products p ON p.id = v.product_id
 WHERE v.tenant_id = :t AND v.kepler_code = :kc
   AND NOT EXISTS (SELECT 1 FROM commercial.negative_stock_reviews r
                    WHERE r.tenant_id = v.tenant_id AND r.warehouse_id = v.warehouse_id AND r.sku = v.sku AND r.deleted_at IS NULL)
 ORDER BY v.existencia
 LIMIT ${LIM}`;

export const SQL_DOMICILIO = `
SELECT d.id::text AS clave, d.folio::text AS folio, d.customer_name AS detalle,
       d.created_at::date AS fecha, d.value AS monto, count(*) OVER()::int AS total
  FROM commercial.home_deliveries d
 WHERE d.tenant_id = :t AND d.kepler_warehouse_code = :kc AND d.deleted_at IS NULL AND d.status = 'pendiente'
 ORDER BY d.created_at
 LIMIT ${LIM}`;
