'use strict';
/**
 * `[RD.31]` — **El conteo de ruta como ANCLA: lo único que cierra el hueco que ningún documento ve.**
 *
 * ── Por qué hace falta una tabla, y por qué ésta sí ─────────────────────────────────────────
 *
 * `[RD.30]` arregló lo que era defecto nuestro (el rótulo `RD021` y el ancla). Quedó medido lo
 * que **no** lo es: la ruta 21 publica **$18,427** y el camión trae **$37,766**. El faltante
 * está identificado — de los −$35,376 del lado «en contra», **$31,357 (89 %)** son productos
 * cargados la primera semana o **nunca cargados**: mercancía que el camión ya traía antes de que
 * pudiéramos ver sus ventas. 136 pares salen en negativo, y **un saldo negativo en un camión es
 * físicamente imposible**: el signo mismo es la prueba de que falta una apertura.
 *
 * ⛔ Eso no se arregla con otra vista. **No está en ninguna fuente**: ni embarque, ni devolución
 * (no existe el doctype), ni conteo (el `N-A-45` de la sucursal es de anaquel de tienda). La
 * única salida es que una persona cuente el camión y lo registre.
 *
 * ⭐ Y es exactamente el caso que la regla del proyecto permite: *«Tabla real SÓLO para datos
 * propios (HITL, OCR, feedback)»*. Un conteo capturado por una persona **no es un importer ni
 * una copia del ODS** — es un hecho que el ODS no tiene.
 *
 * ── La semántica del ancla, que es lo que hay que leer antes de usarla ───────────────────────
 *
 * ⭐ **Un conteo RESETEA, no parchea.** A partir de él:
 *   · el saldo de cada producto arranca en lo contado;
 *   · un producto que el conteo **no** lista queda en **cero**, aunque antes tuviera saldo —
 *     porque la persona miró el camión y no estaba. Un conteo que sólo sumara lo que encontró
 *     dejaría vivos para siempre los fantasmas que vino a matar.
 *   · todo lo anterior al conteo sale del cálculo: no se arrastra ni se compensa.
 *
 * ⚠️ **El conteo es el saldo de CIERRE de su día**, así que los movimientos entran **estrictamente
 * después** (`> count_date`, no `>=`). Medido con el archivo del 5-oct: de los pares que la ruta
 * vendió ese mismo día, el conteo casa con el saldo **después** de esas ventas 10 a 6 (y 4 a 2
 * entre los que movieron 5 piezas o más). Si se tomara `>=` se restaría dos veces la venta del día.
 *
 * ⚠️ **El día NO se deduce del nombre del archivo.** El que originó esta fase se llamaba
 * `rd21 05-sep.xlsx` y es del **5 de OCTUBRE**: 36 productos cuyo costo cambió entre septiembre y
 * octubre traen el de octubre, **36 a 0**. `count_date` es un campo que la persona declara.
 *
 * ── El efecto colateral que casi rompe la valuación ──────────────────────────────────────────
 *
 * ⛔ Cortar la historia en el conteo deja a `v_rd_route_unit_value` **sin su mejor fuente**: su
 * `costo_u` sale de `carga_imp/carga_qty`, y una ruta recién anclada no tiene carga posterior —
 * caería entera a la ficha de Kepler. Por eso el conteo **también declara costo**, y entra en la
 * cascada como `origen_costo = 'conteo'`, entre la ruta y la ficha.
 *
 * ⭐ Está medido que ese costo es bueno: de los 257 productos del conteo de la 21, **246 de 246**
 * de los que alguna vez se cargaron coinciden **al centavo** con el costo de carga de esa ruta.
 * No es un número que la persona invente: lo imprime el mismo Kepler.
 *
 * ⚠️ `carga_qty` sigue significando **lo cargado**, no lo contado — el conteo viaja en términos
 * propios dentro del CTE y no se mezcla en una columna publicada. Lo que sí se corrige es
 * `saldo_qty`, que es el saldo y tiene que incluirlo.
 *
 * ── Esta migración es un NO-OP hasta que exista un conteo ────────────────────────────────────
 *
 * Sin filas en `route_counts`, el `LEFT JOIN LATERAL` devuelve NULL, `desde` se queda en
 * `carga_desde` y el `UNION` del conteo no aporta filas: el ledger publica exactamente lo mismo
 * que hoy. Eso la hace aplicable sin coordinar con el despliegue del servicio.
 *
 * ⛔ **Lo que esta migración NO hace: registrar el conteo.** Eso entra por el servicio, desde la
 * pantalla. Sembrar datos de negocio en una migración es justo lo que convierte una migración en
 * un importer.
 *
 * @param { import("knex").Knex } knex
 */

const LEDGER = 'analytics.v_rd_route_ledger';
const UNIT = 'analytics.v_rd_route_unit_value';

/** Los rótulos de un almacén de ruta, como dato (ver `[RD.30]`). */
const ROTULOS = `
  SELECT x.dest_code FROM analytics.transfer_dest_map x
   WHERE x.tenant_id = a.tenant_id AND x.warehouse_id = a.warehouse_id`;

exports.up = async function up(knex) {
  // ── 1. La cabecera del conteo ─────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('route_counts'))) {
    await knex.raw(`
      CREATE TABLE commercial.route_counts (
        id              uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        warehouse_id    uuid NOT NULL,

        -- El dia que se conto. Lo DECLARA la persona: no se deduce del archivo ni del reloj.
        count_date      date NOT NULL,

        status          varchar(16) NOT NULL DEFAULT 'active',
        source          varchar(16) NOT NULL DEFAULT 'excel',

        -- Lo que el papel/archivo dice que suma, para contrastarlo contra la suma de los renglones.
        -- NULL = el origen no lo declaro; NUNCA 0 (ADR-056).
        declared_total  numeric(14,2),
        note            text,

        counted_by          uuid,
        counted_by_username varchar(80),

        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        deleted_at      timestamptz,

        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),

        CONSTRAINT commercial_route_counts_status_chk
          CHECK (status IN ('active','superseded','cancelled')),
        CONSTRAINT commercial_route_counts_source_chk
          CHECK (source IN ('excel','manual','kepler')),
        -- Un total declarado de 0 es "no lo declararon", y eso se escribe NULL.
        CONSTRAINT commercial_route_counts_total_chk
          CHECK (declared_total IS NULL OR declared_total > 0)
      )`);
    // Un conteo por ruta y por dia. Un segundo conteo del mismo dia se corrige, no se duplica.
    await knex.raw(`
      CREATE UNIQUE INDEX ux_route_counts_dia
        ON commercial.route_counts (tenant_id, warehouse_id, count_date)
        WHERE status <> 'cancelled' AND deleted_at IS NULL`);
    // El ledger pregunta siempre lo mismo: el ultimo conteo vigente de esta ruta.
    await knex.raw(`
      CREATE INDEX ix_route_counts_vigente
        ON commercial.route_counts (tenant_id, warehouse_id, count_date DESC)
        WHERE status = 'active' AND deleted_at IS NULL`);
  }

  // ── 2. Los renglones ──────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('route_count_lines'))) {
    await knex.raw(`
      CREATE TABLE commercial.route_count_lines (
        id              uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        count_id        uuid NOT NULL,

        sku             varchar(40) NOT NULL,
        -- La unidad es parte de la llave: el mismo SKU contado en PZA y en CJA son dos renglones,
        -- y confundirlos es el error que ADR-055/057 documentan en todo el proyecto.
        unidad          varchar(16) NOT NULL,
        descripcion     varchar(200),

        qty             numeric(14,3) NOT NULL,
        -- El costo que IMPRIME el origen. Alimenta la valuacion cuando la ruta no tiene carga
        -- posterior al conteo. NULL = el origen no lo trajo.
        costo_unitario  numeric(14,4),
        importe         numeric(14,2),

        created_at      timestamptz NOT NULL DEFAULT now(),

        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, count_id, sku, unidad),
        CONSTRAINT commercial_route_count_lines_count_fk
          FOREIGN KEY (tenant_id, count_id) REFERENCES commercial.route_counts (tenant_id, id)
          ON DELETE CASCADE,
        -- Contar en negativo no es contar. Un cero SI es valido: "lo busque y no hay".
        CONSTRAINT commercial_route_count_lines_qty_chk CHECK (qty >= 0)
      )`);
    await knex.raw(`
      CREATE INDEX ix_route_count_lines_conteo
        ON commercial.route_count_lines (tenant_id, count_id)`);
  }

  for (const t of ['commercial.route_counts', 'commercial.route_count_lines']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${t}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${t} TO app_runtime`);
  }
  await knex.raw(`
    COMMENT ON TABLE commercial.route_counts IS
      '[RD.31] Conteo fisico de un camion de ruta. Dato propio HITL: Kepler NO publica saldo de ruta
       y no existe documento de retorno, asi que sin esto el saldo arrastra para siempre la mercancia
       que el camion ya traia. Un conteo RESETEA: lo que no lista queda en cero. Es el saldo de CIERRE
       de su dia, los movimientos entran despues (> count_date).'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.route_counts.count_date IS
      'La DECLARA la persona, no se deduce del archivo: el que origino esta fase se llamaba
       "rd21 05-sep.xlsx" y era del 5 de OCTUBRE (36 costos de octubre contra 0 de septiembre).'`);

  // ── 3. El ledger ancla en el ultimo conteo vigente ────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH ancla AS (
      SELECT i.tenant_id, i.route_no, i.suc_emisor, i.almacen_erp, i.warehouse_id,
             k.id AS conteo_id, k.count_date AS conteo_fecha,
             -- Con conteo: el dia DESPUES. Sin conteo: lo de siempre. GREATEST por si el conteo
             -- fuera anterior al ancla de RD.30 (no deberia, pero no se asume).
             GREATEST(i.carga_desde, coalesce(k.count_date + 1, i.carga_desde)) AS desde
        FROM analytics.mv_rd_route_identity i
        LEFT JOIN LATERAL (
             SELECT rc.id, rc.count_date
               FROM commercial.route_counts rc
              WHERE rc.tenant_id = i.tenant_id AND rc.warehouse_id = i.warehouse_id
                AND rc.status = 'active' AND rc.deleted_at IS NULL
              ORDER BY rc.count_date DESC LIMIT 1
        ) k ON true
    ), conteo AS (
      SELECT a.tenant_id, a.route_no, a.conteo_fecha AS business_date,
             btrim(l.sku) AS sku, btrim(l.unidad) AS unidad,
             sum(l.qty)             AS qty,
             sum(l.importe)         AS costo_doc
        FROM ancla a
        JOIN commercial.route_count_lines l
          ON l.tenant_id = a.tenant_id AND l.count_id = a.conteo_id
       WHERE a.conteo_id IS NOT NULL AND l.qty > 0
       GROUP BY 1,2,3,4,5
    ), carga AS (
      SELECT a.tenant_id, a.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c9::numeric)  AS qty,
             sum(d.c13::numeric) AS costo_doc
        FROM ancla a
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = a.suc_emisor AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
         AND h.c9::date >= a.desde
         AND h.c10 IN (${ROTULOS})
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','')
       GROUP BY 1,2,3,4,5
    ), costo_erp AS (
      SELECT a.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c62::numeric) AS costo_erp
        FROM ancla a
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = a.suc_emisor AND h.c1 = a.almacen_erp
         AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 10 AND h.c9::date >= a.desde
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE a.almacen_erp IS NOT NULL AND nullif(btrim(d.c62),'') IS NOT NULL
       GROUP BY 1,2,3,4
    ), venta AS (
      SELECT p.tenant_id, a.route_no, p.business_date,
             btrim(p.sku) AS sku, btrim(p.unidad) AS unidad,
             sum(p.qty)     AS qty,
             sum(p.importe) AS venta_doc
        FROM ancla a
        JOIN analytics.route_push_lines p
          ON p.route_no = a.route_no AND p.tenant_id = a.tenant_id
         AND p.business_date >= a.desde
       WHERE coalesce(btrim(p.unidad),'') <> ''
       GROUP BY 1,2,3,4,5
    )
    SELECT tenant_id, route_no, business_date, 'conteo'::text AS clase, sku, unidad,
           qty, costo_doc, NULL::numeric AS venta_doc, NULL::numeric AS costo_erp
      FROM conteo
    UNION ALL
    SELECT tenant_id, route_no, business_date, 'carga'::text, sku, unidad,
           qty, costo_doc, NULL::numeric, NULL::numeric
      FROM carga
    UNION ALL
    SELECT v.tenant_id, v.route_no, v.business_date, 'venta'::text, v.sku, v.unidad,
           v.qty, NULL::numeric, v.venta_doc, e.costo_erp
      FROM venta v
      LEFT JOIN costo_erp e
        ON e.route_no = v.route_no AND e.business_date = v.business_date
       AND e.sku = v.sku AND e.unidad = v.unidad
  `);

  // ── 4. El resolvedor aprende del conteo ───────────────────────────────────────────────────
  // `carga_qty`/`carga_imp` NO cambian de significado: el conteo viaja aparte dentro del CTE.
  // `saldo_qty` SI lo incluye, porque es el saldo. `costo_u` lo usa entre la ruta y la ficha.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${UNIT} AS
    WITH base AS (
      SELECT l.tenant_id, l.route_no, i.suc_emisor, l.sku, l.unidad,
             sum(l.qty)        FILTER (WHERE l.clase = 'carga')  AS carga_qty,
             sum(l.costo_doc)  FILTER (WHERE l.clase = 'carga')  AS carga_imp,
             sum(l.qty)        FILTER (WHERE l.clase = 'venta')  AS venta_qty,
             sum(l.venta_doc)  FILTER (WHERE l.clase = 'venta')  AS venta_imp,
             sum(l.qty)        FILTER (WHERE l.clase = 'conteo') AS conteo_qty,
             sum(l.costo_doc)  FILTER (WHERE l.clase = 'conteo') AS conteo_imp
        FROM analytics.mv_rd_route_ledger l
        JOIN analytics.mv_rd_route_identity i
          ON i.tenant_id = l.tenant_id AND i.route_no = l.route_no
       GROUP BY l.tenant_id, l.route_no, i.suc_emisor, l.sku, l.unidad
    ), escalera AS (
      SELECT k.sucursal, btrim(k.c1) AS sku, btrim(k.c11) AS unidad,
             nullif(nullif(btrim(k.c77),''),'0')::numeric AS costo,
             nullif(k.c90, 0::numeric) AS precio, 'base'::text AS peldano
        FROM kepler_ods.kdii k WHERE btrim(coalesce(k.c11,'')) <> ''
      UNION ALL
      SELECT k.sucursal, btrim(k.c1), btrim(k.c80), nullif(k.c78,0), nullif(k.c91,0), 'dos'
        FROM kepler_ods.kdii k
       WHERE btrim(coalesce(k.c80,'')) <> '' AND btrim(coalesce(k.c80,'')) <> btrim(coalesce(k.c11,''))
      UNION ALL
      SELECT k.sucursal, btrim(k.c1), btrim(k.c83), nullif(k.c79,0), nullif(k.c92,0), 'tres'
        FROM kepler_ods.kdii k
       WHERE btrim(coalesce(k.c83,'')) <> '' AND btrim(coalesce(k.c83,'')) <> btrim(coalesce(k.c11,''))
         AND btrim(coalesce(k.c83,'')) <> btrim(coalesce(k.c80,''))
    ), f AS (
      SELECT sucursal, sku, unidad, max(costo) AS costo, max(precio) AS precio
        FROM escalera GROUP BY sucursal, sku, unidad
    )
    SELECT b.tenant_id, b.route_no, b.sku, b.unidad,
           b.carga_qty, b.carga_imp, b.venta_qty, b.venta_imp,
           coalesce(b.carga_qty,0) + coalesce(b.conteo_qty,0) - coalesce(b.venta_qty,0) AS saldo_qty,
           coalesce(b.carga_imp / nullif(b.carga_qty,0),
                    b.conteo_imp / nullif(b.conteo_qty,0),
                    f.costo)                                                            AS costo_u,
           CASE WHEN (b.carga_imp  / nullif(b.carga_qty,0))  IS NOT NULL THEN 'ruta'
                WHEN (b.conteo_imp / nullif(b.conteo_qty,0)) IS NOT NULL THEN 'conteo'
                WHEN f.costo IS NOT NULL THEN 'kepler' END                              AS origen_costo,
           coalesce(b.venta_imp / nullif(b.venta_qty,0), f.precio)                       AS precio_u,
           CASE WHEN (b.venta_imp / nullif(b.venta_qty,0)) IS NOT NULL THEN 'ruta'
                WHEN f.precio IS NOT NULL THEN 'kepler' END                              AS origen_precio
      FROM base b
      LEFT JOIN f ON f.sucursal = b.suc_emisor AND f.sku = b.sku AND f.unidad = b.unidad
  `);

  // ⚠️ `security_invoker` y el GRANT NO los hereda un `CREATE OR REPLACE VIEW` (GOTCHAS).
  for (const v of [LEDGER, UNIT]) {
    await knex.raw(`ALTER VIEW ${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON ${v} TO app_runtime`);
  }

  for (const mv of ['analytics.mv_rd_route_ledger', 'analytics.mv_rd_route_unit_value']) {
    const t0 = Date.now();
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
    console.log(`  · [RD.31] ${mv} refrescada en ${Date.now() - t0} ms`);
  }

  // ── 5. Frenos ─────────────────────────────────────────────────────────────────────────────
  // Sin conteos registrados, esta migracion TIENE que ser un no-op: si el ledger cambio de
  // tamaño o aparecieron filas 'conteo', algo se escribio que no debia.
  const { rows } = await knex.raw(`
    SELECT (SELECT count(*) FROM commercial.route_counts)::int                      AS conteos,
           (SELECT count(*) FROM analytics.mv_rd_route_ledger WHERE clase='conteo')::int AS filas_conteo,
           (SELECT count(DISTINCT clase) FROM analytics.mv_rd_route_ledger)::int    AS clases,
           (SELECT round(sum(costo_doc),2) FROM analytics.mv_rd_route_ledger
             WHERE clase='carga' AND route_no='21')::float                          AS carga_21`);
  const r = rows[0];
  if (Number(r.conteos) === 0 && Number(r.filas_conteo) > 0) {
    throw new Error(`[RD.31] hay ${r.filas_conteo} filas de conteo sin un solo conteo registrado`);
  }
  if (Number(r.conteos) === 0 && !(Number(r.carga_21) > 1056801.12)) {
    throw new Error(`[RD.31] la carga de la 21 (${r.carga_21}) no conserva lo que RD.30 dejo`);
  }
  console.log(`  · [RD.31] ${r.conteos} conteo(s) · ${r.filas_conteo} fila(s) clase 'conteo' · ${r.clases} clase(s) · carga 21 = ${r.carga_21}`);
};

exports.down = async function down(knex) {
  // Las vistas vuelven a la forma de RD.30 (sin la clase 'conteo' ni el origen 'conteo').
  await knex.raw(`
    CREATE OR REPLACE VIEW ${UNIT} AS
    WITH base AS (
      SELECT l.tenant_id, l.route_no, i.suc_emisor, l.sku, l.unidad,
             sum(l.qty)       FILTER (WHERE l.clase='carga') AS carga_qty,
             sum(l.costo_doc) FILTER (WHERE l.clase='carga') AS carga_imp,
             sum(l.qty)       FILTER (WHERE l.clase='venta') AS venta_qty,
             sum(l.venta_doc) FILTER (WHERE l.clase='venta') AS venta_imp
        FROM analytics.mv_rd_route_ledger l
        JOIN analytics.mv_rd_route_identity i
          ON i.tenant_id = l.tenant_id AND i.route_no = l.route_no
       GROUP BY l.tenant_id, l.route_no, i.suc_emisor, l.sku, l.unidad
    ), escalera AS (
      SELECT k.sucursal, btrim(k.c1) AS sku, btrim(k.c11) AS unidad,
             nullif(nullif(btrim(k.c77),''),'0')::numeric AS costo,
             nullif(k.c90,0::numeric) AS precio, 'base'::text AS peldano
        FROM kepler_ods.kdii k WHERE btrim(coalesce(k.c11,'')) <> ''
      UNION ALL
      SELECT k.sucursal, btrim(k.c1), btrim(k.c80), nullif(k.c78,0), nullif(k.c91,0), 'dos'
        FROM kepler_ods.kdii k
       WHERE btrim(coalesce(k.c80,'')) <> '' AND btrim(coalesce(k.c80,'')) <> btrim(coalesce(k.c11,''))
      UNION ALL
      SELECT k.sucursal, btrim(k.c1), btrim(k.c83), nullif(k.c79,0), nullif(k.c92,0), 'tres'
        FROM kepler_ods.kdii k
       WHERE btrim(coalesce(k.c83,'')) <> '' AND btrim(coalesce(k.c83,'')) <> btrim(coalesce(k.c11,''))
         AND btrim(coalesce(k.c83,'')) <> btrim(coalesce(k.c80,''))
    ), f AS (
      SELECT sucursal, sku, unidad, max(costo) AS costo, max(precio) AS precio
        FROM escalera GROUP BY sucursal, sku, unidad
    )
    SELECT b.tenant_id, b.route_no, b.sku, b.unidad,
           b.carga_qty, b.carga_imp, b.venta_qty, b.venta_imp,
           coalesce(b.carga_qty,0) - coalesce(b.venta_qty,0) AS saldo_qty,
           coalesce(b.carga_imp / nullif(b.carga_qty,0), f.costo) AS costo_u,
           CASE WHEN (b.carga_imp / nullif(b.carga_qty,0)) IS NOT NULL THEN 'ruta'
                WHEN f.costo IS NOT NULL THEN 'kepler' END AS origen_costo,
           coalesce(b.venta_imp / nullif(b.venta_qty,0), f.precio) AS precio_u,
           CASE WHEN (b.venta_imp / nullif(b.venta_qty,0)) IS NOT NULL THEN 'ruta'
                WHEN f.precio IS NOT NULL THEN 'kepler' END AS origen_precio
      FROM base b
      LEFT JOIN f ON f.sucursal = b.suc_emisor AND f.sku = b.sku AND f.unidad = b.unidad
  `);
  await knex.raw(`
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH ancla AS (
      SELECT i.tenant_id, i.route_no, i.suc_emisor, i.almacen_erp, i.warehouse_id,
             i.carga_desde AS desde
        FROM analytics.mv_rd_route_identity i
    ), carga AS (
      SELECT a.tenant_id, a.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c9::numeric) AS qty, sum(d.c13::numeric) AS costo_doc
        FROM ancla a
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = a.suc_emisor AND h.c2='U' AND h.c3='D' AND h.c4=41
         AND h.c9::date >= a.desde AND h.c10 IN (${ROTULOS})
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','')
       GROUP BY 1,2,3,4,5
    ), costo_erp AS (
      SELECT a.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad, sum(d.c62::numeric) AS costo_erp
        FROM ancla a
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = a.suc_emisor AND h.c1 = a.almacen_erp
         AND h.c2='U' AND h.c3='D' AND h.c4=10 AND h.c9::date >= a.desde
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE a.almacen_erp IS NOT NULL AND nullif(btrim(d.c62),'') IS NOT NULL
       GROUP BY 1,2,3,4
    ), venta AS (
      SELECT p.tenant_id, a.route_no, p.business_date,
             btrim(p.sku) AS sku, btrim(p.unidad) AS unidad,
             sum(p.qty) AS qty, sum(p.importe) AS venta_doc
        FROM ancla a
        JOIN analytics.route_push_lines p
          ON p.route_no = a.route_no AND p.tenant_id = a.tenant_id AND p.business_date >= a.desde
       WHERE coalesce(btrim(p.unidad),'') <> ''
       GROUP BY 1,2,3,4,5
    )
    SELECT tenant_id, route_no, business_date, 'carga'::text AS clase, sku, unidad,
           qty, costo_doc, NULL::numeric AS venta_doc, NULL::numeric AS costo_erp
      FROM carga
    UNION ALL
    SELECT v.tenant_id, v.route_no, v.business_date, 'venta'::text, v.sku, v.unidad,
           v.qty, NULL::numeric, v.venta_doc, e.costo_erp
      FROM venta v
      LEFT JOIN costo_erp e
        ON e.route_no = v.route_no AND e.business_date = v.business_date
       AND e.sku = v.sku AND e.unidad = v.unidad
  `);
  for (const v of [LEDGER, UNIT]) {
    await knex.raw(`ALTER VIEW ${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON ${v} TO app_runtime`);
  }
  for (const mv of ['analytics.mv_rd_route_ledger', 'analytics.mv_rd_route_unit_value']) {
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
  }
  await knex.raw(`DROP TABLE IF EXISTS commercial.route_count_lines`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.route_counts`);
};
