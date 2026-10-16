'use strict';
/**
 * `[CAT-COSTO.6]` — **Los tres costos de Kepler en una sola fuente**: `analytics.mv_kepler_costos`.
 *
 * Una fila por sucursal × producto (la ficha del catálogo de Kepler, sucursales 00–08), todo en la
 * unidad BASE de la ficha. Definiciones de Compras (2026-10-14/15), verificadas contra el ERP:
 *
 *  · **Costo estándar** = el del catálogo de productos, sobre el que se aplica el margen:
 *    `kdii.c77`. Lo congela cada venta en `kdm2.c62`. Sólo lo mueve editar la ficha.
 *  · **Último costo** = el del renglón de la última **XA2001 "Aplica Orden Entrada"** (`X-A-20`
 *    serie 1), y NADA más: ni el traspaso, ni el ajuste, ni la entrada física `X-A-40`. Costo por
 *    unidad base = `c13 / c9` (importe sin impuesto entre la cantidad en la unidad del renglón).
 *    Mismas reglas que el Historial por producto (`[CAT-COSTO.5]`): fecha `c68`, sin canceladas
 *    (`c43 = 'C'`), documento de SU sucursal (corta la réplica 03 ← 02), sin fecha futura. Si la
 *    sucursal nunca compró el producto se toma la última compra de la red y se DECLARA
 *    (`ultimo_origen = 'red'`).
 *  · **Costo promedio** = el que el kardex (`kdij`) le pone a la última SALIDA de la sucursal
 *    (venta o traspaso): es contra el que Kepler mide la utilidad.
 *  · **Última entrada** (`kdik.c16`) = referencia, NO es ninguno de los tres.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-15) ────────────────────────────────────────
 *  · `kdik.c16` es el costo de la ÚLTIMA ENTRADA (compra, traspaso o ajuste): coincide en
 *    **99.19 %** de 33,983 filas; en las 12,972 donde «promedio acumulado `c8/c5`» y «última
 *    entrada» difieren, sigue a la última entrada en **98.57 %** y al promedio en **0.02 %**. La
 *    documentación lo llamaba «promedio ponderado» (`VERDAD_ABSOLUTA` §3.4) — refutado.
 *  · El promedio del kardex sólo cambia tras una entrada (sin entrada de por medio, 99.7 % de
 *    148,741 pares de días no se mueve) y tras una compra queda ENTRE el costo anterior y el de la
 *    compra en el **89 %**: es un promedio móvil.
 *  · El renglón XA2001 coincide con la entrada física `X-A-40` al 0.5 % en el **80 %** de 16,855
 *    aplicaciones de 90 días, mediana de la razón **1.000** → `c13/c9` es unitario, en la unidad del
 *    renglón, sin impuesto.
 *  · Caso de control `70001` en la 01: estándar 66.52 · último 69.98 · promedio 69.75 · última
 *    entrada 69.98 (los cuatro, a mano, contra la pantalla de Kepler).
 *  · El cuerpo completo (87,070 fichas) corre en ~11 s → se materializa y refresca de noche.
 *
 * ── Lo que se DECLARA en vez de dibujar ─────────────────────────────────────────────────────
 *  `*_motivo` dice por qué un costo falta: `sin_estandar` · `sin_compra` · `sin_salida` ·
 *  `unidad_no_resuelta` (el rótulo de la compra o del kardex no casa con ninguna unidad de la
 *  ficha — el caso documentado de la unidad base que se contradice entre compra y catálogo:
 *  ~1,850 fichas, la lista a depurar del analista de catálogo) · `inverosimil` (fuera de 0.2×–5×
 *  del estándar). Un costo ausente es NULL, nunca 0.
 *
 * ⛔ SIN JOIN a `catalog.products` ni a tablas con RLS forzada, a propósito (lección de `[MR.9.1]`):
 *    se guarda la llave de Kepler y el servicio une. Así el refresco tampoco puede quedar vacío por
 *    un `app.tenant_id` ausente.
 *
 * Nace `WITH NO DATA`: el primer llenado lo hace el refresco nocturno (`kepler_costos`).
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const MV = 'analytics.mv_kepler_costos';

const N = (x) => `NULLIF(regexp_replace(${x}::text, '[^0-9.-]', '', 'g'), '')::numeric`;
const U = (x) => `NULLIF(upper(btrim(${x}::text)), '')`;

/** Factor de un rótulo de unidad contra la base de la ficha `f`: 1 · c81 · c84, o NULL si no casa. */
const factor = (f, u) => `CASE WHEN ${u} IS NULL THEN NULL
                               WHEN ${u} = ${f}.u1 THEN 1::numeric
                               WHEN ${u} = ${f}.u2 AND ${f}.f2 > 0 THEN ${f}.f2
                               WHEN ${u} = ${f}.u3 AND ${f}.f3 > 0 THEN ${f}.f3 END`;

/** El SELECT de la matview. `diasKardex` acota la búsqueda de la última salida/entrada. */
const cuerpo = (diasKardex = 365) => `
  WITH ficha AS (
    SELECT btrim(k.sucursal)  AS sucursal,
           btrim(k.c1)        AS sku,
           ${U('k.c11')}      AS u1,
           ${U('k.c80')}      AS u2, ${N('k.c81')} AS f2,
           ${U('k.c83')}      AS u3, ${N('k.c84')} AS f3,
           ${N('k.c77')}      AS e1
      FROM kepler_ods.kdii k
     WHERE btrim(k.sucursal) BETWEEN '00' AND '08'
  ),
  -- ÚLTIMO COSTO: renglón de la última XA2001 "Aplica Orden Entrada". Sólo compras.
  compra_doc AS (
    SELECT btrim(l.sucursal)                                  AS sucursal,
           btrim(l.c8)                                        AS sku,
           ap.c68::date                                       AS fecha,
           btrim(ap.c6::text)                                 AS folio,
           NULLIF(btrim(ap.c32::text), '')                    AS proveedor,
           ${U('l.c11')}                                      AS unidad,
           SUM(${N('l.c13')}) / NULLIF(SUM(${N('l.c9')}), 0)  AS costo_u
      FROM kepler_ods.kdm2 l
      JOIN kepler_ods.kdm1 ap
        ON ap.sucursal = l.sucursal AND ap.c1 = l.c1 AND ap.c2 = l.c2 AND ap.c3 = l.c3
       AND ap.c4 = l.c4 AND ap.c5 = l.c5 AND ap.c6 = l.c6
     WHERE l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20' AND btrim(l.c5::text) = '1'
       AND btrim(ap.c1::text) = btrim(ap.sucursal::text)
       AND btrim(coalesce(ap.c43::text, '')) <> 'C'
       AND ap.c68::date <= CURRENT_DATE
       AND ${N('l.c9')} > 0 AND ${N('l.c13')} > 0
     GROUP BY 1, 2, 3, 4, 5, 6
  ),
  compra AS (
    SELECT DISTINCT ON (sucursal, sku) * FROM compra_doc ORDER BY sucursal, sku, fecha DESC, folio DESC
  ),
  compra_red AS (
    SELECT DISTINCT ON (sku) * FROM compra_doc ORDER BY sku, fecha DESC, folio DESC
  ),
  -- PROMEDIO: costo que el kardex le pone a la última SALIDA (venta o traspaso), por día y unidad.
  salida_dia AS (
    SELECT j.sucursal, btrim(j.c3) AS sku, j.c10::date AS fecha, ${U('j.c12')} AS unidad,
           (array_agg(j.c4 || '-' || j.c5 || '-' || btrim(j.c6::text) ORDER BY j.c11 DESC))[1] AS doc,
           SUM(j.c13::numeric) / NULLIF(SUM(j.c11::numeric), 0) AS costo_u,
           SUM(j.c11::numeric) AS q
      FROM kepler_ods.kdij j
     WHERE j.c30 = 'S' AND btrim(j.c1) = j.sucursal AND j.c2 = 1 AND j.c11 > 0 AND j.c13 > 0
       AND j.c10 >= CURRENT_DATE - ${diasKardex}
     GROUP BY 1, 2, 3, 4
  ),
  salida AS (
    SELECT DISTINCT ON (sucursal, sku) * FROM salida_dia ORDER BY sucursal, sku, fecha DESC, q DESC
  ),
  -- ÚLTIMA ENTRADA (cualquier tipo): de dónde salió kdik.c16.
  entrada_dia AS (
    SELECT j.sucursal, btrim(j.c3) AS sku, j.c10::date AS fecha, ${U('j.c12')} AS unidad,
           (array_agg(j.c4 || '-' || j.c5 || '-' || btrim(j.c6::text) ORDER BY j.c11 DESC))[1] AS doc,
           SUM(j.c11::numeric) AS q
      FROM kepler_ods.kdij j
     WHERE j.c30 = 'E' AND btrim(j.c1) = j.sucursal AND j.c2 = 1 AND j.c11 > 0 AND j.c13 > 0
       AND j.c10 >= CURRENT_DATE - ${diasKardex}
     GROUP BY 1, 2, 3, 4
  ),
  entrada AS (
    SELECT DISTINCT ON (sucursal, sku) * FROM entrada_dia ORDER BY sucursal, sku, fecha DESC, q DESC
  ),
  c16 AS (
    SELECT btrim(sucursal) AS sucursal, btrim(c2) AS sku, max(c16)::numeric AS c16
      FROM kepler_ods.kdik
     WHERE btrim(c1) = btrim(sucursal) AND c16 > 0 AND c16 < 'Infinity'::float8
     GROUP BY 1, 2
  ),
  base AS (
    SELECT f.*,
           COALESCE(cp.sucursal, cr.sucursal)               AS compra_sucursal,
           (cp.sku IS NOT NULL)                             AS compra_propia,
           COALESCE(cp.fecha, cr.fecha)                     AS compra_fecha,
           COALESCE(cp.folio, cr.folio)                     AS compra_folio,
           COALESCE(cp.proveedor, cr.proveedor)             AS compra_proveedor,
           COALESCE(cp.unidad, cr.unidad)                   AS compra_unidad,
           COALESCE(cp.costo_u, cr.costo_u)                 AS compra_costo_u,
           ${factor('f', 'COALESCE(cp.unidad, cr.unidad)')} AS compra_factor,
           s.fecha AS salida_fecha, s.doc AS salida_doc, s.unidad AS salida_unidad, s.costo_u AS salida_costo_u,
           ${factor('f', 's.unidad')}                       AS salida_factor,
           e.fecha AS entrada_fecha, e.doc AS entrada_doc, e.unidad AS entrada_unidad,
           ${factor('f', 'e.unidad')}                       AS entrada_factor,
           k.c16
      FROM ficha f
      LEFT JOIN compra cp     ON cp.sucursal = f.sucursal AND cp.sku = f.sku
      LEFT JOIN compra_red cr ON cr.sku = f.sku AND cp.sku IS NULL
      LEFT JOIN salida s      ON s.sucursal = f.sucursal AND s.sku = f.sku
      LEFT JOIN entrada e     ON e.sucursal = f.sucursal AND e.sku = f.sku
      LEFT JOIN c16 k         ON k.sucursal = f.sucursal AND k.sku = f.sku
  ),
  calc AS (
    SELECT b.*,
           CASE WHEN b.e1 > 0 THEN b.e1 END                 AS estandar,
           b.compra_costo_u / NULLIF(b.compra_factor, 0)    AS ultimo_crudo,
           b.salida_costo_u / NULLIF(b.salida_factor, 0)    AS promedio_crudo,
           b.c16 / NULLIF(b.entrada_factor, 0)              AS entrada_crudo
      FROM base b
  )
  SELECT '${TENANT}'::uuid                                   AS tenant_id,
         c.sucursal,
         COALESCE(m.warehouse_code, c.sucursal)              AS warehouse_code,
         c.sku,
         c.u1 AS unidad_base,
         c.u2 AS unidad_dos, c.f2 AS factor_dos, c.u3 AS unidad_tres, c.f3 AS factor_tres,
         -- ESTÁNDAR
         round(c.estandar, 6)                                AS costo_estandar,
         CASE WHEN c.estandar IS NULL THEN 'sin_estandar' END AS estandar_motivo,
         -- ÚLTIMO (XA2001)
         round(CASE WHEN c.ultimo_crudo > 0
                     AND (c.estandar IS NULL OR c.ultimo_crudo / c.estandar BETWEEN 0.2 AND 5)
                    THEN c.ultimo_crudo END, 6)              AS costo_ultimo,
         CASE WHEN c.compra_costo_u IS NULL THEN 'sin_compra'
              WHEN c.compra_factor IS NULL THEN 'unidad_no_resuelta'
              WHEN c.estandar IS NOT NULL AND NOT (c.ultimo_crudo / c.estandar BETWEEN 0.2 AND 5) THEN 'inverosimil'
         END                                                 AS ultimo_motivo,
         c.compra_fecha                                      AS ultimo_fecha,
         c.compra_folio                                      AS ultimo_folio,
         c.compra_proveedor                                  AS ultimo_proveedor,
         c.compra_sucursal                                   AS ultimo_sucursal,
         CASE WHEN c.compra_costo_u IS NULL THEN NULL
              WHEN c.compra_propia THEN 'propia' ELSE 'red' END AS ultimo_origen,
         c.compra_unidad                                     AS ultimo_unidad,
         -- PROMEDIO (kardex, última salida)
         round(CASE WHEN c.promedio_crudo > 0
                     AND (c.estandar IS NULL OR c.promedio_crudo / c.estandar BETWEEN 0.2 AND 5)
                    THEN c.promedio_crudo END, 6)            AS costo_promedio,
         CASE WHEN c.salida_costo_u IS NULL THEN 'sin_salida'
              WHEN c.salida_factor IS NULL THEN 'unidad_no_resuelta'
              WHEN c.estandar IS NOT NULL AND NOT (c.promedio_crudo / c.estandar BETWEEN 0.2 AND 5) THEN 'inverosimil'
         END                                                 AS promedio_motivo,
         c.salida_fecha                                      AS promedio_fecha,
         c.salida_doc                                        AS promedio_doc,
         c.salida_unidad                                     AS promedio_unidad,
         -- ÚLTIMA ENTRADA (kdik.c16): referencia, NO es ninguno de los tres
         round(c.c16, 6)                                     AS costo_ultima_entrada_kepler,
         round(CASE WHEN c.entrada_crudo > 0
                     AND (c.estandar IS NULL OR c.entrada_crudo / c.estandar BETWEEN 0.2 AND 5)
                    THEN c.entrada_crudo END, 6)             AS costo_ultima_entrada,
         c.entrada_fecha                                     AS ultima_entrada_fecha,
         c.entrada_doc                                       AS ultima_entrada_doc,
         c.entrada_unidad                                    AS ultima_entrada_unidad
    FROM calc c
    LEFT JOIN analytics.erp_warehouse_map m
           ON m.tenant_id = '${TENANT}'::uuid AND m.sucursal = c.sucursal AND m.almacen_erp = c.sucursal`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. Compuertas sobre el cuerpo EN VIVO (la matview nace vacía) ────────────────────────
  const { rows: g } = await knex.raw(`
    WITH x AS (${cuerpo()})
    SELECT COUNT(*)::int                                                            AS fichas,
           COUNT(*) FILTER (WHERE costo_estandar IS NOT NULL)::int                  AS con_estandar,
           COUNT(*) FILTER (WHERE costo_ultimo IS NOT NULL)::int                    AS con_ultimo,
           COUNT(*) FILTER (WHERE costo_promedio IS NOT NULL)::int                  AS con_promedio,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_ultimo / costo_estandar)
             FILTER (WHERE costo_ultimo > 0 AND costo_estandar > 0)                 AS med_ultimo,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_promedio / costo_estandar)
             FILTER (WHERE costo_promedio > 0 AND costo_estandar > 0)               AS med_promedio
      FROM x`);
  const s = g[0];
  console.log(
    `  · [CAT-COSTO.6] ${s.fichas} fichas · estándar ${s.con_estandar} · último ${s.con_ultimo} · ` +
      `promedio ${s.con_promedio} · mediana último/estándar ${Number(s.med_ultimo).toFixed(4)} · ` +
      `promedio/estándar ${Number(s.med_promedio).toFixed(4)}`,
  );
  if (!(s.fichas > 0)) {
    // Una base de desarrollo sin el ODS: NO MEDIDO, ni rojo ni verde.
    console.log('  ! [CAT-COSTO.6] NO MEDIDO: sin fichas de Kepler en esta base; compuertas omitidas.');
  } else {
    // (a) Si el estándar casi no se lee, el decode de kdii se rompió. Medido: 99.5 %.
    if (!(s.con_estandar / s.fichas > 0.9)) {
      throw new Error(`[CAT-COSTO.6] sólo ${s.con_estandar}/${s.fichas} fichas con estándar (medido 99.5 %): revisar kdii.c77.`);
    }
    // (b) Unidad: los tres costos están en la base de la ficha, así que su mediana contra el
    //     estándar tiene que pegarse a 1. Si se pegara a un factor de caja, la conversión se rompió.
    //     Medido: ~1.00 para los dos.
    for (const [k, v] of [['último', s.med_ultimo], ['promedio', s.med_promedio]]) {
      if (v !== null && !(Number(v) > 0.8 && Number(v) < 1.3)) {
        throw new Error(`[CAT-COSTO.6] mediana ${k}/estándar = ${v} fuera de [0.8, 1.3]: error de unidad.`);
      }
    }
  }

  // ── 2. La matview ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS ${cuerpo()} WITH NO DATA`);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_kepler_costos ON ${MV} (tenant_id, sucursal, sku)`);
  await knex.raw(`CREATE INDEX ix_mv_kepler_costos_sku ON ${MV} (sku)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    $$[CAT-COSTO.6] Los tres costos de Kepler por sucursal x producto, en la unidad BASE de la ficha.
    ESTANDAR = kdii.c77 (catalogo, lleva el margen). ULTIMO = renglon de la ultima XA2001 Aplica Orden
    Entrada (solo compras; c13/c9; c68; sin canceladas; si la sucursal no compro, la red y se declara).
    PROMEDIO = costo del kardex en la ultima salida (contra el que Kepler mide la utilidad).
    costo_ultima_entrada* = kdik.c16 = costo de la ULTIMA ENTRADA (compra, traspaso o ajuste): NO es
    promedio (medido 99.19 %, refuta VERDAD_ABSOLUTA 3.4). Lo que falta se declara en *_motivo, nunca 0.$$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};

exports._cuerpo = cuerpo;
