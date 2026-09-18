/**
 * `[CXC.SKU.1]` — Los renglones de las NOTAS DE CRÉDITO y DEVOLUCIONES entran a
 * `analytics.erp_sales_invoice_lines`. **Sólo la vista: ni un índice nuevo.**
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────
 * Pedido: un buscador por SKU/descripción que muestre "las notas de devolución o
 * facturas con ese producto". La mitad de la factura ya estaba; la de las notas no
 * la exponía NINGUNA vista del repo — el `WHERE` de esta vista era
 * `c2='U' AND c3='D' AND c4 IN (8,12)`, o sea sólo el lado CARGO.
 *
 * ── Lo que se agrega, medido en el ODS (`platform_test` @ .245, PG 18) ────────
 *     U-A-21  Nota de crédito ....  1,190 renglones en   259 documentos
 *     U-A-25  Devolución .........  1,447 renglones en   372 documentos
 *     U-A-35  Nota de crédito ....      0 renglones (19 cabeceras, TODAS sin renglón)
 *                                  ------
 *                                   2,637  sobre los 48,130 que ya tenía = +5.5%
 *
 * ── ⛔ Acá me equivoqué, y la medición lo corrigió ───────────────────────────
 * Esta migración iba a crear TRES índices parciales para el lado abono, razonando
 * que los que sirven a esta vista —`ix_kdm2_sku_venta`, `ix_kdm2_venta_doc`,
 * `ix_kdm1_venta_doc`— son parciales con `WHERE c2='U' AND c3='D'` y que las notas
 * (`c3='A'`) quedaban fuera de los tres → seq scan de `kdm2`, que son **3,825,246
 * filas / 1,884 MB**.
 *
 * El razonamiento era correcto y la CONCLUSIÓN falsa. `EXPLAIN (ANALYZE, BUFFERS)`
 * del filtro de abonos:
 *
 *     Parallel Index Only Scan using kdm2_pkey  (actual time=0.116..6.990)
 *       Index Cond: ((c2 = 'U') AND (c3 = 'A'))
 *       Index Searches: 24          ← SKIP SCAN de PG 18
 *       Buffers: shared hit=571     ← ~4.5 MB, no 1.9 GB
 *     Execution: ~40 ms
 *
 * `c2`/`c3` no encabezan `kdm2_pkey` (va `sucursal, c1, c2, c3, …`), pero PG 18 las
 * usa igual por **skip scan**. Agregar tres índices a una tabla que el CDC escribe
 * CADA MINUTO, para acelerar algo que ya responde en 40 ms, es costo de escritura
 * puro a cambio de nada. Se retiraron.
 * ⚠️ Depende de PG 18 (prod y este entorno lo son). En una major anterior no hay
 * skip scan y esto SÍ necesitaría los índices — medir antes de bajar de versión.
 *
 * ── Qué cambia en la vista ───────────────────────────────────────────────────
 *   1. El `WHERE` suma el lado abono.
 *   2. `doc_prefix` y `folio_digital` dejan de tener `'UD'` CLAVADO: se arman con
 *      `l.c3`, que es la naturaleza real. Con el literal, una nota de crédito se
 *      habría publicado con folio digital de factura — dos documentos distintos con
 *      la misma identidad, que es peor que no tenerla.
 *   3. Se AGREGA `naturaleza` ('cargo' | 'abono') al final. Va al final a propósito:
 *      `CREATE OR REPLACE VIEW` sólo admite columnas nuevas ahí, y así no hay `DROP`
 *      (el `DROP` se llevaría los GRANT y cualquier dependiente).
 *
 * ⚠️ `cantidad` sigue siendo `abs(...)`: en una devolución el signo vive en
 * `naturaleza`, no en el número. Quien sume cargos y abonos SIN mirar esa columna
 * va a sumar de más — está declarado, no disimulado.
 *
 * ⚠️ NO entra `U-D-10` ("Ticket Contado Caja", **424,022 cabeceras**): es la venta de
 * mostrador, no una factura, y meterla multiplicaría por 55 el universo de esta
 * vista. El buscador debe DECIRLO en pantalla, no omitirlo callado.
 *
 * ── ⛔⛔ NO APLICAR TODAVÍA: LA BÚSQUEDA POR SKU TARDA 17 SEGUNDOS ───────────
 * Medido en `platform_test` con la vista APLICADA y luego REVERTIDA, mismo SKU:
 *
 *     vista ANGOSTA (como está hoy en prod) ...... 16,871 ms / 16,548 ms
 *     vista AMPLIADA (esta migración) ............ 18,396 / 16,529 / 18,250 ms
 *
 * O sea: **los 17 s YA EXISTEN, sin esta migración.** Lo que agrega el lado abono es
 * ~1.6 s de las filas nuevas, no el problema. (Primero escribí que el `OR` del
 * `WHERE` rompía el plan con un `BitmapOr` — es FALSO, lo desmintió medir la vista
 * angosta, que no tiene `OR` y tarda lo mismo.)
 *
 * Dónde se van, según `EXPLAIN (ANALYZE, BUFFERS)`:
 *   · **16.9 s** en un `Nested Loop` que arranca por `kdm1` y sondea `kdm2` con
 *     `Index Scan using kdm2_pkey`, a **5.767 ms por loop**. El planner NO usa
 *     `ix_kdm2_sku_venta` —el índice de SKU— aunque la consulta filtre por `sku`:
 *     estima 11 filas en `kdm1` y salen 290, y con esa estimación elige el loop.
 *   · ~1.6 s más en `v_product_box_factor` (la cadena `product_label_prices` →
 *     `GroupAggregate` → `Unique`, 60,759 filas materializadas por cada loop).
 *
 * El pedido fue "ampliar SIN perder tiempos de carga, optimizar a lo más óptimo".
 * Ampliar está resuelto y verificado (3 renglones cargo + 4 abono para el SKU de
 * prueba, con `folio_digital` correcto por naturaleza). **Los 17 s son trabajo
 * aparte y son la deuda real**: hay que forzar que la consulta EMPIECE por `kdm2`
 * filtrando por SKU, y sacar `v_product_box_factor` del camino caliente. Hasta
 * entonces esta vista no habilita ningún buscador usable, y aplicarla sólo sumaría
 * 1.6 s a una consulta que ya es inusable.
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

exports.up = async function up(knex) {
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
};

exports.down = async function down(knex) {
  /**
   * ⚠️ Quitar `naturaleza` exige DROP: `CREATE OR REPLACE VIEW` agrega columnas al
   * final pero NO las saca. Y el DROP se lleva los GRANT, así que se re-aplican.
   * Se reconstruye la definición ANTERIOR verbatim (22 columnas, sólo lado cargo).
   */
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

};
