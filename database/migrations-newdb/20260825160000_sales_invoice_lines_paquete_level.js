/**
 * AX — expone el nivel PAQUETE de la escalera de unidades de Kepler en la vista de líneas.
 *
 * `erp_sales_invoice_lines` ya trae la unidad de venta (kdii.c11), el bulto (c83) y su factor
 * (c84). Faltaba el nivel intermedio PAQUETE (c80/c81) para poder mostrar la escalera completa
 * caja > paquete > pieza en el anexo. Se LEE de Kepler tal cual (cero fórmula): c80=unidad,
 * c81=piezas por paquete. Verificado 2026-08-25 (42026: c81=10, precio paquete = 10× pieza).
 *
 * Nota de orden: Kepler captura las unidades en factor ascendente → c81 (U2) < c84 (U3), así que
 * c80 es el PAQUETE (intermedio) y c83 el BULTO/CAJA. Ambos factores son contra la base (pieza).
 *
 * DROP+CREATE (cambia el set de columnas). Basado en la vista vigente (20260824140000) + 2 columnas.
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const num = (col) => `NULLIF(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.]','','g'),'')::numeric,0),0)`;
const DOCFILTER = `h.c2='U' AND h.c3='D' AND (h.c4)::int IN (8,12) AND btrim(h.c1)=btrim(h.sucursal)`;

const LINEAS = (withPaq) => `
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
    ${num('k.c84')} AS factor_caja,
    NULLIF(btrim(k.c11::text),'') AS unidad_venta,
    NULLIF(btrim(k.c83::text),'') AS unidad_bulto,${withPaq ? `
    -- nivel PAQUETE (intermedio) leído de Kepler tal cual: c80=unidad, c81=piezas por paquete
    NULLIF(btrim(k.c80::text),'') AS unidad_paq,
    ${num('k.c81')} AS factor_paq,` : ''}
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

exports.up = async function up(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_invoice_lines');
  await knex.raw(LINEAS(true));
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_invoice_lines');
  await knex.raw(LINEAS(false));
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');
};
