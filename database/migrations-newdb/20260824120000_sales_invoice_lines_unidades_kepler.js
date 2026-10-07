/**
 * Fase AX — corrección de UNIDADES: la vista de líneas expone las unidades REALES de Kepler.
 *
 * Censo 90d (U/D/8,12): las líneas se venden en PAQ/PZA/KG y también **500, 250, 2KG, CUB, 400**
 * (presentaciones por gramaje/cubeta). Además el BULTO del catálogo es `kdii.c83` y NO siempre
 * es caja: KG×**BTO** (552 SKUs), PAQ×CJA (7,982), PZA×CJA (3,970), 500×CJA (185)…
 *
 * La capa de arriba (PDF/pantalla) traducía con un mapa fijo {CJA,PAQ,PZA,KG} → pluralizaba
 * "500"→"500s" y "CUB"→"cubs" (unidades INVENTADAS) y rotulaba "paq. por caja" aunque el bulto
 * fuera BTO. Regla de Edgar (2026-08-24): cero unidades inventadas, todo de las tablas Kepler.
 *
 * Cambio: `erp_sales_invoice_lines` agrega
 *   - `unidad_venta` = kdii.c11 (unidad de venta del catálogo)
 *   - `unidad_bulto` = kdii.c83 (unidad del bulto; NULL si no está capturada)
 * y el consumidor muestra los códigos VERBATIM. La equivalencia (cantidad/factor) solo aplica
 * cuando la unidad de la línea coincide con la del catálogo (93 líneas/90d no coinciden).
 *
 * DROP+CREATE (no OR REPLACE) porque cambia el set de columnas; nadie depende de la vista.
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const DOCFILTER = `h.c2='U' AND h.c3='D' AND (h.c4)::int IN (8,12) AND btrim(h.c1)=btrim(h.sucursal)`;

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_sales_invoice_lines`);
  await knex.raw(`
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
      -- unidades del CATÁLOGO, verbatim de Kepler (para rotular sin inventar):
      NULLIF(btrim(k.c11::text),'') AS unidad_venta,
      NULLIF(btrim(k.c83::text),'') AS unidad_bulto,
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
    WHERE ${DOCFILTER}
      AND coalesce(btrim(l.c11::text),'') <> 'SER'
      AND abs(coalesce((l.c9)::numeric,0)) > 0`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');
};

exports.down = async function down(knex) {
  // vuelve a la forma de 20260822140000 (sin unidad_venta/unidad_bulto)
  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_sales_invoice_lines`);
  await knex.raw(`
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
    WHERE ${DOCFILTER}
      AND coalesce(btrim(l.c11::text),'') <> 'SER'
      AND abs(coalesce((l.c9)::numeric,0)) > 0`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');
};
