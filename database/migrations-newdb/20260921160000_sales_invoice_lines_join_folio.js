/**
 * TK.6 — `analytics.erp_sales_invoice_lines` deja de hacer 87,000 búsquedas de índice para
 * traer los renglones de UN documento.
 *
 * ── El síntoma ────────────────────────────────────────────────────────────────────────────
 * "La vista previa tarda mucho al escoger un ticket". Medido contra prod (solo lectura), el
 * detalle de un documento:
 *
 *   mostrador (erp_sale_ticket_lines)          0.35 ms   ← vuela
 *   factura   (erp_sales_invoices)           483    ms
 *   factura   (erp_sales_invoice_lines)    2,230    ms   ← acá está
 *
 * ── La causa, leída del plan ──────────────────────────────────────────────────────────────
 * La vista deriva `sucursal`, `doc_prefix` y `folio` de **`l` (kdm2, los renglones)**. Cuando
 * el consumidor filtra por folio, ese predicado sólo puede aplicarse a kdm2. Para kdm1 no hay
 * nada, así que el planeador trae **todas** las cabeceras de la sucursal con esos doctipos
 * (680 filas) y por cada una busca en kdm2 — `Index Searches: 87,344`, leyendo 4.4 GB.
 *
 * ⭐ La `sucursal` SÍ llegaba a kdm1. La diferencia: la sucursal se ata con `btrim()` **en los
 * dos lados**, y eso crea una clase de equivalencia por la que Postgres propaga la constante a
 * ambas ramas. El folio se ataba con `h.c6 = l.c6` **crudo**, y `btrim(l.c6) = '0000343'` no le
 * dice nada de `h.c6`: `btrim` es una función, no entra en la clase de equivalencia. O sea que
 * el arreglo no es un índice nuevo, es dejar que el planeador DEDUZCA lo que ya era cierto.
 *
 * ── Lo que cambia, y por qué es demostrablemente el mismo resultado ───────────────────────
 * Las condiciones nuevas se **AGREGAN**, no reemplazan a ninguna:
 *
 *   + btrim(h.c6) = btrim(l.c6)      (junto a `h.c6 = l.c6`, que se queda)
 *   + h.sucursal  = l.sucursal       (junto a su versión con btrim)
 *   + h.c1        = l.c1             (idem)
 *
 * Una condición extra sólo puede QUITAR filas, nunca agregar. Y no quita ninguna, porque
 * **no hay padding**: medido en prod sobre el universo completo,
 *
 *   kdm1.c6 / sucursal / c1  →  0 filas con espacios de 557,187
 *   kdm2.c6 / sucursal / c1  →  0 filas con espacios de 3,793,955
 *   catalog.products.sku     →  0 de 10,115
 *
 * Con cero padding, `a = b` y `btrim(a) = btrim(b)` son la misma condición. No es un muestreo:
 * es una demostración sobre todas las filas. (Se intentó primero contar las dos formas del
 * JOIN sobre el universo entero y se pasó de los 25 minutos de `statement_timeout`; la
 * pregunta por el padding responde lo mismo y cuesta dos escaneos.)
 *
 * `btrim(p.sku::text)` pasa a `p.sku` por la misma razón, y además porque envolver la columna
 * anula `products_tenant_sku_unique` y obliga a un hash de la tabla entera — el mismo defecto
 * que ya se había corregido en la vista hermana del mostrador (20260918160000).
 *
 * ── Medido, antes → después (prod, mejor de 3 pasadas, filas idénticas en los 5) ──────────
 *   08UD0801-0000023     338 ms →     1 ms
 *   08UD0801-0000022     355 ms →     1 ms
 *   03UD1201-0000343   1,898 ms →   238 ms
 *   06UD0801-0000604   3,214 ms → 1,147 ms
 *   08UD0801-0000024   2,635 ms → 2,924 ms   ← ver abajo
 *
 * ⚠️ **El último NO mejora, y se declara en vez de esconderlo.** En ese documento el ODS ya no
 * es el costo: el plan muestra 13-16 búsquedas de índice y lo que queda es
 * `analytics.v_product_box_factor`, que escanea `catalog.products` (11,259 filas),
 * `product_box_factor` y `product_unit_overrides` y agrega, para servir un puñado de renglones.
 * La diferencia 2,635 vs 2,924 es ruido sobre ese costo, no una regresión de este cambio.
 *
 * ⚠️ **Deuda con nombre:** el detalle del ticket **no usa** `box_factor`, `factor_caja`,
 * `unidad_bulto` ni `unidad_paq` — los paga porque lee la vista compartida, que sí los necesita
 * para `/comercial/documentos` y para la cartera. La salida limpia es que el módulo de tickets
 * lea una vista flaca propia, como ya hace el mostrador con `erp_sale_ticket_lines` (que tiene
 * UN solo consumidor). No se hace en este cambio porque exige comprobar si `kdm1.c5 = kdm2.c5`
 * se sostiene del lado de las facturas —la vista del mostrador ata esa columna y la de facturas
 * no—, y eso es una medición aparte, no un supuesto.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const TASA_IVA = `abs(coalesce(nullif(regexp_replace(l.c17::text,'[^0-9.-]','','g'),'')::numeric,0))/100`;
const TASA_IEPS = `abs(coalesce(nullif(regexp_replace(l.c18::text,'[^0-9.-]','','g'),'')::numeric,0))/100`;
const PRECIO_LISTA = `NULLIF(${money('l.c66')}, 0)`;
const DESC_UNIT = `GREATEST(COALESCE(${PRECIO_LISTA}, ${money('l.c12')}) - ${money('l.c12')}, 0)`;

/**
 * Las 28 columnas VERBATIM de la definición viva (20260921120000): mismo nombre, mismo tipo,
 * mismo orden, para que `CREATE OR REPLACE` no intente dropear nada. Lo único que cambia está
 * abajo del `FROM`.
 */
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
    CASE btrim(l.c3) WHEN 'A' THEN 'abono' ELSE 'cargo' END AS naturaleza,
    ${TASA_IVA}  AS iva_tasa,
    ${TASA_IEPS} AS ieps_tasa
   FROM kepler_ods.kdm2 l
     -- ⭐ Acá está el cambio. Las tres condiciones nuevas son REDUNDANTES por dato (cero
     -- padding, medido) y NO redundantes para el planeador: son las que meten el folio y la
     -- sucursal dentro de la clase de equivalencia, para que la constante del WHERE llegue
     -- también a kdm1 y su índice parcial la pueda usar.
     JOIN kepler_ods.kdm1 h ON btrim(h.sucursal) = btrim(l.sucursal) AND h.sucursal = l.sucursal
       AND btrim(h.c1) = btrim(l.c1) AND h.c1 = l.c1
       AND h.c2 = l.c2 AND h.c3 = l.c3 AND h.c4::integer = l.c4::integer
       AND h.c6 = l.c6 AND btrim(h.c6) = btrim(l.c6)
     LEFT JOIN kepler_ods.kdii k ON btrim(k.sucursal) = btrim(l.sucursal) AND btrim(k.c1) = btrim(l.c8)
     -- ⚠️ p.sku SIN btrim: envolver la columna anula products_tenant_sku_unique y fuerza un
     -- hash de la tabla entera. Medido: 0 de 10,115 SKUs traen espacios. El btrim del lado de
     -- Kepler SI se queda -- ahi el padding es real.
     -- (Sin acentos graves: adentro de un template literal cierran la cadena. Ya paso 5 veces.)
     LEFT JOIN catalog.products p ON p.tenant_id = '${M}'::uuid AND p.sku = btrim(l.c8) AND p.deleted_at IS NULL
     LEFT JOIN analytics.v_product_box_factor bf ON bf.tenant_id = '${M}'::uuid AND bf.product_id = p.id
  WHERE h.c2 = 'U'::text
    AND ((h.c3 = 'D'::text AND (h.c4::integer = ANY (ARRAY[8, 12]))) OR (h.c3 = 'A'::text AND (h.c4::integer = ANY (ARRAY[21, 25, 35]))))
    AND btrim(h.c1) = btrim(h.sucursal)
    AND COALESCE(btrim(l.c11), ''::text) <> 'SER'::text
    AND abs(COALESCE(l.c9::numeric, 0::numeric)) > 0::numeric`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sales_invoice_lines AS ${VIEW}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');

  // El candado de esta migración: la vista tiene que seguir teniendo sus 28 columnas. Si
  // `CREATE OR REPLACE` hubiera corrido contra una definición más nueva con columnas de más,
  // habría fallado sola; lo que esto atrapa es lo contrario -- que alguien recorte la lista al
  // copiarla y los consumidores se queden sin una columna sin que nadie lo note.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='erp_sales_invoice_lines'`);
  if (rows[0].n !== 28) {
    throw new Error(
      `analytics.erp_sales_invoice_lines quedo con ${rows[0].n} columnas, se esperaban 28. ` +
      'Alguna se perdio al recopiar la definicion: revisar contra 20260921120000 antes de seguir.');
  }
  console.log('  ✓ erp_sales_invoice_lines: 28 columnas, JOIN con folio y sucursal deducibles.');
};

/**
 * No-op: el `up` no agrega ni quita columnas, sólo hace deducible lo que ya era cierto. Volver
 * atrás significaría reponer a propósito las 87,000 búsquedas de índice por documento.
 */
exports.down = async function down() {
  console.log('[sales_invoice_lines_join_folio] down: no-op (el cambio es de plan, no de datos)');
};
