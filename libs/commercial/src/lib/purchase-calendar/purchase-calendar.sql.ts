import { branchKeySql } from '@megadulces/platform-core';
import { proveedorPedibleSql } from '../commercial-replenishment/proveedor-no-pedible';

/**
 * `[PQ.3.3]` Calendario de compras — la ACTIVIDAD de Kepler por proveedor y plaza: el testigo de que a
 * un proveedor se le atendió en su fecha (anexo C §10.3).
 *
 * ── Qué cuenta como actividad, y por qué (medido 2026-11-20, pg-prod, sólo lectura) ───────────────
 * Control: la hoja «2026» de Compras marca en verde «se pasó el pedido» y en rojo «no se pasó». Por
 * celda (sucursal-día, jul–nov), con un documento del proveedor a ±3 días:
 *
 *   fuente                                   verde (n=1,382)   rojo (n=312)
 *   OC viva (X-A-35, estatus ≠ C)                 54 %             30 %
 *   OC incluidas las CANCELADAS                   66 %             34 %
 *   OC viva + entrada aplicada (X-A-20)           57 %             34 %
 *   + vale (X-A-37) o requisición (X-A-30)        no suman nada
 *
 * ⇒ Cuenta la **orden de compra aunque se haya cancelado** (cancelarla no deshace que se revisó al
 *   proveedor: 12 puntos del verde son OC canceladas después) y la **entrada aplicada** (la compra
 *   local que no pasa por OC). La requisición y el vale no se leen: no agregan ni un caso.
 *   La fuente de cada fecha viaja con el dato (`oc_cancelada` se puede decir en pantalla).
 *
 * Plaza: la OC lleva la sucursal del servidor de Kepler donde nació (`sucursal`); la entrada, la
 * plaza de origen decodificada del centro de compra (`origen_warehouse_code`, ERP_KEPLER §c12) o, sin
 * ella, su sucursal. El alcance de la regla (corporativo · zona · sucursal) se aplica después, en el
 * dominio, con el mapa de `analytics.v_branch_zone`.
 *
 * Fuentes canónicas, sin copiar nada (regla 1): `analytics.erp_purchase_orders` y
 * `analytics.erp_goods_receipts` (sin las copias de oficinas: `dup_of_folio IS NULL`). Las dos son
 * vistas sin RLS: el tenant se filtra con `current_tenant_id()`, como la vista PQ.3.1.
 *
 * Bindings con nombre (knex): `:hoy` (fecha de México), `:desde` (el inicio de la ventana de rezago),
 * `:desde_entradas` y `:codes` (las claves de proveedor de Kepler).
 *
 * ⏱ Medido en prod (340 claves): la OC cuesta 41 ms con un AÑO completo; la entrada, 1.7 s con un año
 * y 0.36 s con 62 días (la vista decodifica el centro de compra y quita duplicados). Por eso la OC se
 * lee un año (es el ancla de «cada N días») y la entrada sólo desde `:desde_entradas`, que el servicio
 * pone en la ventana de rezago o, si hay una regla «cada N» más larga, en N + 7 días.
 */
export const SQL_ACTIVIDAD_KEPLER = `
WITH act AS (
  SELECT o.proveedor_code AS supplier_code, o.sucursal AS plaza, o.doc_date AS fecha,
         CASE WHEN o.estatus = 'C' THEN 'oc_cancelada' ELSE 'oc' END AS fuente
    FROM analytics.erp_purchase_orders o
   WHERE o.tenant_id = current_tenant_id()
     AND o.proveedor_code = ANY(:codes::text[])
     AND o.doc_date > (:hoy::date - 365) AND o.doc_date <= :hoy::date
  UNION ALL
  SELECT r.proveedor_code, COALESCE(r.origen_warehouse_code, r.sucursal), r.receipt_date, 'entrada'
    FROM analytics.erp_goods_receipts r
   WHERE r.tenant_id = current_tenant_id()
     AND r.dup_of_folio IS NULL
     AND r.proveedor_code = ANY(:codes::text[])
     AND r.receipt_date >= :desde_entradas::date AND r.receipt_date <= :hoy::date
)
SELECT supplier_code,
       plaza,
       COALESCE(array_agg(DISTINCT fecha::text) FILTER (WHERE fecha >= :desde::date), '{}') AS fechas,
       max(fecha)::text AS ultima,
       -- El mismo día: manda la OC viva, luego la entrada, al último la OC cancelada.
       (array_agg(fuente ORDER BY fecha DESC, CASE fuente WHEN 'oc' THEN 0 WHEN 'entrada' THEN 1 ELSE 2 END))[1] AS ultima_fuente
  FROM act
 WHERE supplier_code IS NOT NULL AND plaza IS NOT NULL
 GROUP BY supplier_code, plaza`;

/**
 * Sucursal → zona de compra (`analytics.v_branch_zone`: LP · ZAM · MOR; el CEDIS no tiene zona). El
 * nombre sale de `zona_origen` («La Piedad», como lo captura Compras), no de `zona_nombre` («LA PIEDAD RD»).
 */
export const SQL_SUCURSALES_Y_ZONAS = `
SELECT branch_code, branch_name, branch_short, zona_code,
       CASE WHEN zona_code IS NULL THEN NULL ELSE zona_origen END AS zona_nombre
  FROM analytics.v_branch_zone
 WHERE tenant_id = current_tenant_id()
 ORDER BY branch_code`;

/**
 * `[PQ.3.18]` La compra de 12 meses por proveedor, para el embudo de llenado (anexo C §10.10): monto y número de OC
 * VIVAS (X-A-35, estatus ≠ C; aquí sí se excluyen las canceladas, porque es peso económico y no «se revisó»). La
 * misma ventana de 12 meses que la actividad. Una OC es (sucursal, folio): el folio se repite entre servidores.
 * Bindings con nombre: `:hoy` y `:codes`. Medido en prod el 2026-11-22: 340 claves, 10,382 OC.
 */
export const SQL_COMPRA_DOCE_MESES = `
SELECT o.proveedor_code AS supplier_code,
       COALESCE(sum(o.monto) FILTER (WHERE o.estatus <> 'C'), 0)::float8 AS monto,
       count(DISTINCT (o.sucursal, o.folio)) FILTER (WHERE o.estatus <> 'C')::int AS ocs
  FROM analytics.erp_purchase_orders o
 WHERE o.tenant_id = current_tenant_id()
   AND o.proveedor_code = ANY(:codes::text[])
   AND o.doc_date > (:hoy::date - 365) AND o.doc_date <= :hoy::date
 GROUP BY 1`;

/**
 * `[PQ.3.24]` Los canales de COMPRA activos (proveedor × sucursal) con la fecha que propone el ciclo de Kepler, para
 * los proveedores SIN regla del aviso de Pedido (anexo C §10.16, DC35). Las MISMAS condiciones que el KPI de
 * `worklist` (`commercial-replenishment.service.ts`), que es lo que decía el aviso hasta hoy: vía compra, con
 * cadencia, activo (entregó dentro de 2×cadencia o de 60 días) y proveedor pedible (`[PQ.145]`). La sucursal sale de
 * `branchKeySql` (la misma llave del alcance). Bindings con nombre: `:hoy` y `:almacenes` (uuid[] o NULL = todos).
 * Medido en prod el 2026-11-25: 233 proveedores con ciclo por canal; 121 vencidos y 22 de hoy contando TODOS.
 */
export const SQL_CANALES_CICLO = `
SELECT rc.supplier_id::text AS supplier_id,
       nullif(btrim(sup.code), '') AS supplier_code,
       CASE WHEN (${branchKeySql('w')}) ~ '^[0-9]{2}$' THEN (${branchKeySql('w')}) END AS plaza,
       to_char(rc.next_due_date, 'YYYY-MM-DD') AS proxima
  FROM commercial.replenishment_channel rc
  JOIN commercial.warehouses w ON w.tenant_id = rc.tenant_id AND w.id = rc.warehouse_id
  LEFT JOIN catalog.suppliers sup ON sup.tenant_id = rc.tenant_id AND sup.id = rc.supplier_id
 WHERE rc.tenant_id = current_tenant_id()
   AND rc.via = 'purchase'
   AND rc.cadence_days IS NOT NULL
   AND rc.next_due_date IS NOT NULL
   AND rc.last_delivery_date >= :hoy::date - GREATEST(rc.cadence_days * 2, 60)::int
   AND ${proveedorPedibleSql('sup')}
   AND (:almacenes::uuid[] IS NULL OR rc.warehouse_id = ANY(:almacenes::uuid[]))`;

/**
 * `[PQ.3.29]` La REQUISICIÓN DE COMPRA de la Suite como actividad del calendario (anexo C §10.18, DC40: cuenta desde que
 * se crea). No es la requisición de Kepler (X-A-30, que «no suma nada» arriba): es la que arma Pedido, y lo que la hace
 * útil es que dice A DÓNDE va cada renglón (`destination_warehouse_id`).
 *
 * Medido en prod el 2026-11-25: la compra se concentra —6 de cada 10 requisiciones (253 de 425 en 30 días) llevan
 * renglones a otra sucursal que la que emite—, así que la OC de Kepler nace en la sucursal que emite y el calendario no
 * la veía en la sucursal de la regla. Ese día Compras marcó a mano 4 sucursales de un proveedor «se pidió fuera de
 * Kepler» («sí se pasó en la Suite pero no lo marcó»), y las 4 marcas de 30 días tenían su requisición.
 *
 * Cuenta: requisición de COMPRA (sin almacén origen), en cualquier estado menos `draft` y `cancelled`, el día en que se
 * creó (hora de México), en la sucursal destino de cada renglón de compra (sin destino, la que emite). La clave del
 * proveedor es la de su ficha; `supplier_id` viaja para casar con la ficha de Pedido que resolvió la regla (R5).
 * Bindings con nombre: `:hoy`, `:desde`, `:codes` (claves de Kepler) y `:fichas` (ids de ficha de Pedido).
 */
export const SQL_REQUISICIONES_SUITE = `
WITH req AS (
  SELECT DISTINCT pr.supplier_id::text AS supplier_id,
         nullif(btrim(s.code), '') AS supplier_code,
         (${branchKeySql('dw')}) AS plaza,
         (pr.created_at AT TIME ZONE 'America/Mexico_City')::date AS fecha
    FROM commercial.purchase_requisitions pr
    JOIN commercial.purchase_requisition_lines l ON l.tenant_id = pr.tenant_id AND l.requisition_id = pr.id
    JOIN commercial.warehouses dw ON dw.tenant_id = pr.tenant_id AND dw.id = COALESCE(l.destination_warehouse_id, pr.warehouse_id)
    LEFT JOIN catalog.suppliers s ON s.tenant_id = pr.tenant_id AND s.id = pr.supplier_id
   WHERE pr.tenant_id = current_tenant_id()
     AND pr.source_warehouse_id IS NULL
     AND l.source_warehouse_id IS NULL
     AND pr.estado NOT IN ('draft', 'cancelled')
     AND (pr.created_at AT TIME ZONE 'America/Mexico_City')::date BETWEEN :desde::date AND :hoy::date
     AND (s.code = ANY(:codes::text[]) OR pr.supplier_id::text = ANY(:fichas::text[]))
)
SELECT supplier_id, supplier_code, plaza,
       array_agg(DISTINCT fecha::text) AS fechas,
       max(fecha)::text AS ultima
  FROM req
 WHERE plaza ~ '^[0-9]{2}$'
 GROUP BY supplier_id, supplier_code, plaza`;
