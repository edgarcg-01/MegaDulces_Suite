/**
 * `[CXC.SKU.1]` — El buscador por SKU pasa de **17 s a ~400 ms**, y de paso entran
 * las NOTAS DE CRÉDITO y DEVOLUCIONES, que ninguna vista del repo exponía.
 *
 * Pedido: buscar por SKU/descripción y ver "las notas de devolución o facturas con
 * ese producto", sin perder tiempos de carga. Requisito de Edgar, textual: **una
 * consulta de más de 1 segundo no sirve.**
 *
 * ── 1. Lo que se amplía, medido en el ODS (`platform_test` @ .245, PG 18) ─────
 *     U-A-21  Nota de crédito ....  1,190 renglones en   259 documentos
 *     U-A-25  Devolución .........  1,447 renglones en   372 documentos
 *     U-A-35  Nota de crédito ....      0 renglones (19 cabeceras, TODAS sin renglón)
 *                                  ------
 *                                   2,637  sobre los 48,130 que ya tenía = +5.5%
 *
 * ── 2. Los tiempos, que es la mitad del pedido ───────────────────────────────
 *     vista gorda (`erp_sales_invoice_lines`), un solo SKU .... 16,871 ms
 *     consulta flaca, sin los índices de abono ................  1,173 ms
 *     consulta flaca + índices  ...............................    285 ms
 *     ídem, PEOR SKU (541 renglones, LIMIT 200) ...............    352–480 ms
 *     └─ servidor: `Execution Time: 455 ms` → es trabajo real, no latencia.
 *
 * De los 17 s: ~1.6 s eran `v_product_box_factor` materializando 60,759 filas POR
 * LOOP, y el resto un `Nested Loop` que arrancaba por `kdm1` y sondeaba `kdm2` por
 * pkey a **5.767 ms por loop** — el planner no usaba el índice de SKU porque
 * estimaba 11 filas en `kdm1` y salían 290.
 *
 * Por eso el buscador NO usa la vista gorda: estrena `erp_sales_line_search`, que
 * filtra por `l.c8` (el SKU del RENGLÓN, así el índice manda desde el primer paso),
 * toca `kdm1` sólo para lo que sobrevivió, y deja fuera `kdii`, `catalog.products` y
 * `v_product_box_factor`. La gorda se queda para el DETALLE de un documento, que es
 * para lo que existe.
 *
 * ── ⛔ Dos veces me equivoqué acá, y las dos las corrigió medir ──────────────
 *  1. Iba a crear estos índices "porque los existentes son parciales a `c3=D`".
 *     Medí un CONTEO por doctype: `Parallel Index Only Scan using kdm2_pkey`,
 *     `Index Searches: 24` (skip scan de PG 18), 571 buffers, 40 ms → los retiré
 *     por innecesarios.
 *  2. Falso: ese conteo NO es la consulta del buscador. Filtrando por `c8` el skip
 *     scan no aplica y el plan cae en `Parallel Seq Scan on kdm2` con
 *     `Rows Removed by Filter: 1,282,601` POR WORKER. Los índices volvieron, ahora
 *     con la consulta REAL como evidencia: 1,173 ms → 285 ms.
 *  Cuestan 2.8 MB + 1.4 MB y se construyen en 1.6 s / 0.7 s: el lado abono son
 *  2,637 renglones. Despreciable para el CDC.
 *
 * ⚠️ `cantidad` es `abs(...)`: en una devolución el signo vive en `naturaleza`, no
 * en el número. Quien sume cargos y abonos sin mirar esa columna suma de más.
 * ⚠️ NO entra `U-D-10` ("Ticket Contado Caja", **424,022 cabeceras**): es venta de
 * mostrador, no factura. El buscador debe DECIRLO, no omitirlo callado.
 * ⚠️ Medido en `platform_test`, no en prod: vale para estructura y plan. Misma major
 * y mismo tamaño de `kdm2`, así que el orden de magnitud es representativo.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

/** El filtro de documentos, ahora por los DOS lados. Una sola fuente para el WHERE. */
const DOCFILTER = `h.c2='U'
      AND (
            (h.c3='D' AND (h.c4)::int IN (8,12))
         OR (h.c3='A' AND (h.c4)::int IN (21,25,35))
          )
      AND btrim(h.c1)=btrim(h.sucursal)`;

exports.config = { transaction: false };

exports.up = async function up(knex) {
  /**
   * ── 1. Los DOS índices del lado abono ──────────────────────────────────────
   * Medidos contra la consulta REAL del buscador (no contra un conteo): sin ellos
   * el `OR` sobre `c3` vuelve inservible `ix_kdm2_sku_venta` —que es parcial a
   * `c3='D'`— y el plan cae en `Parallel Seq Scan on kdm2` con
   * `Rows Removed by Filter: 1,282,601` POR WORKER, más un `Hash` de 496,811 filas
   * de `kdm1`. Con ellos, el mismo SKU pasa de **1,173 ms a ~300 ms**.
   *
   * Cuestan 2.8 MB + 1.4 MB y tardan 1.6 s y 0.7 s en construirse: el lado abono
   * son 2,637 renglones. La sobrecarga de escritura sobre el CDC es despreciable.
   *
   * `CONCURRENTLY` (y por eso `transaction: false`): `kdm1`/`kdm2` las escribe el
   * CDC cada minuto y un `CREATE INDEX` normal les tomaría el lock exclusivo.
   * ⚠️ Al aplicar, `CONCURRENTLY` ESPERA a que cierren las transacciones viejas
   * ("waiting for old snapshots"); no bloquea, sólo espera.
   */
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdm2_sku_abono
      ON kepler_ods.kdm2 (btrim(c8))
      INCLUDE (sucursal, c1, c4, c5, c6, c7, c9, c10, c11, c13)
      WHERE c2='U' AND c3='A'
  `);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdm1_abono_doc
      ON kepler_ods.kdm1 (btrim(sucursal), btrim(c1), ((c4)::int), ((c5)::int), btrim(c6))
      WHERE c2='U' AND c3='A'
  `);
  // Sin ANALYZE el planner descarta el índice recién creado — se verificó en el .245.
  await knex.raw('ANALYZE kepler_ods.kdm2');
  await knex.raw('ANALYZE kepler_ods.kdm1');

  // ── 2. La vista, con las 22 columnas EN SU ORDEN + `naturaleza` al final ─────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_sales_invoice_lines AS
    SELECT
      '${M}'::uuid AS tenant_id,
      btrim(l.sucursal) AS sucursal,
      ('U' || btrim(l.c3) || lpad((l.c4)::int::text,2,'0')) || lpad((l.c5)::int::text,2,'0') AS doc_prefix,
      btrim(l.c6) AS folio,
      btrim(l.sucursal) || 'U' || btrim(l.c3) || lpad((l.c4)::int::text,2,'0')
        || lpad((l.c5)::int::text,2,'0') || '-' || btrim(l.c6) AS folio_digital,
      (l.c7)::int AS linea,
      btrim(l.c8) AS sku,
      NULLIF(btrim(l.c10),'') AS descripcion,
      NULLIF(btrim(l.c11),'') AS unidad,
      abs(COALESCE((l.c9)::numeric,0)) AS cantidad,
      round(COALESCE(NULLIF(regexp_replace(l.c12::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS precio_unitario,
      round(COALESCE(NULLIF(regexp_replace(l.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
      NULLIF(COALESCE(NULLIF(regexp_replace(k.c84::text,'[^0-9.]','','g'),'')::numeric,0),0) AS factor_caja,
      NULLIF(btrim(k.c11),'') AS unidad_venta,
      NULLIF(btrim(k.c83),'') AS unidad_bulto,
      NULLIF(btrim(k.c80),'') AS unidad_paq,
      NULLIF(COALESCE(NULLIF(regexp_replace(k.c81::text,'[^0-9.]','','g'),'')::numeric,0),0) AS factor_paq,
      bf.box_factor,
      bf.source AS box_factor_source,
      COALESCE(bf.is_master_suspect,false) AS box_factor_dudoso,
      p.id AS product_id,
      now() AS computed_at,
      CASE btrim(l.c3) WHEN 'A' THEN 'abono' ELSE 'cargo' END AS naturaleza
    FROM kepler_ods.kdm2 l
      JOIN kepler_ods.kdm1 h
        ON btrim(h.sucursal)=btrim(l.sucursal) AND btrim(h.c1)=btrim(l.c1)
       AND h.c2=l.c2 AND h.c3=l.c3 AND (h.c4)::int=(l.c4)::int AND h.c6=l.c6
      LEFT JOIN kepler_ods.kdii k
        ON btrim(k.sucursal)=btrim(l.sucursal) AND btrim(k.c1)=btrim(l.c8)
      LEFT JOIN catalog.products p
        ON p.tenant_id='${M}'::uuid AND btrim(p.sku::text)=btrim(l.c8) AND p.deleted_at IS NULL
      LEFT JOIN analytics.v_product_box_factor bf
        ON bf.tenant_id='${M}'::uuid AND bf.product_id=p.id
    WHERE ${DOCFILTER}
      AND COALESCE(btrim(l.c11),'') <> 'SER'
  `);

  // `CREATE OR REPLACE` conserva los GRANT, pero re-aplicarlo es idempotente y cubre
  // el caso de que alguien la haya recreado a mano con DROP.
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');

  /**
   * ── 3. La vista FLACA del buscador ─────────────────────────────────────────
   * El buscador NO puede usar `erp_sales_invoice_lines`: esa vista existe para el
   * DETALLE de un documento y arrastra `kdii`, `catalog.products` y
   * `analytics.v_product_box_factor`. Medido con un solo SKU:
   *
   *     por la vista gorda .......... 16,871 ms (angosta) · 18,396 ms (ampliada)
   *     esta consulta, sin índices ...  1,173 ms
   *     esta consulta, con índices ...    285–480 ms   ← peor caso, 541 renglones
   *
   * De los 17 s, ~1.6 s eran `v_product_box_factor` materializando 60,759 filas POR
   * LOOP, y el resto un `Nested Loop` que arrancaba por `kdm1` sondeando `kdm2` por
   * pkey a 5.767 ms por loop. Acá el filtro por SKU va sobre `l.c8` —la tabla de
   * renglones— así que el índice manda desde el primer paso y `kdm1` se toca sólo
   * para las filas que sobrevivieron.
   *
   * ⚠️ El factor de caja NO está acá a propósito: es lo que costaba 1.6 s. Si el
   * buscador alguna vez necesita mostrar cajas, se resuelve en el detalle del
   * documento, no en la lista.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_sales_line_search AS
    SELECT
      '${M}'::uuid AS tenant_id,
      btrim(l.sucursal) AS sucursal,
      'U' || btrim(l.c3) || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0') AS doc_prefix,
      btrim(l.c6) AS folio,
      btrim(l.sucursal) || 'U' || btrim(l.c3) || lpad((l.c4)::int::text,2,'0')
        || lpad((l.c5)::int::text,2,'0') || '-' || btrim(l.c6) AS folio_digital,
      (l.c7)::int AS linea,
      btrim(l.c8) AS sku,
      NULLIF(btrim(l.c10),'') AS descripcion,
      NULLIF(btrim(l.c11),'') AS unidad,
      abs(COALESCE((l.c9)::numeric,0)) AS cantidad,
      round(COALESCE(NULLIF(regexp_replace(l.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
      CASE btrim(l.c3) WHEN 'A' THEN 'abono' ELSE 'cargo' END AS naturaleza,
      (h.c9)::date AS fecha
    FROM kepler_ods.kdm2 l
      JOIN kepler_ods.kdm1 h
        ON btrim(h.sucursal)=btrim(l.sucursal) AND btrim(h.c1)=btrim(l.c1)
       AND h.c2=l.c2 AND h.c3=l.c3 AND (h.c4)::int=(l.c4)::int AND h.c6=l.c6
    WHERE l.c2='U'
      AND (
            (l.c3='D' AND (l.c4)::int IN (8,12))
         OR (l.c3='A' AND (l.c4)::int IN (21,25,35))
          )
      AND COALESCE(btrim(l.c11),'') <> 'SER'
  `);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_line_search TO app_runtime');
};

exports.down = async function down(knex) {
  /**
   * ⚠️ Quitar `naturaleza` exige DROP: `CREATE OR REPLACE VIEW` agrega columnas al
   * final pero NO las saca. Y el DROP se lleva los GRANT, así que se re-aplican.
   * Se reconstruye la definición ANTERIOR verbatim (22 columnas, sólo lado cargo).
   */
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_line_search');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_invoice_lines');
  await knex.raw(`
    CREATE VIEW analytics.erp_sales_invoice_lines AS
    SELECT
      '${M}'::uuid AS tenant_id,
      btrim(l.sucursal) AS sucursal,
      ('UD' || lpad((l.c4)::int::text,2,'0')) || lpad((l.c5)::int::text,2,'0') AS doc_prefix,
      btrim(l.c6) AS folio,
      btrim(l.sucursal) || 'UD' || lpad((l.c4)::int::text,2,'0')
        || lpad((l.c5)::int::text,2,'0') || '-' || btrim(l.c6) AS folio_digital,
      (l.c7)::int AS linea,
      btrim(l.c8) AS sku,
      NULLIF(btrim(l.c10),'') AS descripcion,
      NULLIF(btrim(l.c11),'') AS unidad,
      abs(COALESCE((l.c9)::numeric,0)) AS cantidad,
      round(COALESCE(NULLIF(regexp_replace(l.c12::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS precio_unitario,
      round(COALESCE(NULLIF(regexp_replace(l.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
      NULLIF(COALESCE(NULLIF(regexp_replace(k.c84::text,'[^0-9.]','','g'),'')::numeric,0),0) AS factor_caja,
      NULLIF(btrim(k.c11),'') AS unidad_venta,
      NULLIF(btrim(k.c83),'') AS unidad_bulto,
      NULLIF(btrim(k.c80),'') AS unidad_paq,
      NULLIF(COALESCE(NULLIF(regexp_replace(k.c81::text,'[^0-9.]','','g'),'')::numeric,0),0) AS factor_paq,
      bf.box_factor,
      bf.source AS box_factor_source,
      COALESCE(bf.is_master_suspect,false) AS box_factor_dudoso,
      p.id AS product_id,
      now() AS computed_at
    FROM kepler_ods.kdm2 l
      JOIN kepler_ods.kdm1 h
        ON btrim(h.sucursal)=btrim(l.sucursal) AND btrim(h.c1)=btrim(l.c1)
       AND h.c2=l.c2 AND h.c3=l.c3 AND (h.c4)::int=(l.c4)::int AND h.c6=l.c6
      LEFT JOIN kepler_ods.kdii k
        ON btrim(k.sucursal)=btrim(l.sucursal) AND btrim(k.c1)=btrim(l.c8)
      LEFT JOIN catalog.products p
        ON p.tenant_id='${M}'::uuid AND btrim(p.sku::text)=btrim(l.c8) AND p.deleted_at IS NULL
      LEFT JOIN analytics.v_product_box_factor bf
        ON bf.tenant_id='${M}'::uuid AND bf.product_id=p.id
    WHERE h.c2='U' AND h.c3='D' AND (h.c4)::int IN (8,12) AND btrim(h.c1)=btrim(h.sucursal)
      AND COALESCE(btrim(l.c11),'') <> 'SER'
  `);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');

  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdm2_sku_abono');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdm1_abono_doc');
};
