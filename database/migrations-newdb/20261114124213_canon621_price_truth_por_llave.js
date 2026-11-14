'use strict';
/**
 * `[CANON.6.21]` Oleada 8b, paso 2 (precio): el precio de venta por (almacén, producto) se podrá mantener POR LLAVE, sin
 * el `REFRESH` de `analytics.mv_price_truth` que corre cada 5 minutos en `existencia-aux`.
 *
 * Crea, sin tocar nada de lo que hay:
 *   · `analytics.price_truth_de(skus)` — la regla de `mv_price_truth` en una función. Con `skus = NULL` es la consulta
 *     de la matview tal cual (la forma del recálculo completo); con una lista, la MISMA regla acotada a esos SKUs.
 *     Las dos formas salen de UNA plantilla (`reglaPrecio`, abajo): la regla se escribe una vez.
 *   · `analytics.price_truth` — la tabla que guardará el resultado, con la llave de la matview
 *     (tenant, almacén, producto) y sus mismas columnas. Nace VACÍA y nadie la lee: la llena el primer recálculo
 *     completo del que drena (paso 4) y los lectores pasan a ella en el paso 5, cuando el árbitro la dé por igual.
 *   · `analytics.recalcular_existencia(skus)` (`SECURITY DEFINER`) — recalcula esos SKUs (o todo, con `NULL`) y escribe
 *     SÓLO lo que cambió: borra lo que ya no sale, inserta lo nuevo y actualiza lo distinto. Devuelve cuántas filas
 *     insertó, actualizó y borró (con `NULL`, eso es el árbitro: lo que difería de lo guardado). Va serializada con un
 *     candado consultivo. Los otros tres materializados de `existencia-aux` se suman aquí en los pasos siguientes.
 *
 * ── Lo medido antes (prod, sólo lectura, `system_identifier` 7688376744939610156, misma foto REPEATABLE READ) ──────
 *  · `mv_price_truth`: 7–10.5 s por refresco, 38 % del costo de `existencia-aux` (~5,400 s de CPU al día).
 *  · La forma por llave da IDÉNTICO a la original filtrada en lotes de 1, 10, 50, 200 y 1,000 SKUs y en el catálogo
 *    entero (78,885 filas), y cuesta ~5 ms por SKU (10 SKUs 58–158 ms · 200 ~0.8–1.1 s). Lo que la abarata: primero las
 *    líneas de venta de esos SKUs (`kdm2` por `ix_kdm2_sku_venta`, que es parcial en `c2='U' AND c3='D'`), materializadas,
 *    y su documento en `kdm1` por la PK con las MISMAS condiciones; sin eso el planeador entra por la fecha de `kdm1`
 *    (~30 mil documentos) y tarda 2–3 s aunque sean 10 SKUs.
 *  · `kdpv_prod_util`: 0 de 361,886 renglones con espacios en `c1`, por eso la forma por llave lo filtra crudo (usa el
 *    índice: 1 SKU 16 ms, contra 124 ms con `btrim`); si algún día llegara uno con espacios, el recálculo completo
 *    diario lo corrige y lo cuenta.
 *  · Re-medido con ESTE SQL (el que genera `reglaPrecio`) contra la definición viva, misma foto: completa idéntica
 *    (78,867 filas, 7.7 s); por llave idéntica en 1/10/50/200/1,000 SKUs. ⛔ Con `jit` prendido (el default de prod) la
 *    forma por llave tarda 5–14 veces más (200 SKUs: 10.3 s contra 0.74 s): por eso las dos funciones llevan
 *    `jit = off`.
 *  · El costo por llave es proporcional a la HISTORIA de ventas del SKU (`kdm2` no tiene fecha: la ventana de 90 días
 *    vive en `kdm1`): ~4 ms por SKU al azar, ~9 ms por SKU de los que se venden hoy (2,349 SKUs en 20.8 s). Arriba de
 *    ~800 SKUs por llave cuesta más que todo junto (7.7 s): `recalcular_existencia` pasa sola a la forma completa.
 *    Techo del día: ayer hubo 34,104 líneas de venta; aun recalculando una vez por línea serían ~5 min de CPU contra los
 *    ~37 min que cuesta hoy el `REFRESH` cada 5 minutos (7.7 s × 288).
 *
 * ⛔ No toca `mv_price_truth`, ni el carril, ni ningún lector: sólo crea objetos nuevos (sin candados sobre tablas de
 *    la ingesta: el cuerpo de una función plpgsql no se resuelve al crearla).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'analytics.price_truth';
const LISTA_RED = '00000000-0000-0000-0000-0000c0ffee02';
const MAX_POR_LLAVE = 800;
const COLS = ['tenant_id', 'warehouse_id', 'sucursal', 'product_id', 'sku', 'precio', 'fuente', 'lineas_pos',
  'precio_config', 'rechazo', 'precio_lista', 'veredicto'];

/** Las condiciones del documento de venta (tipo, 90 días, no cancelado): una vez, para las dos formas. */
const DOC_VENTA = (a) => `${a}.c2 = 'U'::text AND ${a}.c3 = 'D'::text`
  + ` AND (${a}.c4 = ANY (ARRAY[3::numeric, 5::numeric, 6::numeric, 7::numeric, 8::numeric, 9::numeric, 10::numeric, 12::numeric, 13::numeric, 45::numeric]))`
  + ` AND ${a}.c9::date >= (CURRENT_DATE - 90) AND btrim(COALESCE(${a}.c43, 'N'::text)) = 'N'::text`;

/**
 * La regla de `analytics.mv_price_truth` (definición viva en prod el 2026-11-14), con una sola diferencia posible:
 * `llave` = `null` → la consulta de la matview tal cual; `llave` = una expresión de `text[]` → acotada a esos SKUs.
 * Lo exporta el módulo para la prueba y para medir contra prod: el SQL no se retipea en ningún otro lado.
 * @param {string|null} llave
 */
function reglaPrecio(llave) {
  const y = (expr) => (llave ? ` AND ${expr} = ANY (${llave})` : '');
  const ventas = llave
    ? `lin AS MATERIALIZED (
         SELECT m2.sucursal, m2.c1, m2.c2, m2.c3, m2.c4, m2.c5, m2.c6, m2.c8, m2.c9, m2.c11, m2.c12
           FROM kepler_ods.kdm2 m2
          WHERE m2.c2 = 'U'::text AND m2.c3 = 'D'::text AND btrim(m2.c8) = ANY (${llave})
        )`
    : `docs AS MATERIALIZED (
         SELECT m1.sucursal, m1.c1, m1.c2, m1.c3, m1.c4, m1.c5, m1.c6
           FROM kepler_ods.kdm1 m1
          WHERE ${DOC_VENTA('m1')}
        )`;
  const lineas = llave
    ? `lin m2
             JOIN kepler_ods.kdm1 d ON d.sucursal = m2.sucursal AND d.c1 = m2.c1 AND d.c2 = m2.c2 AND d.c3 = m2.c3 AND d.c4 = m2.c4 AND d.c5 = m2.c5 AND d.c6 = m2.c6 AND ${DOC_VENTA('d')}`
    : `kepler_ods.kdm2 m2
             JOIN docs d ON d.sucursal = m2.sucursal AND d.c1 = m2.c1 AND d.c2 = m2.c2 AND d.c3 = m2.c3 AND d.c4 = m2.c4 AND d.c5 = m2.c5 AND d.c6 = m2.c6`;
  return `WITH base_unit AS (
         SELECT btrim(kdii.sucursal) AS suc,
            btrim(kdii.c1) AS sku,
            btrim(kdii.c11) AS unidad,
            round(kdii.c90, 2) AS pv
           FROM kepler_ods.kdii
          WHERE btrim(COALESCE(kdii.c1, ''::text)) <> ''::text AND btrim(COALESCE(kdii.c11, ''::text)) <> ''::text${y('btrim(kdii.c1)')}
        ), ${ventas}, pos AS (
         SELECT btrim(m2.sucursal) AS suc,
            btrim(m2.c8) AS sku,
            mode() WITHIN GROUP (ORDER BY (round(m2.c12, 2)) DESC) AS precio,
            count(*)::integer AS lineas
           FROM ${lineas}
          WHERE m2.c9::numeric < 3::numeric AND (EXISTS ( SELECT 1
                   FROM base_unit bu_1
                  WHERE bu_1.suc = btrim(m2.sucursal) AND bu_1.sku = btrim(m2.c8) AND bu_1.unidad = btrim(m2.c11)))
          GROUP BY (btrim(m2.sucursal)), (btrim(m2.c8))
         HAVING count(*) >= 5
        ), tier AS (
         SELECT btrim(kdpv_prod_util.sucursal) AS suc,
            btrim(kdpv_prod_util.c1) AS sku,
            btrim(kdpv_prod_util.c2) AS present,
            max(kdpv_prod_util.c7) AS tope
           FROM kepler_ods.kdpv_prod_util
          WHERE kdpv_prod_util.c7 > 0.05${y('kdpv_prod_util.c1')}
          GROUP BY (btrim(kdpv_prod_util.sucursal)), (btrim(kdpv_prod_util.c1)), (btrim(kdpv_prod_util.c2))
        )
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS sucursal,
    pr.id AS product_id,
    btrim(pr.sku::text) AS sku,
        CASE
            WHEN pos.precio IS NOT NULL THEN pos.precio
            WHEN rech.motivo IS NULL THEN bu.pv
            ELSE NULL::numeric
        END AS precio,
        CASE
            WHEN pos.precio IS NOT NULL THEN 'pos'::text
            WHEN rech.motivo IS NULL THEN 'config'::text
            ELSE 'rechazado'::text
        END AS fuente,
    pos.lineas AS lineas_pos,
    bu.pv AS precio_config,
    rech.motivo AS rechazo,
    pp.price AS precio_lista,
        CASE
            WHEN pp.price IS NULL THEN 'sin_precio_lista'::text
            WHEN pos.precio IS NULL AND rech.motivo IS NOT NULL THEN 'sin_precio_medible'::text
            WHEN abs(pp.price - COALESCE(pos.precio, bu.pv)) < 0.005 THEN 'cuadra'::text
            ELSE 'difiere'::text
        END AS veredicto
   FROM catalog.products pr
     JOIN commercial.warehouses w ON w.tenant_id = pr.tenant_id AND w.deleted_at IS NULL
     JOIN base_unit bu ON bu.suc = w.code::text AND bu.sku = btrim(pr.sku::text)
     LEFT JOIN pos ON pos.suc = w.code::text AND pos.sku = btrim(pr.sku::text)
     LEFT JOIN tier t ON t.suc = w.code::text AND t.sku = btrim(pr.sku::text) AND t.present = bu.unidad
     LEFT JOIN commercial.product_prices pp ON pp.tenant_id = pr.tenant_id AND pp.product_id = pr.id AND pp.price_list_id = '${LISTA_RED}'::uuid AND pp.deleted_at IS NULL
     LEFT JOIN LATERAL ( SELECT
                CASE
                    WHEN pos.precio IS NOT NULL THEN NULL::text
                    WHEN bu.pv IS NULL OR bu.pv <= 0.05 THEN 'sin_precio'::text
                    WHEN pr.cost_base > 0::numeric AND bu.pv > (pr.cost_base * 3::numeric) THEN 'sobre_costo'::text
                    WHEN t.tope IS NOT NULL AND bu.pv >= (t.tope * 0.9) THEN NULL::text
                    WHEN t.tope IS NOT NULL THEN 'bajo_su_escalon'::text
                    WHEN pr.cost_base > 0::numeric AND bu.pv < pr.cost_base THEN 'bajo_costo'::text
                    ELSE NULL::text
                END AS motivo) rech ON true
  WHERE pr.deleted_at IS NULL AND NOT COALESCE(pr.is_promo, false)${y('btrim(pr.sku::text)')}`;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${T} (
      tenant_id      uuid NOT NULL,
      warehouse_id   uuid NOT NULL,
      sucursal       varchar(50),
      product_id     uuid NOT NULL,
      sku            text,
      precio         numeric,
      fuente         text,
      lineas_pos     integer,
      precio_config  numeric,
      rechazo        text,
      precio_lista   numeric(14,4),
      veredicto      text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, warehouse_id, product_id)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_price_truth_sku ON ${T} (sku)`);
  await knex.raw(`COMMENT ON TABLE ${T} IS
    '[CANON.6.21] El precio de venta por (almacén, producto): la regla de mv_price_truth guardada POR LLAVE. La escribe '
    'SÓLO analytics.recalcular_existencia (por SKU al llegar el cambio, o completa con NULL). updated_at = cuándo cambió '
    'la fila de verdad (sin cambio no se reescribe). Nace vacía y sin lectores hasta el paso 5 de la oleada 8b.'`);

  // La regla, en sus dos formas. `#variable_conflict use_column`: los nombres de salida (sku, precio…) son también
  // columnas de la consulta; gana la columna. `force_custom_plan`: el plan se arma con la lista real de SKUs (un plan
  // genérico no sabe si son 1 o 9,000).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.price_truth_de(p_skus text[])
    RETURNS TABLE (tenant_id uuid, warehouse_id uuid, sucursal varchar, product_id uuid, sku text, precio numeric,
                   fuente text, lineas_pos integer, precio_config numeric, rechazo text, precio_lista numeric,
                   veredicto text)
    LANGUAGE plpgsql STABLE
    SET search_path = pg_catalog, pg_temp
    SET plan_cache_mode = force_custom_plan
    SET jit = off
    AS $fn$
    #variable_conflict use_column
    BEGIN
      IF p_skus IS NULL THEN
        RETURN QUERY ${reglaPrecio(null)};
      ELSE
        RETURN QUERY ${reglaPrecio('p_skus')};
      END IF;
    END
    $fn$`);
  await knex.raw(`REVOKE ALL ON FUNCTION analytics.price_truth_de(text[]) FROM PUBLIC`);
  await knex.raw(`COMMENT ON FUNCTION analytics.price_truth_de(text[]) IS
    '[CANON.6.21] La regla de mv_price_truth. NULL = la consulta de la matview tal cual; una lista = la misma regla '
    'acotada a esos SKUs (btrim). Las dos formas salen de una plantilla en la migración 20261114124213.'`);

  const lista = COLS.join(', ');
  const cambio = COLS.filter((c) => !['tenant_id', 'warehouse_id', 'product_id'].includes(c));
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.recalcular_existencia(p_skus text[] DEFAULT NULL)
    RETURNS TABLE (objeto text, insertadas integer, actualizadas integer, borradas integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET jit = off
    AS $fn$
    #variable_conflict use_column
    DECLARE v_ins integer := 0; v_upd integer := 0; v_del integer := 0;
    BEGIN
      IF p_skus IS NOT NULL THEN
        p_skus := ARRAY(SELECT DISTINCT btrim(s) FROM unnest(p_skus) s WHERE btrim(COALESCE(s, '')) <> '');
        -- Arriba de ~800 SKUs, por llave cuesta más que todo junto (medido: ~9 ms por SKU vendido; completo 7.7 s).
        -- Recalcular todo es correcto siempre: contiene a cualquier lista.
        IF cardinality(p_skus) > ${MAX_POR_LLAVE} THEN p_skus := NULL; END IF;
      END IF;
      IF p_skus IS NULL OR cardinality(p_skus) > 0 THEN
        -- Uno a la vez: el recálculo completo y el que drena no se cruzan.
        PERFORM pg_advisory_xact_lock(hashtext('analytics.recalcular_existencia'));
        WITH nuevo AS MATERIALIZED (SELECT * FROM analytics.price_truth_de(p_skus)),
        quitadas AS (
          DELETE FROM ${T} t
           WHERE (p_skus IS NULL OR t.sku = ANY (p_skus))
             AND NOT EXISTS (SELECT 1 FROM nuevo n
                              WHERE n.tenant_id = t.tenant_id AND n.warehouse_id = t.warehouse_id
                                AND n.product_id = t.product_id)
          RETURNING 1),
        escritas AS (
          INSERT INTO ${T} AS t (${lista})
          SELECT ${lista} FROM nuevo
          ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
             SET ${cambio.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()
           WHERE (${cambio.map((c) => `t.${c}`).join(', ')}) IS DISTINCT FROM (${cambio.map((c) => `EXCLUDED.${c}`).join(', ')})
          RETURNING (t.xmax = 0) AS nueva)
        SELECT count(*) FILTER (WHERE e.nueva)::integer, count(*) FILTER (WHERE NOT e.nueva)::integer,
               (SELECT count(*) FROM quitadas)::integer
          INTO v_ins, v_upd, v_del
          FROM escritas e;
      END IF;
      objeto := 'price_truth'; insertadas := v_ins; actualizadas := v_upd; borradas := v_del;
      RETURN NEXT;
    END
    $fn$`);
  await knex.raw(`REVOKE ALL ON FUNCTION analytics.recalcular_existencia(text[]) FROM PUBLIC`);
  await knex.raw(`COMMENT ON FUNCTION analytics.recalcular_existencia(text[]) IS
    '[CANON.6.21] Recalcula por SKU (o todo, con NULL) las tablas de existencia-aux y escribe sólo lo que cambió. '
    'Hoy: price_truth. Devuelve por objeto cuántas filas insertó, actualizó y borró.'`);

  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT ON ${T} TO app_runtime;
        GRANT EXECUTE ON FUNCTION analytics.recalcular_existencia(text[]) TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON ${T} TO dev_ro;
      END IF;
    END $$`);

  // ── Verificación dentro de la migración: los permisos quedaron como se dice arriba ─────────────────────────────
  const { rows: [g] } = await knex.raw(`
    SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS sin_rol,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
             has_table_privilege('app_runtime', '${T}', 'SELECT')
             AND NOT has_table_privilege('app_runtime', '${T}', 'INSERT')
             AND has_function_privilege('app_runtime', 'analytics.recalcular_existencia(text[])', 'EXECUTE')
             AND NOT has_function_privilege('app_runtime', 'analytics.price_truth_de(text[])', 'EXECUTE')
           END AS ok`);
  if (!g.sin_rol && !g.ok) throw new Error('[CANON.6.21] los permisos de app_runtime no quedaron como se declara');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.recalcular_existencia(text[])`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.price_truth_de(text[])`);
  await knex.raw(`DROP TABLE IF EXISTS ${T}`);
};

exports.reglaPrecio = reglaPrecio;
exports.MAX_POR_LLAVE = MAX_POR_LLAVE;
