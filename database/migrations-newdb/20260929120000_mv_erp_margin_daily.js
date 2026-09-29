'use strict';
/**
 * `[MR.8.2]` — **El árbitro del margen.** El costo del renglón que registró Kepler
 * (`kdm2.c62`), puesto al lado del costo que la pantalla publica hoy.
 *
 * ── Qué arbitra, y contra qué ───────────────────────────────────────────────────────────────
 * `analytics.mv_sales_blended.cost` tiene TRES orígenes. En la pierna Kepler (69.2% de la venta,
 * $37.2M/30d) es `round(monto / (1 + COALESCE(markup_pct,0)/100), 2)`: **álgebra del catálogo,
 * no un costo**. Su margen es `m/(1+m/100)` — función EXCLUSIVAMENTE del markup, así que no
 * puede descubrir que algo se vende bajo costo ni distinguir una plaza de otra.
 *
 * El testigo independiente es `kdm2.c62`, el costo que el ERP escribió EN el renglón de venta.
 * Sale de otra tabla, por otro camino, sin insumos compartidos con el markup del catálogo.
 *
 * ── Lo medido antes de construir esto (`[MR.8.1]`, prod, 30d) ───────────────────────────────
 * Ver `docs/IMPLEMENTACION/FASES/FASE_MR8_MEDICION_ARBITRO.md`. Los cinco gates:
 *   · ANTI-ESPEJO: spread de margen entre sucursales del MISMO sku = **3.0310 pp** con el
 *     árbitro contra **0.0000 pp** con el álgebra (210 de 249 skus). No es el markup con otro
 *     nombre: un margen `m/(1+m)` NO PUEDE tener spread entre almacenes.
 *   · CONTRADICE: mostrador 14.91% contra 10.75% = **+4.16 pp**. Por sucursal, de +1.93 a +5.44.
 *   · ACEPTACIÓN `MR.7.2`: **0.055%** de líneas con costo > venta, contra el baseline de 7.4%.
 *   · ANTI-RECORTE: hay venta bajo costo REAL (peor línea −294.8%), o sea nadie puso un piso.
 *   · POBLACIÓN: de los 7 filtros que separan al árbitro de lo publicado, **seis no tiran nada**.
 *
 * ── ⛔ Las tres decisiones que NO son obvias ────────────────────────────────────────────────
 *
 * **1. El COGS es `c62 × c56`, NUNCA `c62 × c9`.**
 * `c62` es el costo de UNA unidad del **peldaño vendido** (`c62 = u1_cost × c58`), y
 * `c9 = c56 × c58`. Multiplicar por `c9` sobrecuenta exactamente por el factor. Ése fue el
 * `−261.79%` que mantuvo este costo descartado desde agosto-2026: era un error de unidad en la
 * MEDICIÓN, no un defecto de la fuente (`FASE_MR_COSTO_Y_UNIDAD` §3, refutado en `[MR.8.1]` §7.1).
 * ⭐ Y por eso **no hace falta casar nada con `v_supplier_cost_ladder`**: Kepler DECLARA el
 * peldaño en la línea. Medido: `c56` y `c58` poblados en el **100%** de este universo.
 *
 * **2. La venta va NETA de impuesto.**
 * `c17` (IVA, 0 ó −16) y `c18` (IEPS, 0 ó −8) viven EN el renglón, y **el importe `c13` ya los
 * trae** (`ERP_KEPLER.md:436-439`; Σ`c13` = `kdm1.c16` en 99.84%). El 81% de las líneas lleva
 * impuesto. Costear un `c62` neto contra un `c13` bruto infla el margen 6.65 pp (22.61% contra
 * 15.96% en la rebanada medida). Se despeja por línea — no hay que prorratear el encabezado.
 * ⚠️ El margen PUBLICADO no sufre esto porque `revenue/(1+markup)` es invariante de escala: el
 * impuesto se cancela en el cociente. Por eso el defecto era invisible.
 *
 * **3. Esto NO cuelga de `analytics.v_erp_sales_line_units`, y no es por descuido.**
 * Esa vista es el árbitro de la UNIDAD y expone `costo_linea` (`c62`) desde 2026-09-08 sin un
 * solo consumidor. Colgarse de ella sería lo correcto por ADR-059 R6 — y NO se puede, por dos
 * cosas medidas:
 *   (a) **No expone `c5` (la caja).** A grano de renglón, `(sucursal, almacén, doctype, folio,
 *       línea, fecha)` **colisiona 34,375 veces** en 400 días: el folio se recicla POR CAJA
 *       (en los 4 buckets, el nº de cajas distintas es igual al nº de filas colisionadas).
 *   (b) **Lee `kdm2` sola filtrando por `c32`, que no tiene ni un índice.** Un `count(*)` de 7
 *       días agota 180 s.
 * Acá se maneja desde `kdm1` por `ix_kdm1_venta_fecha` y se une por la **PK COMPLETA de 7
 * columnas** (2–8 s sobre 30 días). ⚠️ NO es el join que `GOTCHAS §31` prohíbe: ése duplica por
 * filtrar la fecha de una sola punta; éste va sobre la PK **única** de `kdm1`.
 * ⭐ Y el problema de `c5` se **esquiva por grano**: esta matview agrega a
 * `(almacén × producto × día × doctype)`, así que su llave única es el propio `GROUP BY`.
 * **Deuda declarada:** el día que `v_erp_sales_line_units` gane `c5` y un camino por fecha
 * indexado, este cuerpo debería leerla a ella. Hoy son dos lecturas de `kdm2` para preguntas
 * distintas (unidad / costo), y eso queda dicho, no escondido.
 *
 * ── Por qué `WITH NO DATA`, y cuánto cuesta llenarla ────────────────────────────────────────
 * El poblado a 400 días son **1,952,732 renglones** de origen. Materializarlo dentro de la
 * migración alargaría la transacción y el lock sobre una base cuyo CDC escribe cada 15 s. Se crea
 * vacía — mismo patrón que `20260903130000_v_sales_blended.js` — y el primer `REFRESH` va en la
 * ventana nocturna, por `AnalyticsRefreshService`.
 * ⚠️ Por eso **las compuertas de abajo NO se corren sobre la matview** (estaría vacía): se corren
 * sobre una sonda EN VIVO de 7 días. Es lo mismo que mide, sobre menos días.
 *
 * **Costo MEDIDO del cuerpo (prod, 2026-09-29), para que nadie lo estime:**
 * ```
 *    30 d ->  182,352 celdas ·  20.1 s
 *    90 d ->  406,653 celdas ·  47.1 s
 *   180 d ->  606,693 celdas ·  74.3 s
 *   400 d ->        ?        · >300 s  (agotó el statement_timeout; crece SUPERLINEAL,
 *                                       probablemente el sort desbordando a disco)
 * ```
 * O sea: **el primer `REFRESH` no cabe en un timeout corto** y necesita ventana. Los siguientes
 * son el mismo costo (un matview no refresca incremental). Si molesta, la palanca es **bajar la
 * ventana de 400 d**, no subir el timeout a ciegas — pero 400 d es lo que la pantalla necesita
 * para su corte de «12 meses».
 *
 * ── ⚠️ RLS: por qué esto se llena, y cómo podría llenarse VACÍO ─────────────────────────────
 * El cuerpo toca `catalog.products` y `commercial.warehouses`, y las dos tienen **FORCE ROW LEVEL
 * SECURITY** (verificado: `relforcerowsecurity = true`, dueño `postgres`). Con RLS activa el plan
 * mete un `One-Time Filter` sobre `current_setting('app.tenant_id')`: **si esa variable no está
 * puesta, el filtro da falso y la consulta devuelve CERO filas sin error**.
 *
 * Hoy no pasa porque el refresh corre con `KNEX_NEW_DB_ADMIN` = `postgres`, que es
 * **`rolsuper` + `rolbypassrls`** (verificado), y un superusuario ignora RLS incluso forzada.
 * ⛔ **Si alguna vez el refresh se mueve a un rol sin `BYPASSRLS`, esta matview se materializa
 * vacía y el sensor la va a ver «poblada y fresca».** Por eso el candado de `[MR.8.4]` tiene que
 * aseverar que tiene filas, no sólo que existe.
 *
 * Aditiva e idempotente. **No toca ningún objeto existente.**
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

/**
 * El sub-almacén de ruta de Kepler → el almacén de la plataforma.
 *
 * Es una **decisión**, no algo derivable: `commercial.warehouses.kepler_code` está en NULL para
 * las camionetas y poblarlo NO es opción — 108 archivos leen esa columna y varios la usan como
 * «¿es sucursal Kepler?», así que llenarla para trucks cambiaría su comportamiento en silencio.
 *
 * Hoy este mapeo vive **hardcodeado dentro de `v_erp_sales_line_units`**. Sacarlo a una tabla es
 * lo que pide ADR-059 R6 (un primitivo con dos implementaciones diverge) y calca el molde de
 * `analytics.sellout_channel_map` de `[VSO.1]`: el dato con su evidencia al lado.
 */
const RUTAS = [
  ['01', '01-001', 'RUTA-21'],
  ['01', '01-002', 'RUTA-22'],
  ['01', '01-003', 'RUTA-23'],
  ['01', '01-004', 'RUTA-26'],
  ['01', '01-005', 'RUTA-27'],
  ['01', '01-006', 'RUTA-28'],
];

/** Doctypes de VENTA que entran. Los mismos que `mv_kepler_sales_daily` y el árbitro de unidad. */
const DOCTYPES = ['8', '10', '12'];

/** Numérico tolerante: el ODS guarda estas columnas como texto con basura. */
const N = (x, d) => `round(NULLIF(regexp_replace(${x}::text, '[^0-9.-]', '', 'g'), '')::numeric, ${d})`;

/**
 * El cuerpo. Se usa DOS veces: para la matview (sin tope de fecha superior) y para la sonda de
 * las compuertas (7 días). Un solo origen — si divergen, la compuerta deja de medir lo que se crea.
 */
const cuerpo = (filtroFecha) => `
  WITH lin AS (
    SELECT btrim(h.sucursal)                                   AS sucursal,
           btrim(l.c1)                                         AS almacen_erp,
           h.c4::int                                           AS doctype,
           h.c9::date                                          AS sale_date,
           btrim(l.c8)                                         AS sku,
           ${N('l.c9', 4)}                                     AS q_base,
           ${N('l.c56', 4)}                                    AS q_vend,
           ${N('l.c58', 4)}                                    AS factor,
           ${N('l.c13', 2)}                                    AS importe,
           ${N('l.c62', 6)}                                    AS costo_unit,
           COALESCE(${N('l.c17', 4)}, 0)                       AS tasa_iva,
           COALESCE(${N('l.c18', 4)}, 0)                       AS tasa_ieps
      FROM kepler_ods.kdm1 h
      JOIN kepler_ods.kdm2 l
        ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
       AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
     WHERE h.c2 = 'U' AND h.c3 = 'D'
       AND btrim(h.c4::text) IN (${DOCTYPES.map((d) => `'${d}'`).join(', ')})
       AND ${filtroFecha}
       -- Cancelado: lo excluye el publicado y acá también, para medir el MISMO universo.
       -- Medido en 30d: tira 0 líneas. Se deja igual porque la ausencia de hoy no es garantía.
       AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
       AND COALESCE(btrim(l.c11), '') <> 'SER'
       AND abs(COALESCE(${N('l.c9', 4)}, 0)) > 0
  ), calc AS (
    SELECT lin.*,
           -- La venta, NETA. El importe del ERP ya trae IVA e IEPS (decisión 2 del encabezado).
           importe / (1 + abs(tasa_iva) / 100 + abs(tasa_ieps) / 100)      AS neto,
           -- El COGS. c56 es la cantidad EN EL PELDANO que c62 cuesta (decision 1 del encabezado).
           -- q_base solo como respaldo: medido, c56 viene poblado en el 100% de este universo.
           CASE WHEN costo_unit > 0
                THEN costo_unit * COALESCE(q_vend, q_base) END             AS cogs
      FROM lin
  )
  SELECT '${TENANT}'::uuid                                                 AS tenant_id,
         w.id                                                              AS warehouse_id,
         w.code                                                            AS warehouse_code,
         p.id                                                              AS product_id,
         c.sku,
         c.sale_date,
         c.doctype,
         (m.warehouse_code IS NOT NULL)                                    AS es_ruta,
         COUNT(*)::int                                                     AS lineas,
         COUNT(*) FILTER (WHERE c.cogs IS NOT NULL)::int                   AS lineas_con_costo,
         COUNT(*) FILTER (WHERE c.cogs > c.neto)::int                      AS lineas_costo_gt_venta,
         ROUND(SUM(c.importe), 2)                                          AS venta_bruta,
         ROUND(SUM(c.neto), 2)                                             AS venta_neta,
         -- El denominador HONESTO del margen: sólo la venta que trae costo con qué juzgarla.
         ROUND(SUM(c.neto) FILTER (WHERE c.cogs IS NOT NULL), 2)           AS venta_neta_costeada,
         ROUND(SUM(c.cogs), 2)                                             AS cogs_arbitrado,
         ROUND(SUM(COALESCE(c.q_vend, c.q_base)), 4)                       AS unidades_vendidas,
         -- El METODO por celda. sin_costo es NULL con motivo, nunca un cero:
         -- una celda de U-D-8 no vale 0% de margen, no se puede opinar sobre ella.
         CASE WHEN COUNT(*) FILTER (WHERE c.cogs IS NOT NULL) = 0          THEN 'sin_costo'
              WHEN COUNT(*) FILTER (WHERE c.cogs IS NOT NULL) = COUNT(*)   THEN 'erp_linea'
              ELSE                                                              'mixto' END AS metodo_costo
    FROM calc c
    LEFT JOIN analytics.erp_warehouse_map m
           ON m.tenant_id = '${TENANT}'::uuid
          AND m.sucursal = c.sucursal
          AND m.almacen_erp = c.almacen_erp
    JOIN commercial.warehouses w
      ON w.tenant_id = '${TENANT}'::uuid
     AND w.deleted_at IS NULL
     AND w.code::text = COALESCE(m.warehouse_code, c.sucursal)
    JOIN catalog.products p
      ON p.tenant_id = '${TENANT}'::uuid
     AND btrim(p.sku::text) = c.sku
     AND p.deleted_at IS NULL
   GROUP BY w.id, w.code, p.id, c.sku, c.sale_date, c.doctype, (m.warehouse_code IS NOT NULL)`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. El resolvedor de almacén ERP → plataforma ──────────────────────────────────────────
  if (!(await knex.schema.withSchema('analytics').hasTable('erp_warehouse_map'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_warehouse_map (
        tenant_id       uuid NOT NULL,
        sucursal        text NOT NULL,
        almacen_erp     text NOT NULL,
        warehouse_code  text NOT NULL,
        evidencia       text,
        created_at      timestamptz DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, sucursal, almacen_erp)
      )`);
    await knex.raw(`GRANT SELECT ON analytics.erp_warehouse_map TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE analytics.erp_warehouse_map IS
      $$[MR.8.2] Sub-almacen de Kepler -> almacen de la plataforma. DECISION, no derivable:
      commercial.warehouses.kepler_code esta NULL para las camionetas y poblarlo cambiaria el
      comportamiento de los 108 archivos que leen esa columna (varios la usan como "es sucursal
      Kepler"). Hoy el mismo mapeo esta hardcodeado dentro de analytics.v_erp_sales_line_units:
      esta tabla existe para que deje de haber dos copias (ADR-059 R6). Molde: sellout_channel_map.$$`);
  }
  for (const [suc, alm, code] of RUTAS) {
    await knex.raw(
      `INSERT INTO analytics.erp_warehouse_map (tenant_id, sucursal, almacen_erp, warehouse_code, evidencia)
       VALUES (?::uuid, ?, ?, ?, ?) ON CONFLICT (tenant_id, sucursal, almacen_erp) DO NOTHING`,
      [TENANT, suc, alm, code, 'Ruta de la suc 01; el mismo mapeo que v_erp_sales_line_units trae hardcodeado'],
    );
  }
  const { rows: mapRows } = await knex.raw(
    `SELECT COUNT(*)::int n FROM analytics.erp_warehouse_map WHERE tenant_id = ?::uuid`, [TENANT],
  );
  console.log(`  · [MR.8.2] erp_warehouse_map: ${mapRows[0].n} fila(s).`);

  // Compuerta: cada destino del mapa tiene que existir como almacen vivo, o el JOIN de la
  // matview tira esas ventas EN SILENCIO (y son las rutas: $2.34M/30d).
  const { rows: huerfanos } = await knex.raw(
    `SELECT m.warehouse_code FROM analytics.erp_warehouse_map m
      WHERE m.tenant_id = ?::uuid
        AND NOT EXISTS (SELECT 1 FROM commercial.warehouses w
                         WHERE w.tenant_id = m.tenant_id AND w.deleted_at IS NULL
                           AND w.code::text = m.warehouse_code)`, [TENANT],
  );
  if (huerfanos.length) {
    throw new Error(
      `[MR.8.2] el mapa apunta a ${huerfanos.length} almacen(es) que no existen: ` +
        `${huerfanos.map((r) => r.warehouse_code).join(', ')}. La venta de esas rutas se perderia en el JOIN.`,
    );
  }

  // ── 2. Las compuertas, sobre una sonda EN VIVO de 7 dias ──────────────────────────────────
  // No se corren sobre la matview porque nace vacia (ver encabezado). Miden lo mismo.
  const { rows: g } = await knex.raw(`
    WITH celda AS (${cuerpo(`h.c9::date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE`)}),
    arb AS (
      SELECT warehouse_code, sku,
             SUM(venta_neta_costeada) v, SUM(cogs_arbitrado) c, SUM(lineas_costo_gt_venta) gt,
             SUM(lineas) n
        FROM celda WHERE venta_neta_costeada > 0 GROUP BY 1, 2),
    spread AS (
      SELECT sku, MAX(100 * (1 - c / NULLIF(v, 0))) - MIN(100 * (1 - c / NULLIF(v, 0))) s
        FROM arb WHERE v > 5000 GROUP BY sku HAVING COUNT(*) >= 2)
    SELECT (SELECT COUNT(*) FROM celda)::int                                      AS celdas,
           (SELECT COALESCE(SUM(lineas), 0) FROM celda)::int                      AS lineas,
           (SELECT COALESCE(SUM(gt), 0) FROM arb)::int                            AS costo_gt_venta,
           (SELECT ROUND(100.0 * SUM(gt) / NULLIF(SUM(n), 0), 3) FROM arb)        AS pct_gt,
           (SELECT ROUND(100 * (1 - SUM(c) / NULLIF(SUM(v), 0)), 2) FROM arb)     AS margen_arbitro,
           (SELECT COUNT(*) FROM spread WHERE s > 1)::int                         AS skus_con_spread,
           (SELECT ROUND(MIN(100 * (1 - c / NULLIF(v, 0))), 1) FROM arb)          AS peor_margen,
           (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE metodo_costo = 'erp_linea')
                         / NULLIF(COUNT(*), 0), 2) FROM celda)                    AS pct_celdas_costeadas`);
  const s = g[0];
  console.log(
    `  · [MR.8.2] sonda 7d: ${s.celdas} celdas / ${s.lineas} lineas · margen arbitro ${s.margen_arbitro}% · ` +
      `costo>venta ${s.costo_gt_venta} (${s.pct_gt}%) · skus con spread ${s.skus_con_spread} · ` +
      `celdas 100% costeadas ${s.pct_celdas_costeadas}%`,
  );

  // (a) NO ES ESPEJO. Si el arbitro no produjera spread entre sucursales del mismo sku, seria el
  //     markup con otro nombre: el algebra da 0.0000 pp por construccion. Medido a 30d: 210 skus.
  if (!(s.skus_con_spread > 0)) {
    throw new Error(
      '[MR.8.2] cero skus con spread de margen entre sucursales: el arbitro esta reproduciendo el ' +
        'markup, no arbitrando nada (ADR-059 R5, un arbitro que nunca contradice es un espejo).',
    );
  }
  // (b) ANTI-RECORTE. Si nadie vende NUNCA bajo costo, alguien puso un piso (LEAST(cogs, importe)).
  //     Medido a 30d: existe, peor linea -294.8%.
  if (!(Number(s.peor_margen) < 0)) {
    throw new Error(
      `[MR.8.2] el peor margen es ${s.peor_margen}%: no hay ni una venta bajo costo. ` +
        'Eso no pasa en un catalogo real — hay un recorte escondido en el calculo del COGS.',
    );
  }
  // (c) ACEPTACION MR.7.2. El baseline documentado es 7.4%; a 30d medimos 0.055%.
  //     Tope en 1% (no en 0): hay venta bajo costo legitima y recortarla seria inventar.
  if (!(Number(s.pct_gt) < 1)) {
    throw new Error(
      `[MR.8.2] ${s.pct_gt}% de lineas con costo > venta (tope 1%, baseline historico 7.4%). ` +
        'Sugiere que el COGS volvio a multiplicar por la cantidad BASE en vez de la del peldano.',
    );
  }
  // (d) COBERTURA. Si se desploma, el arbitro dejo de ver lo que veia.
  if (!(Number(s.pct_celdas_costeadas) > 50)) {
    throw new Error(
      `[MR.8.2] solo ${s.pct_celdas_costeadas}% de las celdas tienen costo en TODAS sus lineas ` +
        '(se midieron ~72% a 30d). El arbitro perdio cobertura.',
    );
  }

  // ── 3. La matview ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_margin_daily`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_erp_margin_daily AS
    ${cuerpo(`h.c9::date >= CURRENT_DATE - 400`)}
    WITH NO DATA`);

  // La llave unica ES el GROUP BY, asi se esquiva el problema de `c5` (ver encabezado).
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_erp_margin_daily
        ON analytics.mv_erp_margin_daily (tenant_id, warehouse_id, product_id, sale_date, doctype)`);
  await knex.raw(`
    CREATE INDEX ix_mv_erp_margin_daily_fecha
        ON analytics.mv_erp_margin_daily (tenant_id, sale_date)
     INCLUDE (warehouse_id, product_id, doctype, venta_neta_costeada, cogs_arbitrado, metodo_costo)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_erp_margin_daily TO app_runtime`);

  // ⛔ `security_invoker` es propiedad de VISTAS, no de matviews: su ausencia aca es correcta y
  // se escribe para que nadie venga del patron de al lado a "arreglarlo".
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_erp_margin_daily IS
    $$[MR.8.2] EL ARBITRO DEL MARGEN. Costo del renglon de Kepler (kdm2.c62) al grano
    almacen x producto x dia x doctype, para contrastar contra mv_sales_blended.cost — que en la
    pierna Kepler es monto/(1+markup_pct), algebra del catalogo y no un costo.

    REGLAS DURAS AL LEER:
      · cogs_arbitrado usa c62 x c56 (la cantidad del PELDANO vendido), NUNCA c62 x c9. Ese error
        de unidad es el -261.79% que mantuvo este costo descartado desde agosto-2026.
      · venta_neta ya descuenta IVA/IEPS (c17/c18 estan en el renglon y c13 los trae). El margen
        se calcula sobre venta_neta_costeada, no sobre venta_bruta.
      · metodo_costo = 'sin_costo' significa NO MEDIDO, no 0% de margen. U-D-8 (mayoreo) tiene c62
        en el 1.16% de las lineas sobre $10.26M: no se puede opinar sobre esas celdas.
      · NO agregar el margen a nivel global. El arbitro ve mostrador y no ve mayoreo: un agregado
        sale sesgado hacia arriba. Se publica POR CANAL con su cobertura al lado.

    NO lleva security_invoker: es propiedad de vistas, no de matviews. Filtrar por tenant_id
    explicito al leer, como el resto de analytics.

    Deuda declarada: deberia colgar de analytics.v_erp_sales_line_units (el arbitro de la unidad,
    que ya expone c62) en cuanto esa vista gane c5 y un camino por fecha indexado. Hoy no puede.$$`);

  console.log('  ✓ [MR.8.2] mv_erp_margin_daily creada WITH NO DATA (1.95M filas a 400d).');
  console.log('  ! [MR.8.2] FALTA el primer REFRESH — va en ventana nocturna, no en la migracion.');
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_margin_daily`);
  // `erp_warehouse_map` NO se borra: es dato (una decision capturada), y borrarlo perderia el
  // mapeo si alguien baja y vuelve a subir. Es aditivo e inerte sin la matview.
  console.log('  ✓ [MR.8.2] down: matview removida. erp_warehouse_map se conserva (es dato).');
};
