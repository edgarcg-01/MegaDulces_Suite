/**
 * Fase TK.0b — El precio de lista y el descuento del renglón, también para `U-D-8` / `U-D-12`.
 *
 * La vista hermana `analytics.erp_sale_ticket_lines` (mig 20260918160000) estrena el decode de
 * **`kdm2.c66` = precio de lista de la unidad base**. Telemarketing y crédito salen de la MISMA
 * tabla `kdm2` y traen la misma columna, así que el decode no se copia a otra vista: se le
 * agregan las tres columnas a la que ya existe. Es aditivo — `CREATE OR REPLACE VIEW` sólo
 * admite columnas AL FINAL, y ahí van, después de `computed_at`.
 *
 * Medido en `platform_test` (ventana de 20 días, unidad BASE, que es donde
 * `cantidad × precio = importe` cierra exacto):
 *
 *   doctype            renglones   cobran lista   con descuento   cobran de más
 *   U-D-8  telemkt         1,175          615           549           8 (0.68%)
 *   U-D-12 crédito           569          386           180           3 (0.53%)
 *
 * ⚠️ **ESTO NO ES EL DESCUENTO QUE YA CALCULA EL ANEXO, Y NO LO REEMPLAZA.** Son dos capas
 * distintas que conviven, y se comprobó que una NO explica a la otra: de 609 documentos
 * `U-D-8`, sólo 172 cuadran entre el descuento de cabecera (`kdm1.c13`, con su % en `c19`) y
 * la suma del descuento de renglón; 435 difieren en más de $1, con error medio de **$183**.
 *
 *   · `descuento_linea`  (ACÁ)  = precio de lista − precio cobrado. Descuento **de precio**.
 *   · `kdm1.c13`         (anexo) = descuento **comercial del documento**, que baja el total.
 *
 * `CommercialSalesDocumentsService.derivar()` sigue repartiendo el segundo a prorrata para que
 * la columna NETO sume exacto el total del CFDI; eso NO se toca. Estas columnas son un dato
 * nuevo al lado, que sólo consume el módulo de Tickets. Quien lea la vista por nombre de
 * columna no se entera de que existen.
 *
 * Base: la definición VIVA de la vista (`pg_get_viewdef`), no la migración original —
 * `20260824120000` y `20260825160000` ya la reescribieron. Si alguien la vuelve a reemplazar,
 * tiene que arrastrar estas tres columnas o la pantalla de Tickets se queda sin el descuento
 * de mayoreo.
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
/**
 * ⚠️ `NULL`, no `0`, cuando falta — ver la explicación larga en la vista hermana
 * (`20260918160000`). En corto: **`kdm2.c66` no existe antes del 2026-08-13**. Un `0` ahí se
 * leería como "no costaba nada" en un documento que cobró dinero; `NULL` dice "no sé con qué
 * precio se comparaba", que es la verdad, y obliga al consumidor a declararlo.
 */
const PRECIO_LISTA = `NULLIF(${money('l.c66')}, 0)`;
// Nunca negativo: donde el cobrado supera al de lista no hay descuento que presumir (ADR-056).
const DESC_UNIT = `GREATEST(COALESCE(${PRECIO_LISTA}, ${money('l.c12')}) - ${money('l.c12')}, 0)`;

/**
 * Tasas de impuesto por renglon, iguales que en la vista hermana (20260918160000, que trae la
 * explicacion larga). En corto: `kdm2.c17` = IVA, `c18` = IEPS, Kepler las guarda negativas y
 * sobre 100, y **nunca coinciden en el mismo renglon** (0 de 123,203 medidos). Se publica la
 * TASA, no el importe: el importe exige prorratear antes el descuento del documento, y eso es
 * aritmetica de documento -- justo lo que mas pesa aca, porque 414 de 919 facturas de
 * telemarketing traen descuento comercial.
 */
const TASA_IVA = `abs(coalesce(nullif(regexp_replace(l.c17::text,'[^0-9.-]','','g'),'')::numeric,0))/100`;
const TASA_IEPS = `abs(coalesce(nullif(regexp_replace(l.c18::text,'[^0-9.-]','','g'),'')::numeric,0))/100`;

const VIEW = `
  SELECT '${M}'::uuid AS tenant_id,
    btrim(l.sucursal) AS sucursal,
    ('UD'::text || lpad(l.c4::integer::text, 2, '0'::text)) || lpad(l.c5::integer::text, 2, '0'::text) AS doc_prefix,
    btrim(l.c6) AS folio,
    ((((btrim(l.sucursal) || 'UD'::text) || lpad(l.c4::integer::text, 2, '0'::text)) || lpad(l.c5::integer::text, 2, '0'::text)) || '-'::text) || btrim(l.c6) AS folio_digital,
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
    -- ── TK.0b, columnas nuevas (siempre al final) ──────────────────────────
    ${PRECIO_LISTA} AS precio_lista,
    ${DESC_UNIT} AS descuento_unitario,
    round(${DESC_UNIT} * abs(COALESCE(l.c9::numeric, 0::numeric)), 2) AS descuento_linea,
    ${TASA_IVA}  AS iva_tasa,
    ${TASA_IEPS} AS ieps_tasa
   FROM kepler_ods.kdm2 l
     JOIN kepler_ods.kdm1 h ON btrim(h.sucursal) = btrim(l.sucursal) AND btrim(h.c1) = btrim(l.c1) AND h.c2 = l.c2 AND h.c3 = l.c3 AND h.c4::integer = l.c4::integer AND h.c6 = l.c6
     LEFT JOIN kepler_ods.kdii k ON btrim(k.sucursal) = btrim(l.sucursal) AND btrim(k.c1) = btrim(l.c8)
     LEFT JOIN catalog.products p ON p.tenant_id = '${M}'::uuid AND btrim(p.sku::text) = btrim(l.c8) AND p.deleted_at IS NULL
     LEFT JOIN analytics.v_product_box_factor bf ON bf.tenant_id = '${M}'::uuid AND bf.product_id = p.id
  WHERE h.c2 = 'U'::text AND h.c3 = 'D'::text AND (h.c4::integer = ANY (ARRAY[8, 12])) AND btrim(h.c1) = btrim(h.sucursal) AND COALESCE(btrim(l.c11), ''::text) <> 'SER'::text AND abs(COALESCE(l.c9::numeric, 0::numeric)) > 0::numeric`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sales_invoice_lines AS ${VIEW}`);
  // El GRANT sobrevive a un REPLACE (es el mismo objeto), pero se re-aplica igual: en este
  // repo ya se perdió una vez al recrear una vista y sólo lo cachó la aserción de metadata.
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');
};

/**
 * Quitar columnas de una vista NO lo permite `CREATE OR REPLACE`: hay que dropearla, y eso
 * falla si alguien depende de ella. Se deja el no-op — tres columnas de más no le hacen daño
 * a ningún consumidor (todos seleccionan por nombre) y dropear la vista en un rollback dejaría
 * sin facturas a `/comercial/documentos`, que es lo que ese rollback quería proteger.
 */
exports.down = async function down() {
  console.log('[erp_sales_invoice_lines_precio_lista] down: no-op (quitar columnas exigiría DROP VIEW)');
};
