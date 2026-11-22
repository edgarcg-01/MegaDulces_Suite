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
