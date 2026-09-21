/**
 * TK.4 — las tasas de IVA e IEPS POR RENGLON, en las dos vistas de venta:
 * `analytics.erp_sale_ticket_lines` (mostrador) y `analytics.erp_sales_invoice_lines`
 * (telemarketing / credito / abonos).
 *
 * ── Por que esta migracion existe, y no un edit de 160000 / 160100 ────────────────────────
 * El primer intento agregaba las dos columnas EDITANDO `20260918160000` y `20260918160100`.
 * Rebotado en revision, con dos fallas medidas — las dos reales:
 *
 *  1. ⛔ **En prod las columnas nunca habrian aparecido.** Esas dos migraciones ya corrieron
 *     (lotes 464 y 465). Knex las ve en `public.knex_migrations` y las SALTA: editar el `up()`
 *     de una migracion aplicada no la re-corre. El codigo se habria desplegado consultando
 *     columnas inexistentes. ⚠️ Y el sintoma no habria sido un error ruidoso: la consulta de
 *     renglones usa `select *`, asi que una columna ausente llega `undefined`, se lee como
 *     tasa 0 y el desglose sale en ceros — exactamente la mentira que el arbitro de esta fase
 *     existe para impedir. (El arbitro contra la cabecera lo habria atrapado y omitido las
 *     columnas, pero por el motivo equivocado: "Kepler no cuadra" en vez de "falta la mig".)
 *
 *  2. ⛔ **Choque en un `migrate:latest` fresco** con `20260918200000_..._abono_naturaleza`,
 *     que desde esta semana es el UNICO dueno de la definicion combinada de
 *     `erp_sales_invoice_lines` (26 columnas) y corre DESPUES de 160100. Con las dos columnas
 *     metidas en 160100, el orden fresco daba 160100 (27 cols) → 200000 (26 cols) →
 *     `cannot drop columns from view`. En prod no se veia porque 160100 ya estaba aplicada.
 *
 * La regla que sale de esto, y que ya es la del repo (ver la cabecera de 200000): **una vista
 * se modifica hacia adelante, con una migracion nueva de timestamp mas alto, que pasa a ser su
 * dueña.** Esta es ahora la ultima palabra sobre las dos vistas.
 *
 * ── Por que las columnas van AL FINAL ────────────────────────────────────────────────────
 * `CREATE OR REPLACE VIEW` sabe AGREGAR columnas al final y no sabe hacer nada mas: no puede
 * quitarlas, ni reordenarlas, ni insertar en medio. El primer intento las metia antes de
 * `product_id` / `computed_at` en los renglones del ticket — sirve para un `CREATE` fresco y
 * revienta contra la vista ya viva. Aca van al final, detras de `computed_at` (ticket) y de
 * `naturaleza` (facturas). Ningun consumidor selecciona por posicion.
 *
 * ── Que se mide y por que se publica la TASA y no el importe ─────────────────────────────
 * ⭐⭐ `kdm2.c17` = tasa de IVA, `c18` = tasa de IEPS. Kepler las guarda NEGATIVAS y sobre 100.
 * Medido en prod (solo lectura) sobre 116,411 renglones de mostrador de 10 dias: `c17` toma
 * exactamente {0, -16} y `c18` {0, -8}.
 *
 * ⭐ **IVA e IEPS NUNCA coinciden en el mismo renglon**: 0 de 123,203 renglones, en los tres
 * doctipos (mostrador 0/116,411 · telemarketing 0/2,898 · credito 0/3,894). Un producto lleva
 * uno u otro. Por eso el ticket puede darse el lujo de UNA columna rotulada en vez de dos, y
 * por eso el orden de la cascada fiscal (IEPS primero, IVA sobre base+IEPS) da lo mismo que la
 * version plana — se comprobaron las dos y devuelven identico.
 *
 * ⚠️ Si algun dia un renglon trae las dos, el consumidor tiene que aplicar la CASCADA
 * (base * (1+ieps) * (1+iva)), que es el orden fiscal mexicano, no sumarlas planas. El servicio
 * ya la aplica.
 *
 * Se publica la TASA y no el importe a proposito: el importe exige prorratear antes el
 * descuento del documento, y eso es aritmetica de DOCUMENTO, no de renglon. Medido contra el
 * arbitro (la cabecera `kdm1.c14`/`c15`, un hecho independiente que Kepler ya escribio):
 * derivar el impuesto del importe CRUDO cuadra en el 100.00% de los documentos de mostrador
 * pero cae a 1.93% en telemarketing y 0% en credito, que son los que traen descuento.
 * Prorrateando primero vuelve a 100.00% en los tres, con error medio de $0.001 a $0.010.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const num = (col, dec) => `round(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,${dec})`;

// abs() porque Kepler las guarda negativas; /100 porque las guarda sobre 100.
const TASA_IVA = `abs(coalesce(nullif(regexp_replace(l.c17::text,'[^0-9.-]','','g'),'')::numeric,0))/100`;
const TASA_IEPS = `abs(coalesce(nullif(regexp_replace(l.c18::text,'[^0-9.-]','','g'),'')::numeric,0))/100`;

// NULL, no 0, cuando falta: kdm2.c66 no existe antes del 2026-08-13 (ver 20260918160100).
const PRECIO_LISTA = `NULLIF(${money('l.c66')}, 0)`;
// Nunca negativo: donde el cobrado supera al de lista no hay descuento que presumir.
const DESC_UNIT = `GREATEST(COALESCE(${PRECIO_LISTA}, ${money('l.c12')}) - ${money('l.c12')}, 0)`;

const HEAD = `h.c2='U' AND h.c3='D' AND (h.c4)::int=10 AND btrim(h.c1)=btrim(h.sucursal)`;

/**
 * Renglones del TICKET de mostrador. Copiado VERBATIM de la definicion viva de 160000 (22
 * columnas, terminando en `computed_at`) para garantizar que 1..22 conserven nombre, tipo y
 * orden — asi `CREATE OR REPLACE` solo AGREGA las dos ultimas y no intenta dropear nada.
 */
const TICKET_LINES = `
  SELECT
    '${M}'::uuid AS tenant_id,
    btrim(l.sucursal) AS sucursal,
    'UD' || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0') AS doc_prefix,
    btrim(l.c6::text) AS folio,
    btrim(l.sucursal) || 'UD' || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0')
      || '-' || btrim(l.c6::text) AS folio_digital,
    h.c9::date AS fecha,
    (l.c7)::int AS linea,
    btrim(l.c8::text) AS sku,
    NULLIF(btrim(l.c10::text),'') AS descripcion,
    NULLIF(btrim(l.c11::text),'') AS unidad,
    ${num('l.c9', 4)} AS cantidad,
    ${money('l.c12')} AS precio_unitario,
    ${money('l.c13')} AS importe,
    ${PRECIO_LISTA} AS precio_lista,
    ${DESC_UNIT} AS descuento_unitario,
    round(${DESC_UNIT} * ${num('l.c9', 4)}, 2) AS descuento_linea,
    NULLIF(btrim(l.c55),'') AS unidad_vendida,
    ${num('l.c56', 4)} AS cantidad_vendida,
    ${num('l.c57', 6)} AS precio_vendido,
    ${num('l.c58', 4)} AS factor_declarado,
    p.id AS product_id,
    now() AS computed_at,
    -- ⭐ Las dos columnas nuevas, AL FINAL. Ver la cabecera del archivo.
    ${TASA_IVA}  AS iva_tasa,
    ${TASA_IEPS} AS ieps_tasa
  FROM kepler_ods.kdm2 l
  JOIN kepler_ods.kdm1 h
    ON btrim(h.sucursal)=btrim(l.sucursal) AND btrim(h.c1)=btrim(l.c1)
   AND h.c2=l.c2 AND h.c3=l.c3 AND (h.c4)::int=(l.c4)::int AND (h.c5)::int=(l.c5)::int
   AND btrim(h.c6::text)=btrim(l.c6::text)
  -- ⚠️ p.sku SIN btrim: envolverlo anula el indice products_tenant_sku_unique y obliga a un
  -- Seq Scan. Medido en 160000: 11.7x mas lento. El btrim del lado de Kepler SI se queda.
  LEFT JOIN catalog.products p
    ON p.tenant_id='${M}'::uuid AND p.sku=btrim(l.c8::text) AND p.deleted_at IS NULL
  WHERE ${HEAD}`;

/**
 * Renglones de FACTURA. Copiado VERBATIM de la definicion viva de 200000 (26 columnas,
 * terminando en `naturaleza`), por la misma razon: las dos nuevas quedan 27 y 28.
 *
 * ⚠️ `cantidad` es `abs(...)`: en una devolucion el signo vive en `naturaleza`, no en el numero.
 * ⚠️ `precio_lista`/`descuento_*` degradan a NULL/0 en el lado abono (kdm2.c66 no aplica ahi).
 * ⚠️ Las tasas SI aplican a los dos lados: una nota de credito devuelve su impuesto.
 */
const INVOICE_LINES = `
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
    -- ⭐ Las dos columnas nuevas, AL FINAL. Ver la cabecera del archivo.
    ${TASA_IVA}  AS iva_tasa,
    ${TASA_IEPS} AS ieps_tasa
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

const ESPERADAS = [
  ['erp_sale_ticket_lines', 'iva_tasa'],
  ['erp_sale_ticket_lines', 'ieps_tasa'],
  ['erp_sales_invoice_lines', 'iva_tasa'],
  ['erp_sales_invoice_lines', 'ieps_tasa'],
];

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sale_ticket_lines AS ${TICKET_LINES}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sale_ticket_lines TO app_runtime');

  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sales_invoice_lines AS ${INVOICE_LINES}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');

  // ── El candado ────────────────────────────────────────────────────────────────────────
  // Esta migracion NO escribe datos: su ausencia no deja huella (ni una tabla vacia, ni una
  // fila faltante), y el consumidor lee con `select *`, donde una columna que no existe llega
  // `undefined` y se confunde con "el ERP no tiene el dato". O sea: el modo de falla de esta
  // migracion es el SILENCIO. Se le pregunta al catalogo, que es el unico que sabe.
  for (const [vista, columna] of ESPERADAS) {
    const { rows } = await knex.raw(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name=? AND column_name=?`,
      [vista, columna],
    );
    if (!rows.length) {
      throw new Error(
        `analytics.${vista} quedo SIN la columna ${columna}. El desglose de impuestos del ` +
        'ticket y de la carta saldria en ceros sin avisar. Revisar que CREATE OR REPLACE no ' +
        'haya sido ignorado por una definicion mas nueva de la vista.',
      );
    }
  }
  console.log('  ✓ iva_tasa / ieps_tasa presentes en erp_sale_ticket_lines y erp_sales_invoice_lines.');
};

/**
 * No-op, como el down de 160100 y 200000: quitar columnas exige `DROP VIEW` (CREATE OR REPLACE
 * no las saca), y eso dejaria sin renglones a `/comercial/documentos` y a `/comercial/tickets`
 * mientras se recrea. Dos columnas de mas no le hacen dano a ningun consumidor: todos
 * seleccionan por nombre.
 */
exports.down = async function down() {
  console.log('[sale_lines_tax_rates] down: no-op (quitar columnas exigiria DROP VIEW)');
};
