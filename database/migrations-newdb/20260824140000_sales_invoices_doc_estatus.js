/**
 * Fase AX — estatus del documento (`kdm1.c43`) + la RELACIÓN DE EMPAQUE CANÓNICA.
 *
 * (2) EMPAQUE — `analytics.v_product_box_factor` es el resolvedor canónico único
 * (RA-PRO.38: "TODOS los reportes deben leer" — se creó justo porque cada reporte derivaba
 * su propia precedencia y el mismo SKU mostraba cajas distintas). El anexo leía `kdii.c84`
 * crudo, o sea era otra derivación más. Medido en prod (2026-08-24):
 *   · **212 líneas en 195 facturas** imprimían una equivalencia que CONTRADICE al canónico
 *     — casi todas granel (CHOC GRANEL 9KG, GOMA GRANEL 12KG, MAIZ PALOMERO 20KG…) donde un
 *     humano puso `override box_factor=1` porque c84 ahí son KILOS por bulto, no piezas.
 *   · **13,935 líneas** escondían una equivalencia que el canónico sí resuelve (etiquetera /
 *     factor_sale / override) porque c84 venía en 1 o NULL en esa sucursal.
 *   · 102 líneas marcadas `is_master_suspect` (c84 parece pallet, no caja).
 * La vista ahora expone `box_factor` (canónico) + `box_factor_source` + `box_factor_dudoso`,
 * y deja `factor_caja` (c84 verbatim) sólo para trazabilidad. El consumidor muestra el canónico.
 *
 * (1) ESTATUS del documento — `kdm1.c43`:
 *
 * Hallazgo del barrido total (5,501 facturas, 2026-08-24): **280 facturas con total $0** se
 * estaban listando como ventas, y 15 de ellas **conservan sus renglones de producto**
 * ($49,186.46), así que el anexo mostraba mercancía por $43,904 con un total de $0.
 *
 * Decode de `kdm1.c43` — separación perfecta, sin un solo solapamiento:
 *   'N' 4,947 docs · $19,160,061 · ninguna en $0   (vigente)
 *   'C'   280 docs · $0          · TODAS en $0      → **cancelada**
 *   'R'   181 docs · $782,090
 *   'F'    93 docs · $65,580
 * Sólo se decodifica 'C' (es lo que la evidencia soporta); el resto viaja verbatim en
 * `doc_estatus` para que el consumidor decida sin que la vista invente semántica.
 *
 * La vista sigue siendo el espejo fiel (no se filtran las canceladas acá): el filtro vive en
 * el service, que las excluye del listado y le niega el PDF.
 *
 * DROP+CREATE: cambia el set de columnas. Recrea también la vista de líneas porque depende
 * del DROP en cascada del orden de creación original.
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const DOCFILTER = `h.c2='U' AND h.c3='D' AND (h.c4)::int IN (8,12) AND btrim(h.c1)=btrim(h.sucursal)`;

const CABECERA = (extra) => `
  CREATE VIEW analytics.erp_sales_invoices AS
  SELECT
    '${M}'::uuid AS tenant_id,
    q.sucursal, w.id AS warehouse_id,
    q.doc_prefix, q.doc_tipo, q.doc_label, q.folio,
    q.sucursal || q.doc_prefix || '-' || q.folio AS folio_digital,
    q.fecha,
    (q.fecha + (COALESCE(NULLIF(q.dias_credito,0),1) || ' days')::interval)::date AS vencimiento,
    q.dias_credito, q.limite_credito,
    q.cliente_code, q.cliente_nombre, q.cliente_rfc,
    q.cliente_domicilio, q.cliente_colonia, q.cliente_estado, q.cliente_cp,
    q.vendedor_code, q.vendedor_nombre,
    q.canal, q.referencia, q.doc_origen,
    q.total, q.ieps, q.descuento, q.descuento_pct,
    round(q.total - q.ieps + q.descuento, 2) AS subtotal,
    ${extra}
    'md_' || q.sucursal AS source_branch, now() AS computed_at
  FROM (
    SELECT DISTINCT ON (btrim(h.sucursal), (h.c4)::int, (h.c5)::int, btrim(h.c6::text))
      btrim(h.sucursal) AS sucursal,
      'UD' || lpad((h.c4)::int::text,2,'0') || lpad((h.c5)::int::text,2,'0') AS doc_prefix,
      CASE (h.c4)::int WHEN 8 THEN 'telemarketing' ELSE 'credito' END AS doc_tipo,
      CASE (h.c4)::int WHEN 8 THEN 'Factura Telemarketing' ELSE 'Venta a crédito' END AS doc_label,
      btrim(h.c6::text) AS folio,
      h.c9::date AS fecha,
      NULLIF(btrim(h.c10::text),'') AS cliente_code,
      NULLIF(btrim(h.c32::text),'') AS cliente_nombre,
      NULLIF(btrim(h.c22::text),'') AS cliente_rfc,
      NULLIF(btrim(h.c33::text),'') AS cliente_domicilio,
      NULLIF(btrim(h.c34::text),'') AS cliente_colonia,
      NULLIF(btrim(h.c35::text),'') AS cliente_estado,
      NULLIF(btrim(u.c27::text),'') AS cliente_cp,
      NULLIF(btrim(h.c12::text),'') AS vendedor_code,
      NULLIF(btrim(v.c3::text),'')  AS vendedor_nombre,
      NULLIF(btrim(h.c27::text),'') AS canal,
      NULLIF(btrim(h.c11::text),'') AS referencia,
      NULLIF(btrim(h.c43::text),'') AS doc_estatus,
      CASE WHEN NULLIF(btrim(h.c39::text),'') IS NULL THEN NULL
           ELSE 'UD' || lpad((h.c37)::int::text,2,'0') || lpad((h.c38)::int::text,2,'0')
                || '-' || btrim(h.c39::text) END AS doc_origen,
      ${money('h.c16')} AS total,
      ${money('h.c15')} AS ieps,
      ${money('h.c13')} AS descuento,
      coalesce(nullif(regexp_replace(h.c19::text,'[^0-9.]','','g'),'')::numeric,0) AS descuento_pct,
      coalesce(nullif(regexp_replace(u.c16::text,'[^0-9]','','g'),'')::int,0) AS dias_credito,
      ${money('u.c15')} AS limite_credito
    FROM kepler_ods.kdm1 h
    LEFT JOIN kepler_ods.kdud u
      ON btrim(u.sucursal)=btrim(h.sucursal) AND btrim(u.c2::text)=btrim(h.c10::text)
    LEFT JOIN kepler_ods.kduv v
      ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2::text)=btrim(h.c12::text)
    WHERE ${DOCFILTER}
    ORDER BY btrim(h.sucursal), (h.c4)::int, (h.c5)::int, btrim(h.c6::text)
  ) q
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL`;

const LINEAS = `
  CREATE VIEW analytics.erp_sales_invoice_lines AS
  SELECT
    '${M}'::uuid AS tenant_id,
    btrim(l.sucursal) AS sucursal,
    'UD' || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0') AS doc_prefix,
    btrim(l.c6::text) AS folio,
    btrim(l.sucursal) || 'UD' || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0')
      || '-' || btrim(l.c6::text) AS folio_digital,
    (l.c7)::int AS linea,
    btrim(l.c8::text) AS sku,
    NULLIF(btrim(l.c10::text),'') AS descripcion,
    NULLIF(btrim(l.c11::text),'') AS unidad,
    abs(coalesce((l.c9)::numeric,0)) AS cantidad,
    ${money('l.c12')} AS precio_unitario,
    ${money('l.c13')} AS importe,
    NULLIF(coalesce(nullif(regexp_replace(k.c84::text,'[^0-9.]','','g'),'')::numeric,0),0) AS factor_caja,
    NULLIF(btrim(k.c11::text),'') AS unidad_venta,
    NULLIF(btrim(k.c83::text),'') AS unidad_bulto,
    -- RELACION CANONICA de empaque: la misma que leen compras, sell-out y salidas.
    -- factor_caja (arriba) es c84 crudo, solo trazabilidad; lo que se MUESTRA es esto.
    bf.box_factor AS box_factor, bf.source AS box_factor_source,
    coalesce(bf.is_master_suspect, false) AS box_factor_dudoso,
    p.id AS product_id,
    now() AS computed_at
  FROM kepler_ods.kdm2 l
  JOIN kepler_ods.kdm1 h
    ON btrim(h.sucursal)=btrim(l.sucursal) AND btrim(h.c1)=btrim(l.c1)
   AND h.c2=l.c2 AND h.c3=l.c3 AND (h.c4)::int=(l.c4)::int AND h.c6=l.c6
  LEFT JOIN kepler_ods.kdii k
    ON btrim(k.sucursal)=btrim(l.sucursal) AND btrim(k.c1::text)=btrim(l.c8::text)
  LEFT JOIN catalog.products p
    ON p.tenant_id='${M}'::uuid AND btrim(p.sku)=btrim(l.c8::text) AND p.deleted_at IS NULL
  LEFT JOIN analytics.v_product_box_factor bf
    ON bf.tenant_id='${M}'::uuid AND bf.product_id = p.id
  WHERE ${DOCFILTER}
    AND coalesce(btrim(l.c11::text),'') <> 'SER'
    AND abs(coalesce((l.c9)::numeric,0)) > 0`;

async function recrear(knex, extraCabecera) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_invoice_lines');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_invoices');
  await knex.raw(CABECERA(extraCabecera));
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoices TO app_runtime');
  await knex.raw(LINEAS);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');
}

exports.up = async function up(knex) {
  await recrear(knex, `q.doc_estatus,
    (q.doc_estatus = 'C') AS cancelada,`);
};

exports.down = async function down(knex) {
  await recrear(knex, '');
};
