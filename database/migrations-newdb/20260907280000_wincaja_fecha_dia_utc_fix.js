/**
 * RD.1 — La fecha de negocio de Wincaja estaba corrida UN DÍA hacia atrás.
 *
 * QUÉ PASABA
 * `wincaja.maestro_mov_almacen.fecha` es `timestamptz` y guarda la fecha *naive* del
 * `.mdb` (Access no almacena hora ahí: la hora vive aparte, en `m.hora`, como texto
 * serial '1899-12-30THH:MM:SS'). El importer la mapea como `'ts'` y, con el server en
 * UTC, queda fijada a **medianoche UTC**:  2026-01-02 → `2026-01-02 00:00:00+00`.
 *
 * RS.12b (20260805240000) introdujo `wincaja.fecha_mx_date(ts)` =
 * `(ts AT TIME ZONE 'America/Mexico_City')::date` para poder indexar por expresión.
 * Sobre una medianoche-UTC eso da las 18:00 del día ANTERIOR → `2026-01-01`.
 * El comentario de aquella migración lo declaró inocuo:
 *
 *     "El contenedor ya corre en TZ MX, así que `fecha::date` (sesión) ==
 *      fecha_mx_date(fecha) fila por fila ⇒ business_date NO cambia."
 *
 * La premisa es falsa: el `TimeZone` del Postgres de prod es `Etc/UTC`, y la vista se
 * evalúa en la DB, no en el contenedor de la app. Era una migración de *performance*
 * que movió un número de negocio sin medir el antes/después.
 *
 * MEDIDO (prod, 2026-09-07): 100% de las filas — 21 sucursales, 542,684 documentos de
 * 2026 — tienen `fecha` en medianoche UTC exacta, así que TODAS se corrían un día.
 *
 * TRES ÁRBITROS INDEPENDIENTES, los tres a favor de la fecha cruda:
 *   1. `INDICADORES RD 2026.xlsx` (tecleado a mano del reporte Wincaja): de 1,974
 *      celdas ruta×día comparables, el SUBTOTAL casa **98.0%** contra la fecha cruda
 *      y **0.0%** contra `fecha_mx_date`.
 *   2. Día de la semana (rutas, ene–jun 2026): con `fecha_mx_date` las rutas
 *      trabajaban DOMINGO (10,189 docs) y descansaban SÁBADO (15). Con la fecha
 *      cruda: Lun–Sáb operando y domingo 15 docs. Un reparto no descansa en sábado.
 *   3. La mecánica de Access descrita arriba.
 *
 * IMPACTO: en la frontera de mes, $793,080 de venta de ruta caían en el mes
 * equivocado (abr $201,525 · may $202,652 · jun $227,032 · jul $83,173 · ago $79,698),
 * y la atribución diaria estaba mal todos los días.
 *
 * EL ARREGLO
 * Función NUEVA `wincaja.fecha_dia(ts)` = `(ts AT TIME ZONE 'UTC')::date`, con nombre
 * honesto: es "el día que trae el campo del .mdb", sin interpretación de huso.
 *  - NO se reescribe `fecha_mx_date` en su lugar: `CREATE OR REPLACE` de una función
 *    usada en un índice por EXPRESIÓN deja el índice con entradas calculadas con la
 *    definición vieja — Postgres lo permite y el índice queda mintiendo en silencio.
 *  - NO se dropea `fecha_mx_date`: queda con un COMMENT que dice que corre el día.
 *    Borrar funciones en prod sin pedirlo no se hace acá.
 *  - Índices nuevos CONCURRENTLY ANTES de repuntar la vista, y recién después se
 *    dropean los viejos → nunca hay ventana sin índice (el Seq Scan de 1.44 M filas
 *    que RS.12b existía para matar).
 *  - La vista se repunta con CREATE OR REPLACE (nunca DROP: hay planes cacheados
 *    colgando de ella → 0A000; ver GOTCHAS).
 *
 * DESPUÉS DE APLICAR hay que refrescar lo que cuelga de `wincaja.v_sales_lines`:
 *   REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_wincaja_sales_daily;
 *   REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_sellout_monthly;
 *   node database/importers/wincaja/import-wincaja-routes-monthly.js --apply
 *   node database/importers/kepler/import-canindo-routes-monthly.js --apply
 * y re-correr `test-newdb-sellout-parity.js` (VP.1): comparaba las piernas Kepler y
 * Wincaja en los cutovers con un día de desfase artificial.
 *
 * El candado está en `database/tests/test-newdb-wincaja-business-date.js`.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false }; // CREATE/DROP INDEX CONCURRENTLY

const IDX_NEW = 'ix_wcj_maestro_fecha_dia';
const IDX_NEW_CONC = 'ix_wcj_maestro_concdates_dia';
const IDX_OLD = 'ix_wcj_maestro_fecha_date';
const IDX_OLD_CONC = 'ix_wcj_maestro_concdates';

/** Def. de `wincaja.v_sales_lines` idéntica a 20260831120000 (RR2.0) salvo la expresión de fecha. */
const viewSql = (fn) => `
  CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
  WITH conc_dates AS (
    SELECT DISTINCT tenant_id, source_branch, ${fn}(fecha) AS d
    FROM wincaja.maestro_mov_almacen
    WHERE source_dataset = 'concentrada'
  )
  SELECT
    m.tenant_id,
    m.source_branch,
    b.warehouse_code,
    (b.kepler_code IS NULL)          AS wincaja_only,
    m.source_dataset,
    ${fn}(m.fecha)                   AS business_date,
    d.articulo                       AS sku,
    (p.sku IS NOT NULL)              AS in_kepler_catalog,
    d.cantidad_regular               AS qty,
    d.valor_venta                    AS importe,
    d.valor_costo                    AS costo,
    m.consecutivo,
    d.documento                      AS doc_ref,
    m.vendedor,
    m.tercero                        AS cliente,
    m.caja,
    m.cajero,
    CASE WHEN b.is_route THEN 'ruta_venta'
         ELSE COALESCE(cc.channel, 'mostrador') END AS sale_channel,
    p.id                             AS product_id,
    d.iva                            AS iva,
    d.ieps                           AS ieps,
    d.descuento1                     AS descuento1,
    d.descuento2                     AS descuento2,
    m.hora                           AS hora_raw
  FROM wincaja.detalles_mov_almacen d
  JOIN wincaja.maestro_mov_almacen m
    ON  m.tenant_id     = d.tenant_id
    AND m.source_branch = d.source_branch
    AND m.source_dataset= d.source_dataset
    AND m.consecutivo   = d.consecutivo
  LEFT JOIN conc_dates cd
    ON cd.tenant_id = m.tenant_id AND cd.source_branch = m.source_branch AND cd.d = ${fn}(m.fecha)
  LEFT JOIN wincaja.branches b
    ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
  LEFT JOIN catalog.products p
    ON p.tenant_id = m.tenant_id AND p.sku = d.articulo AND p.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT k.channel, k.es_venta
    FROM wincaja.caja_channels k
    WHERE k.tenant_id = m.tenant_id AND k.caja = m.caja
      AND k.source_branch IN (m.source_branch, '*')
    ORDER BY (k.source_branch = m.source_branch) DESC
    LIMIT 1
  ) cc ON true
  WHERE d.tipo = 'V'
    AND d.valor_venta < 10000000
    AND d.valor_venta >= 0
    AND COALESCE(d.cantidad_regular, 0) < 10000000
    AND COALESCE(m.cancelado, false) = false
    AND COALESCE(cc.es_venta, true) = true
    AND NOT EXISTS (
      SELECT 1 FROM wincaja.clientes cli
      WHERE cli.tenant_id = m.tenant_id AND cli.source_branch = m.source_branch
        AND cli.source_dataset = m.source_dataset AND cli.cliente = m.tercero
        AND cli.nombre ILIKE 'ALMAC%'
    )
    AND (
      m.source_dataset = 'concentrada'
      OR cd.d IS NULL
    )
`;

exports.up = async function up(knex) {
  // 1) Función nueva, nombre honesto: el día tal como lo trae el campo del .mdb.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION wincaja.fecha_dia(ts timestamptz)
      RETURNS date LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT (ts AT TIME ZONE 'UTC')::date $$`);
  await knex.raw(`
    COMMENT ON FUNCTION wincaja.fecha_dia(timestamptz) IS
      'RD.1 — día de negocio de Wincaja. El .mdb guarda fecha SIN hora y el importer la fija a medianoche UTC; leerla en UTC devuelve el día real. NO aplicar AT TIME ZONE MX: corre el día hacia atrás.'`);

  // 2) Índices nuevos ANTES de repuntar la vista → nunca hay ventana sin índice.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX_NEW}
      ON wincaja.maestro_mov_almacen (tenant_id, source_branch, wincaja.fecha_dia(fecha))`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX_NEW_CONC}
      ON wincaja.maestro_mov_almacen (tenant_id, source_branch, wincaja.fecha_dia(fecha))
      WHERE source_dataset = 'concentrada'`);

  // 3) Repuntar la vista (CREATE OR REPLACE: mismas columnas, mismos tipos, mismo orden).
  await knex.raw(viewSql('wincaja.fecha_dia'));

  // 4) Recién ahora sobran los viejos.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.${IDX_OLD}`);
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.${IDX_OLD_CONC}`);

  // 5) La vieja queda, marcada. No se dropea: borrar en prod sin pedirlo no se hace acá.
  await knex.raw(`
    COMMENT ON FUNCTION wincaja.fecha_mx_date(timestamptz) IS
      'OBSOLETA (RD.1) — CORRE EL DÍA UN LUGAR HACIA ATRÁS. La fecha del .mdb ya viene a medianoche UTC; aplicarle AT TIME ZONE MX la manda al día anterior. Usar wincaja.fecha_dia(). Sin consumidores desde 20260907280000.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX_OLD}
      ON wincaja.maestro_mov_almacen (tenant_id, source_branch, wincaja.fecha_mx_date(fecha))`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX_OLD_CONC}
      ON wincaja.maestro_mov_almacen (tenant_id, source_branch, wincaja.fecha_mx_date(fecha))
      WHERE source_dataset = 'concentrada'`);
  await knex.raw(viewSql('wincaja.fecha_mx_date'));
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.${IDX_NEW}`);
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.${IDX_NEW_CONC}`);
  await knex.raw(`DROP FUNCTION IF EXISTS wincaja.fecha_dia(timestamptz)`);
  await knex.raw(`COMMENT ON FUNCTION wincaja.fecha_mx_date(timestamptz) IS NULL`);
};
