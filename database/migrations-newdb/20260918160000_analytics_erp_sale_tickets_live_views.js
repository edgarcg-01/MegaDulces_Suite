/**
 * Fase TK.0 — El TICKET DE MOSTRADOR (`U-D-10`) como documento reimprimible, DERIVE-NO-COPY.
 *
 * Dos vistas EN VIVO sobre `kepler_ods.*` (sin tabla, sin importer), calcando el patrón de
 * `analytics.erp_sales_invoices` (mig 20260822140000): heredan la frescura del CDC (~segundos).
 *
 * ¿POR QUÉ UNA VISTA NUEVA Y NO EXTENDER `erp_sales_invoices` A `U-D-10`?
 * Porque se midió el radio de impacto y es grande: esa vista la leen hoy `weekly-analytics`,
 * `commercial-profitability`, `commercial-televenta`, `mv_kepler_sales_daily`,
 * `product_volume_tiers` y `v_product_box_factor`. Meterle el mostrador la multiplicaría por
 * ~60 (30,549 docs/30 d contra 477 de telemarketing) y movería en silencio cifras ya
 * publicadas — exactamente lo que ADR-056 existe para impedir. El universo de doctipos queda
 * repartido SIN TRASLAPE: `8/12` allá, `10` acá. Nadie deriva la misma fila dos veces.
 *
 * ⭐ EL HALLAZGO QUE JUSTIFICA LA FASE — el descuento del ticket de mostrador SÍ existe, pero
 * no donde uno lo busca. Medido en `platform_test` sobre 30,549 documentos y 29,353 renglones
 * (ventana de 20 días):
 *
 *   - `kdm1.c13` (descuento de cabecera) = **0.00 en el 100%** de los `U-D-10`. Por el camino
 *     obvio —el mismo que usa el anexo de telemarketing— el descuento no existe.
 *   - `kdm2.c13 = c9 × c12` **exacto en el 100%** de los renglones: tampoco hay un descuento
 *     escondido en la aritmética de la línea.
 *   - ⭐ **`kdm2.c66` es el PRECIO DE LISTA de la unidad base** y `c12` el efectivamente
 *     cobrado. Con eso: 84.8% cobran lista, **15.1% cobran menos** y sólo **31 renglones de
 *     29,353 (0.106%) cobran de más**.
 *
 * Y el testigo alterno se REFUTÓ con medición, no con opinión: comparar `c12` contra el precio
 * del CATÁLOGO (`kdii.c90/c91/c92` del peldaño vendido) da **1.9% de renglones cobrando por
 * encima de lista** — 18× peor. El catálogo es el precio de HOY; el renglón trae el de la
 * venta. Gana el renglón. No reintroducir el catálogo acá.
 *
 * ⚠️ NO SE FILTRAN renglones (ni `SER`, ni cantidad ≤ 0) a diferencia de la vista hermana.
 * Medido: en `U-D-10` hay **0 líneas de servicio, 0 en cero y 0 negativas**, así que el filtro
 * no quitaría nada — y sí rompería la única propiedad que un cliente puede verificar con una
 * calculadora: que los renglones sumen el total. Medido también: Σ`c13` = `c16` en **6,745 de
 * 6,756 tickets (99.84%)**, o sea que el precio del renglón YA TRAE los impuestos.
 *
 * ⚠️ **KEPLER NO GUARDA LA HORA DEL TICKET.** Se revisaron las 10 columnas `timestamp` de
 * `kdm1` (`c9,c18,c41,c68,c91,c101,c188,c191,c195,c197`) y `kdm2.c32`: **todas en 00:00:00**
 * en los 10,716 documentos de la ventana. La vista expone `fecha` (date) y nada más; la
 * reimpresión NO debe inventar una hora ni imprimir el reloj del navegador como si lo fuera
 * (es la falla que VP.0 midió en 21 de 24 píldoras de frescura).
 *
 * DECODE verificado en vivo contra `kdmm`, el catálogo de documentos de la propia instalación:
 *   `U-D-10` serie N = **"Ticket Contado Caja N"** → `c5` es LA CAJA, no una serie fiscal.
 *   `kdm1`: c9=fecha · c10=cliente (`CONTADO`) · c12=cajero → `kduv.c2` · c13=desc.documento
 *           c14=IVA · c15=IEPS · c16=total · c22=RFC · c32=nombre · c33=domicilio
 *   `kdm2`: c7=línea · c8=sku · c9=cantidad base · c11=unidad base · c12=precio cobrado base
 *           c13=importe · **c66=precio de lista base** · c55/c56/c57/c58=peldaño vendido
 *
 * ⚠️ Las expresiones del `WHERE` están escritas para calzar con los índices parciales de la
 * mig 20260822140100 (`btrim(sucursal)`, `(c4)::int`, `(c5)::int`, `btrim(c6::text)`). Si se
 * cambian acá, el índice deja de aplicar y el lookup de un folio pasa de ~8 ms a segundos.
 *
 * `analytics.*` no tiene RLS → el consumidor filtra `tenant_id` explícito.
 */

const M = '00000000-0000-0000-0000-00000000d01c';

// Money defensivo: kepler_ods conserva el tipo del origen y hay columnas sucias.
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const num = (col, dec) => `round(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,${dec})`;

// Mismo filtro en cabecera y líneas, o el JOIN miente. `btrim(c1)=btrim(sucursal)` deja sólo la
// copia propia de cada rama (kdm1/kdm2 arrastran la réplica de las demás).
const HEAD = `h.c2='U' AND h.c3='D' AND (h.c4)::int=10 AND btrim(h.c1)=btrim(h.sucursal)`;

/**
 * ⭐⭐ EL PRECIO DE LISTA, Y POR QUÉ ES `NULL` Y NO `0` CUANDO FALTA.
 *
 * **`kdm2.c66` no existe antes del 2026-08-13.** Medido mes a mes sobre `U-D-10`:
 *
 *     ene–jul 2026   ~1,046,000 renglones   c66 vacío en el **100%**
 *     ago 2026          241,754 renglones   c66 vacío en el 39% (arranca el 13, pleno el 14)
 *     sep 2026           10,269 renglones   c66 vacío en 2 renglones (0.02%)
 *
 * Por sucursal el interruptor se ve igual de nítido: `02` el 13-ago, `03` el 14-ago, y la
 * `07` (que nació después) desde su primer día. Las demás sólo tienen el centinela
 * `1800-01-01`, que es como Kepler codifica "no hay dato" — no puede expresar NULL, todas sus
 * columnas son `NOT NULL` (ver `ERP_KEPLER.md` §2.4).
 *
 * O sea: **el descuento de un ticket sólo se puede afirmar a partir del 13-ago-2026.** Para
 * todo lo anterior el ERP no guarda con qué precio se comparaba.
 *
 * Devolver `0` ahí sería el peor resultado posible: la pantalla imprimiría "Precio de lista
 * $0.00" en un ticket que cobró dinero, y la cascada arrancaría en cero. Un cero se lee como
 * un hecho ("no costaba nada") y esto es una ausencia ("no sé cuánto costaba"). `NULL` obliga
 * al consumidor a decidir qué hacer, y lo que hace es DECLARARLO (ADR-056).
 */
const PRECIO_LISTA = `NULLIF(${money('l.c66')}, 0)`;
/**
 * ⭐⭐ LAS TASAS DE IMPUESTO POR RENGLON — `kdm2.c17` = IVA, `c18` = IEPS.
 *
 * Kepler las guarda NEGATIVAS (`-16`, `-8`) y como proporcion de 100. Medido en prod sobre
 * 116,411 renglones de mostrador (10 dias): `c17` toma exactamente {0, -16} y `c18` {0, -8}.
 *
 * ⭐ **IVA e IEPS NUNCA coinciden en el mismo renglon**: 0 de 123,203 renglones medidos, en los
 * tres doctipos (mostrador 0/116,411 · telemarketing 0/2,898 · credito 0/3,894). Un producto
 * lleva uno u otro. Por eso el ticket puede darse el lujo de UNA columna rotulada en vez de
 * dos, y por eso el orden de la cascada fiscal (IEPS primero, IVA sobre base+IEPS) da lo mismo
 * que la version plana — se comprobaron las dos y devuelven identico.
 *
 * ⚠️ Si algun dia un renglon trae las dos, el consumidor tiene que aplicar la CASCADA
 * (`base * (1+ieps) * (1+iva)`), que es el orden fiscal mexicano, no sumarlas planas.
 *
 * Se publica la TASA y no el importe a proposito: el importe exige prorratear antes el
 * descuento del documento, y eso es aritmetica de documento. Medido: derivar el impuesto del
 * importe CRUDO cuadra contra la cabecera en el 100.00% de los documentos SIN descuento, pero
 * en los que SI lo traen cae a 1.93% (telemarketing). Prorrateando primero, vuelve a 100.00%
 * en los tres doctipos con error medio de $0.001 a $0.010 (redondeo).
 */
const TASA_IVA = `abs(coalesce(nullif(regexp_replace(l.c17::text,'[^0-9.-]','','g'),'')::numeric,0))/100`;
const TASA_IEPS = `abs(coalesce(nullif(regexp_replace(l.c18::text,'[^0-9.-]','','g'),'')::numeric,0))/100`;

// El descuento del renglón, una sola vez y en un solo lugar: lo usan tres columnas. Sin precio
// de lista el descuento no es 0 "porque no hubo": es 0 porque no hay con qué compararlo, y eso
// lo dice `precio_lista IS NULL`, que viaja al lado.
const DESC_UNIT = `GREATEST(COALESCE(${PRECIO_LISTA}, ${money('l.c12')}) - ${money('l.c12')}, 0)`;

exports.up = async function up(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sale_ticket_lines');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sale_tickets');

  // ── CABECERAS ───────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE VIEW analytics.erp_sale_tickets AS
    SELECT
      '${M}'::uuid AS tenant_id,
      q.sucursal, w.id AS warehouse_id, w.name AS warehouse_name,
      q.doc_prefix, 'ticket'::text AS doc_tipo, q.doc_label, q.caja, q.folio,
      q.sucursal || q.doc_prefix || '-' || q.folio AS folio_digital,
      q.fecha,
      q.cliente_code, q.cliente_nombre, q.cliente_rfc,
      q.cajero_code, q.cajero_nombre,
      q.total, q.iva, q.ieps, q.descuento_documento,
      'md_' || q.sucursal AS source_branch, now() AS computed_at
    FROM (
      SELECT DISTINCT ON (btrim(h.sucursal), (h.c4)::int, (h.c5)::int, btrim(h.c6::text))
        btrim(h.sucursal) AS sucursal,
        'UD' || lpad((h.c4)::int::text,2,'0') || lpad((h.c5)::int::text,2,'0') AS doc_prefix,
        (h.c5)::int AS caja,
        -- El rótulo sale del catálogo de la PROPIA sucursal ("Ticket Contado Caja 3"); si esa
        -- rama no lo tiene capturado se arma con la caja, en vez de quedar en NULL.
        COALESCE(NULLIF(btrim(dm.c5::text),''), 'Ticket Contado Caja ' || (h.c5)::int) AS doc_label,
        btrim(h.c6::text) AS folio,
        h.c9::date AS fecha,
        NULLIF(btrim(h.c10::text),'') AS cliente_code,
        NULLIF(btrim(h.c32::text),'') AS cliente_nombre,
        NULLIF(btrim(h.c22::text),'') AS cliente_rfc,
        NULLIF(btrim(h.c12::text),'') AS cajero_code,
        NULLIF(btrim(v.c3::text),'')  AS cajero_nombre,
        ${money('h.c16')} AS total,
        ${money('h.c14')} AS iva,
        ${money('h.c15')} AS ieps,
        -- Siempre 0.00 en el mostrador (medido, 100%). Se expone igual para que el consumidor
        -- no tenga que saberlo: la cascada de descuentos es la misma consulta en los 3 canales.
        ${money('h.c13')} AS descuento_documento
      FROM kepler_ods.kdm1 h
      LEFT JOIN kepler_ods.kduv v
        ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2::text)=btrim(h.c12::text)
      LEFT JOIN kepler_ods.kdmm dm
        ON btrim(dm.sucursal)=btrim(h.sucursal) AND btrim(dm.c1)='U' AND btrim(dm.c2)='D'
       AND (dm.c3)::int=(h.c4)::int AND (dm.c4)::int=(h.c5)::int
      WHERE ${HEAD}
      ORDER BY btrim(h.sucursal), (h.c4)::int, (h.c5)::int, btrim(h.c6::text)
    ) q
    LEFT JOIN commercial.warehouses w
      ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL`);
  await knex.raw('GRANT SELECT ON analytics.erp_sale_tickets TO app_runtime');

  // ── RENGLONES ───────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE VIEW analytics.erp_sale_ticket_lines AS
    SELECT
      '${M}'::uuid AS tenant_id,
      btrim(l.sucursal) AS sucursal,
      'UD' || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0') AS doc_prefix,
      btrim(l.c6::text) AS folio,
      btrim(l.sucursal) || 'UD' || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0')
        || '-' || btrim(l.c6::text) AS folio_digital,
      -- La fecha viene del JOIN a la cabecera, que ya esta hecho: sale gratis y vuelve a la
      -- vista autosuficiente para cualquier consulta acotada por ventana. Sin ella, filtrar por
      -- fecha obliga a un IN (subconsulta de folios) que en 3.4M renglones no termina.
      h.c9::date AS fecha,
      (l.c7)::int AS linea,
      btrim(l.c8::text) AS sku,
      NULLIF(btrim(l.c10::text),'') AS descripcion,
      NULLIF(btrim(l.c11::text),'') AS unidad,
      ${num('l.c9', 4)} AS cantidad,
      ${money('l.c12')} AS precio_unitario,
      ${money('l.c13')} AS importe,
      -- ⭐ Precio de lista de la unidad BASE: el testigo del descuento (ver cabecera del
      -- archivo). Se compara contra precio_unitario porque los dos están en LA MISMA unidad
      -- y cantidad x precio_unitario = importe es exacto — así la resta cierra en el papel.
      ${PRECIO_LISTA} AS precio_lista,
      -- Nunca negativo: en 31 de 29,353 renglones (0.106%) el cobrado supera al de lista. Ahí
      -- no hay descuento que presumir, hay un dato que no alcanza — se declara 0 y no se
      -- imprime un "descuento" en contra del cliente (ADR-056: lo que no se puede medir se
      -- declara, no se dibuja).
      ${DESC_UNIT} AS descuento_unitario,
      round(${DESC_UNIT} * ${num('l.c9', 4)}, 2) AS descuento_linea,
      -- El peldaño realmente cobrado, para poder decir "5 CJA" en vez de "30 PZA". Es
      -- DESCRIPTIVO: cantidad_vendida x precio_vendido sólo reproduce el importe en el 96%
      -- de los renglones (peor caso medido: $146), así que la aritmética del papel va por la
      -- unidad base y esto se imprime AL LADO, nunca en su lugar.
      NULLIF(btrim(l.c55),'') AS unidad_vendida,
      ${num('l.c56', 4)} AS cantidad_vendida,
      ${num('l.c57', 6)} AS precio_vendido,
      ${num('l.c58', 4)} AS factor_declarado,
      -- ⭐ TASAS de impuesto POR RENGLON. La vista publica el HECHO que Kepler escribio (la
      -- tasa); el IMPORTE del impuesto lo calcula el consumidor, porque depende de prorratear
      -- antes el descuento del documento y eso es aritmetica de documento, no de renglon.
      ${TASA_IVA}  AS iva_tasa,
      ${TASA_IEPS} AS ieps_tasa,
      p.id AS product_id,
      now() AS computed_at
    FROM kepler_ods.kdm2 l
    JOIN kepler_ods.kdm1 h
      ON btrim(h.sucursal)=btrim(l.sucursal) AND btrim(h.c1)=btrim(l.c1)
     AND h.c2=l.c2 AND h.c3=l.c3 AND (h.c4)::int=(l.c4)::int AND (h.c5)::int=(l.c5)::int
     AND btrim(h.c6::text)=btrim(l.c6::text)
    -- ⚠️ p.sku SIN btrim: envolverlo anula el indice products_tenant_sku_unique
    -- (parcial sobre sku IS NOT NULL AND deleted_at IS NULL) y obliga a un Seq Scan de la
    -- tabla entera. Medido: 11,197 filas leidas de 24 MB para resolver 5 renglones, ~1,009
    -- bloques del total de la consulta. Y el btrim no protegia de nada: **0 de 14,794 SKUs
    -- tienen espacios**. El btrim del lado de Kepler SI se queda -- ahi los padding son reales.
    LEFT JOIN catalog.products p
      ON p.tenant_id='${M}'::uuid AND p.sku=btrim(l.c8::text) AND p.deleted_at IS NULL
    WHERE ${HEAD}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sale_ticket_lines TO app_runtime');
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sale_ticket_lines');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sale_tickets');
};
