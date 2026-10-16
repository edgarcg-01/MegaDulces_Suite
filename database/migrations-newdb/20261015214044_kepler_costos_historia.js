'use strict';
/**
 * `[CAT-COSTO.9]` — **La historia por día de los tres costos de Kepler.**
 *
 * Pedido de Compras (2026-10-15): ver, día por día, con qué costo cerró cada almacén — una matriz por
 * tipo de costo (estándar · promedio · último) con un selector ‹ día ›, y reconstruir hacia atrás lo
 * que se pueda. Tres piezas:
 *
 *  1. `analytics.kepler_costo_estandar_foto` — **foto nocturna de la ficha** (`kdii.c77`). Es la única
 *     historia que Kepler NO guarda: la ficha sólo tiene el valor de hoy. Se guarda UN renglón cuando
 *     el estándar cambia, no los 87 mil cada noche. Es un snapshot, no un importer: lo que copia no
 *     existe en ningún otro lado.
 *  2. `analytics.fn_kepler_estandar_foto()` — la captura. La llama el refresco nocturno ANTES de
 *     refrescar la matview (paso previo, misma transacción) y esta migración una vez, para sembrar hoy.
 *  3. `analytics.mv_kepler_costos_cambios` — **los puntos de cambio** de los tres costos, con su
 *     vigencia (`desde` inclusivo, `hasta` exclusivo; NULL = sigue vigente). «El costo al día D» es la
 *     fila con `desde <= D < hasta`.
 *       · `ultimo`   — cada XA2001 Aplica Orden Entrada (la última del día). Historia COMPLETA: cada
 *                      documento tiene su fecha. Mismas reglas que `mv_kepler_costos`.
 *       · `promedio` — el costo del kardex en las salidas, UN renglón por cada día con salida (sin
 *                      comprimir: ver la nota en el cuerpo). Historia desde que el almacén tiene
 *                      kardex (su paso a Kepler).
 *       · `estandar` — `fuente = 'ficha'` desde la primera foto; ANTES, deducido de la venta
 *                      (`c62 / c58`: el estándar que congeló cada renglón, `fuente = 'venta'`). Los días
 *                      sin venta de ese producto no tienen dato: el último valor visto sigue vigente y
 *                      la fuente se declara.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-15) ────────────────────────────────────────
 *  · Puntos de cambio: último 85,723 (21,879 pares) · estándar por venta 55,196 (26,743) · promedio
 *    ~824 mil días con salida (30,156 pares). El cuerpo completo: ~35–45 s → se materializa de noche.
 *  · SEGUNDA IMPLEMENTACIÓN: el costo «al día de hoy» que sale de esta historia contra
 *    `mv_kepler_costos` (que lo calcula por otro camino): último **21,601 / 21,601** iguales; promedio
 *    **29,899 / 29,901** (dentro del redondeo a 4 decimales). Comprimir el promedio «cuando cambia»
 *    no sirve: ver la nota del CTE `promedio`.
 *  · `kdii` no trae repetidos por sucursal × producto (87,070 = 87,070).
 *
 * ⚠️ La foto lleva RLS SIN `FORCE`, a propósito: el refresco corre como el dueño, y con `FORCE` la
 *    matview que la lee se poblaría vacía si faltara `app.tenant_id` (la lección de `[MR.8.2]`).
 *    `app_runtime` sí queda sujeto a la política.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const FOTO = 'analytics.kepler_costo_estandar_foto';
const MV = 'analytics.mv_kepler_costos_cambios';
const FN = 'analytics.fn_kepler_estandar_foto';

const N = (x) => `NULLIF(regexp_replace(${x}::text, '[^0-9.-]', '', 'g'), '')::numeric`;
const U = (x) => `NULLIF(upper(btrim(${x}::text)), '')`;
const factor = (f, u) => `CASE WHEN ${u} IS NULL THEN NULL
                               WHEN ${u} = ${f}.u1 THEN 1::numeric
                               WHEN ${u} = ${f}.u2 AND ${f}.f2 > 0 THEN ${f}.f2
                               WHEN ${u} = ${f}.u3 AND ${f}.f3 > 0 THEN ${f}.f3 END`;

/** El SELECT de la matview. `conFoto = false` sólo para ensayar en una base sin la tabla. */
const cuerpo = (conFoto = true) => `
  WITH ficha AS (
    SELECT btrim(k.sucursal) AS sucursal, btrim(k.c1) AS sku,
           ${U('k.c11')} AS u1, ${U('k.c80')} AS u2, ${N('k.c81')} AS f2, ${U('k.c83')} AS u3, ${N('k.c84')} AS f3
      FROM kepler_ods.kdii k WHERE btrim(k.sucursal) BETWEEN '00' AND '08'
  ),
  -- ÚLTIMO: cada XA2001 (la última del día por folio) es un punto de cambio.
  compra_dia AS (
    SELECT DISTINCT ON (sucursal, sku, fecha) sucursal, sku, fecha, folio, unidad, costo_u
      FROM (
        SELECT btrim(l.sucursal) AS sucursal, btrim(l.c8) AS sku, ap.c68::date AS fecha, btrim(ap.c6::text) AS folio,
               ${U('l.c11')} AS unidad, SUM(${N('l.c13')}) / NULLIF(SUM(${N('l.c9')}), 0) AS costo_u
          FROM kepler_ods.kdm2 l
          JOIN kepler_ods.kdm1 ap
            ON ap.sucursal = l.sucursal AND ap.c1 = l.c1 AND ap.c2 = l.c2 AND ap.c3 = l.c3
           AND ap.c4 = l.c4 AND ap.c5 = l.c5 AND ap.c6 = l.c6
         WHERE l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20' AND btrim(l.c5::text) = '1'
           AND btrim(ap.c1::text) = btrim(ap.sucursal::text)
           AND btrim(coalesce(ap.c43::text, '')) <> 'C'
           AND ap.c68::date <= CURRENT_DATE
           AND ${N('l.c9')} > 0 AND ${N('l.c13')} > 0
         GROUP BY 1, 2, 3, 4, 5) d
     ORDER BY sucursal, sku, fecha, folio DESC
  ),
  ultimo AS (
    SELECT c.sucursal, c.sku, 'ultimo'::text AS tipo, c.fecha AS desde,
           c.costo_u / NULLIF(${factor('f', 'c.unidad')}, 0) AS costo,
           'xa2001'::text AS fuente, 'XA2001-' || c.folio AS referencia
      FROM compra_dia c JOIN ficha f ON f.sucursal = c.sucursal AND f.sku = c.sku
  ),
  -- PROMEDIO: el costo del kardex en las salidas, por día (unidad dominante del día).
  salida_dia AS (
    SELECT DISTINCT ON (sucursal, sku, fecha) sucursal, sku, fecha, unidad, costo_u
      FROM (
        SELECT j.sucursal, btrim(j.c3) AS sku, j.c10::date AS fecha, ${U('j.c12')} AS unidad,
               SUM(j.c13::numeric) / NULLIF(SUM(j.c11::numeric), 0) AS costo_u, SUM(j.c11::numeric) AS q
          FROM kepler_ods.kdij j
         WHERE j.c30 = 'S' AND btrim(j.c1) = j.sucursal AND j.c2 = 1 AND j.c11 > 0 AND j.c13 > 0
         GROUP BY 1, 2, 3, 4) d
     ORDER BY sucursal, sku, fecha, q DESC
  ),
  promedio_base AS (
    SELECT s.sucursal, s.sku, s.fecha, round(s.costo_u / NULLIF(${factor('f', 's.unidad')}, 0), 4) AS costo
      FROM salida_dia s JOIN ficha f ON f.sucursal = s.sucursal AND f.sku = s.sku
  ),
  -- ⛔ Un renglón por CADA día con salida, sin comprimir. Medido: comprimir «cuando cambia» no
  -- sirve con este dato — el kardex guarda el importe de cada salida a centavos, así que el costo
  -- por pieza baila según cuántas piezas lleva la salida (68.21 en 1 pza, 68.2135 en 20): a 4
  -- decimales eran 344,784 «cambios», a 2 decimales 166,426 (95,193 de un solo centavo), y un umbral
  -- relativo acumula deriva (99.4 % contra la foto de hoy). Sin comprimir son ~824 mil renglones y el
  -- costo de cualquier día es exactamente el que puso Kepler.
  promedio AS (
    SELECT sucursal, sku, 'promedio'::text AS tipo, fecha AS desde, costo, 'kardex'::text AS fuente, NULL::text AS referencia
      FROM promedio_base WHERE costo > 0
  ),
  -- ESTÁNDAR deducido de la venta (antes de la primera foto): lo que congeló cada renglón.
  estandar_venta_dia AS (
    SELECT btrim(l.sucursal) AS sucursal, btrim(l.c8) AS sku, l.c32::date AS fecha,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${N('l.c62')} / ${N('l.c58')}))::numeric AS costo
      FROM kepler_ods.kdm2 l
     WHERE l.c2 = 'U' AND l.c3 = 'D' AND l.c4 IN (6, 10)
       AND btrim(l.sucursal::text) BETWEEN '00' AND '08'
       AND split_part(btrim(l.c1::text), '-', 1) = btrim(l.sucursal::text)
       AND ${N('l.c62')} > 0 AND ${N('l.c58')} > 0
       -- 1800-01-01 es el centinela de Kepler para «sin fecha».
       AND l.c32::date BETWEEN DATE '2024-01-01' AND CURRENT_DATE
     GROUP BY 1, 2, 3
  ),
  ${conFoto
    ? `foto AS (SELECT sucursal, sku, fecha, costo FROM ${FOTO} WHERE tenant_id = '${TENANT}'::uuid),`
    : `foto AS (SELECT NULL::text AS sucursal, NULL::text AS sku, NULL::date AS fecha, NULL::numeric AS costo WHERE false),`}
  foto_inicio AS (SELECT sucursal, sku, min(fecha) AS desde FROM foto GROUP BY 1, 2),
  estandar_union AS (
    SELECT v.sucursal, v.sku, v.fecha, round(v.costo, 4) AS costo, 'venta'::text AS fuente
      FROM estandar_venta_dia v
      LEFT JOIN foto_inicio fi ON fi.sucursal = v.sucursal AND fi.sku = v.sku
     WHERE fi.desde IS NULL OR v.fecha < fi.desde
    UNION ALL
    SELECT sucursal, sku, fecha, round(costo, 4), 'ficha'::text FROM foto
  ),
  estandar AS (
    SELECT sucursal, sku, 'estandar'::text AS tipo, fecha AS desde, costo, fuente, NULL::text AS referencia
      FROM (SELECT e.*, lag(costo) OVER (PARTITION BY sucursal, sku ORDER BY fecha, fuente) AS antes
              FROM estandar_union e WHERE costo > 0) x
     WHERE antes IS NULL OR costo <> antes
  ),
  todo AS (
    SELECT * FROM ultimo WHERE costo > 0
    UNION ALL SELECT * FROM promedio
    UNION ALL SELECT * FROM estandar
  )
  SELECT '${TENANT}'::uuid AS tenant_id, sucursal, sku, tipo, desde,
         lead(desde) OVER (PARTITION BY tipo, sucursal, sku ORDER BY desde) AS hasta,
         round(costo, 6) AS costo, fuente, referencia
    FROM todo`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La foto de la ficha ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${FOTO} (
      tenant_id     uuid          NOT NULL,
      sucursal      text          NOT NULL,
      sku           text          NOT NULL,
      fecha         date          NOT NULL,
      costo         numeric(18,6) NOT NULL CHECK (costo > 0),
      unidad        text,
      capturado_por text          NOT NULL DEFAULT 'refresco_nocturno',
      created_at    timestamptz   NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, sku, fecha)
    )`);
  await knex.raw(`ALTER TABLE ${FOTO} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS kepler_costo_estandar_foto_tenant ON ${FOTO}`);
  await knex.raw(`CREATE POLICY kepler_costo_estandar_foto_tenant ON ${FOTO}
    USING (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT ON ${FOTO} TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE ${FOTO} IS
    $$[CAT-COSTO.9] Foto nocturna del costo estandar de la ficha de Kepler (kdii.c77, unidad base). Kepler NO
    guarda la historia de la ficha: un renglon por sucursal x producto CUANDO el estandar cambia. La escribe
    analytics.fn_kepler_estandar_foto() en el refresco nocturno. RLS sin FORCE a proposito (ver la migracion).$$`);

  // ── 2. La captura ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN}() RETURNS integer LANGUAGE plpgsql AS $fn$
    DECLARE
      n   integer;
      hoy date := (now() AT TIME ZONE 'America/Mexico_City')::date;
    BEGIN
      INSERT INTO ${FOTO} (tenant_id, sucursal, sku, fecha, costo, unidad)
      SELECT '${TENANT}'::uuid, f.sucursal, f.sku, hoy, f.costo, f.unidad
        FROM (SELECT btrim(k.sucursal) AS sucursal, btrim(k.c1) AS sku,
                     round(${N('k.c77')}, 6) AS costo, ${U('k.c11')} AS unidad
                FROM kepler_ods.kdii k
               WHERE btrim(k.sucursal) BETWEEN '00' AND '08') f
        LEFT JOIN LATERAL (
          SELECT p.costo FROM ${FOTO} p
           WHERE p.tenant_id = '${TENANT}'::uuid AND p.sucursal = f.sucursal AND p.sku = f.sku AND p.fecha <= hoy
           ORDER BY p.fecha DESC LIMIT 1) u ON true
       WHERE f.costo > 0 AND (u.costo IS NULL OR u.costo <> f.costo)
      ON CONFLICT (tenant_id, sucursal, sku, fecha) DO UPDATE SET costo = EXCLUDED.costo, unidad = EXCLUDED.unidad;
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN n;
    END
    $fn$`);
  await knex.raw(`COMMENT ON FUNCTION ${FN}() IS
    $$[CAT-COSTO.9] Captura el costo estandar de hoy de la ficha (kdii.c77) en ${FOTO}, sólo donde cambio
    contra la ultima foto. Devuelve cuantos renglones escribio. La llama el refresco nocturno antes de
    refrescar ${MV}.$$`);
  const { rows: [sembrado] } = await knex.raw(`SELECT ${FN}() AS n`);
  console.log(`  · [CAT-COSTO.9] foto inicial de la ficha: ${sembrado.n} renglones`);

  // ── 3. Los puntos de cambio ───────────────────────────────────────────────────────────────
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS ${cuerpo(true)} WITH NO DATA`);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_kepler_costos_cambios ON ${MV} (tenant_id, tipo, sucursal, sku, desde)`);
  await knex.raw(`CREATE INDEX ix_mv_kepler_costos_cambios_vigencia ON ${MV} (tipo, desde, hasta)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    $$[CAT-COSTO.9] Puntos de cambio de los tres costos de Kepler por sucursal x producto, en la unidad base de
    la ficha: ultimo (cada XA2001), promedio (kardex de salidas, cuando cambia a 4 decimales) y estandar (foto
    de la ficha; antes de la primera foto, deducido de la venta c62/c58). El costo al dia D = la fila con
    desde <= D < hasta (hasta NULL = vigente). La fuente se declara por fila.$$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN}()`);
  await knex.raw(`DROP TABLE IF EXISTS ${FOTO}`);
};

exports._cuerpo = cuerpo;
