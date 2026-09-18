/**
 * CXC.SKU.1 (reconciliación) — `analytics.erp_sales_invoice_lines` gana el lado ABONO
 * (notas de crédito / devoluciones) + la columna `naturaleza`, SIN perder `precio_lista` /
 * `descuento_unitario` / `descuento_linea` de #117 (mig 20260918160100).
 *
 * ── Por qué esta migración existe (medido en prod, 2026-09-18) ────────────────────────────
 * El widening del lado abono nació dentro de `20260918120000_sales_lines_widen_abonos.js`, que
 * redefinía la vista con 23 columnas (base 22 + `naturaleza`), SIN las tres columnas de precio
 * de lista que #117 ya había agregado. Las dos migraciones redefinían la MISMA vista sin las
 * columnas de la otra → `CREATE OR REPLACE ... cannot drop columns from view`, en cualquier
 * orden. En el árbol del autor 120000 corre antes que 160100; en prod se aplicó 160100 primero.
 *
 * La solución durable: UNA sola migración —ésta, la de timestamp más alto, que corre AL FINAL—
 * es la dueña de la definición combinada. 120000 quedó sólo con sus objetos nuevos (los índices
 * de abono + la vista flaca `erp_sales_line_search`); 160100 no se toca. Así converge tanto en
 * prod (donde 160100 ya está aplicada) como en un `migrate:latest` fresco (120000 → 160100 →
 * ésta), porque ésta siempre tiene la última palabra.
 *
 * ── La definición combinada: 26 columnas ─────────────────────────────────────────────────
 * Se parte VERBATIM de la definición viva de 160100 (25 columnas, terminando en
 * `descuento_linea`) para garantizar que las columnas 1..25 conserven nombre/tipo/orden — así
 * `CREATE OR REPLACE` sólo AGREGA `naturaleza` al final (col 26) y no intenta dropear nada, que
 * es justo lo que rompía. Los tres cambios respecto de 160100:
 *   1. `doc_prefix` / `folio_digital` pasan a ser DINÁMICOS ('U' || c3 || …) para que el lado
 *      abono traiga su prefijo real (UA21/UA25/UA35). Para el lado cargo el valor es idéntico
 *      al de antes ('UD08'/'UD12') — cambiar la EXPRESIÓN de una columna existente sí lo permite
 *      `CREATE OR REPLACE`, mientras el nombre y el tipo (text) no cambien.
 *   2. El WHERE se ensancha: `(c3='D' IN 8,12) OR (c3='A' IN 21,25,35)`.
 *   3. Se agrega `naturaleza` ('abono' | 'cargo') como última columna.
 *
 * ⚠️ `cantidad` es `abs(...)`: en una devolución el signo vive en `naturaleza`, no en el número.
 * ⚠️ `precio_lista`/`descuento_*` degradan a NULL/0 en el lado abono (kdm2.c66 no aplica ahí);
 *    son un dato del lado cargo (telemarketing/crédito), inofensivo para las notas de crédito.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
// NULL, no 0, cuando falta: kdm2.c66 no existe antes del 2026-08-13 (ver 20260918160100).
const PRECIO_LISTA = `NULLIF(${money('l.c66')}, 0)`;
// Nunca negativo: donde el cobrado supera al de lista no hay descuento que presumir.
const DESC_UNIT = `GREATEST(COALESCE(${PRECIO_LISTA}, ${money('l.c12')}) - ${money('l.c12')}, 0)`;

const VIEW = `
  SELECT '${M}'::uuid AS tenant_id,
    btrim(l.sucursal) AS sucursal,
    (('U'::text || btrim(l.c3)) || lpad(l.c4::integer::text, 2, '0'::text)) || lpad(l.c5::integer::text, 2, '0'::text) AS doc_prefix,
    btrim(l.c6) AS folio,
    ((((((btrim(l.sucursal) || 'U'::text) || btrim(l.c3)) || lpad(l.c4::integer::text, 2, '0'::text)) || lpad(l.c5::integer::text, 2, '0'::text)) || '-'::text) || btrim(l.c6)) AS folio_digital,
    l.c7::integer AS linea,
    btrim(l.c8) AS sku,
    NULLIF(btrim(l.c10), ''::text) AS descripcion,
    NULLIF(btrim(l.c11), ''::text) AS unidad,
    abs(COALESCE(l.c9::numeric, 0::numeric)) AS cantidad,
    round(COALESCE(NULLIF(regexp_replace(l.c12::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS precio_unitario,
    round(COALESCE(NULLIF(regexp_replace(l.c13::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS importe,
    NULLIF(COALESCE(NULLIF(regexp_replace(k.c84::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 0::numeric) AS factor_caja,
    NULLIF(btrim(k.c11), ''::text) AS unidad_venta,
    NULLIF(btrim(k.c83), ''::text) AS unidad_bulto,
    NULLIF(btrim(k.c80), ''::text) AS unidad_paq,
    NULLIF(COALESCE(NULLIF(regexp_replace(k.c81::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 0::numeric) AS factor_paq,
    bf.box_factor,
    bf.source AS box_factor_source,
    COALESCE(bf.is_master_suspect, false) AS box_factor_dudoso,
    p.id AS product_id,
    now() AS computed_at,
    ${PRECIO_LISTA} AS precio_lista,
    ${DESC_UNIT} AS descuento_unitario,
    round(${DESC_UNIT} * abs(COALESCE(l.c9::numeric, 0::numeric)), 2) AS descuento_linea,
    CASE btrim(l.c3) WHEN 'A' THEN 'abono' ELSE 'cargo' END AS naturaleza
   FROM kepler_ods.kdm2 l
     JOIN kepler_ods.kdm1 h ON btrim(h.sucursal) = btrim(l.sucursal) AND btrim(h.c1) = btrim(l.c1) AND h.c2 = l.c2 AND h.c3 = l.c3 AND h.c4::integer = l.c4::integer AND h.c6 = l.c6
     LEFT JOIN kepler_ods.kdii k ON btrim(k.sucursal) = btrim(l.sucursal) AND btrim(k.c1) = btrim(l.c8)
     LEFT JOIN catalog.products p ON p.tenant_id = '${M}'::uuid AND btrim(p.sku::text) = btrim(l.c8) AND p.deleted_at IS NULL
     LEFT JOIN analytics.v_product_box_factor bf ON bf.tenant_id = '${M}'::uuid AND bf.product_id = p.id
  WHERE h.c2 = 'U'::text
    AND ((h.c3 = 'D'::text AND (h.c4::integer = ANY (ARRAY[8, 12]))) OR (h.c3 = 'A'::text AND (h.c4::integer = ANY (ARRAY[21, 25, 35]))))
    AND btrim(h.c1) = btrim(h.sucursal)
    AND COALESCE(btrim(l.c11), ''::text) <> 'SER'::text
    AND abs(COALESCE(l.c9::numeric, 0::numeric)) > 0::numeric`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sales_invoice_lines AS ${VIEW}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');
};

/**
 * Quitar `naturaleza` exigiría DROP VIEW (CREATE OR REPLACE no saca columnas), y eso dejaría sin
 * facturas a `/comercial/documentos` mientras se recrea. No-op, como el down de 160100: tres/una
 * columna(s) de más no le hacen daño a ningún consumidor (todos seleccionan por nombre).
 */
exports.down = async function down() {
  console.log('[erp_sales_invoice_lines_abono_naturaleza] down: no-op (quitar columnas exigiría DROP VIEW)');
};
