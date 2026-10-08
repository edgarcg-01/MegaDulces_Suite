'use strict';
/**
 * `[IC.16]` — EL RELOJ DE LA CADENCIA, POR RITMO Y CON ARRANQUE DECLARADO.
 *
 * ── El defecto, medido ──────────────────────────────────────────────────────────────────────
 *
 * `cycleDue()` calcula `last_counted_at` así:
 *
 * ```sql
 * SELECT MAX(c.reconciled_at) FROM commercial.inventory_counts c ... WHERE c.status = 'reconciled'
 * ```
 *
 * Y en prod hay **cero folios reconciliados** — los 6 que existen están `cancelled` desde junio.
 * O sea que `last_counted_at` es NULL para **todo el catálogo**, el `dueExpr`
 * (`last_counted_at IS NULL OR ...`) da verdadero siempre, y **el 100% del catálogo figura
 * vencido, para siempre**. Una pantalla que grita «39,480 pendientes» no prioriza nada: enseña a
 * ignorarla.
 *
 * ⛔ **Y el bug de fondo es que FUNDE DOS AUSENCIAS DISTINTAS.** «Nunca se contó» y «se contó y
 * se venció» se escriben igual (`NULL`) y se muestran igual («vencido»), cuando piden acciones
 * distintas: el primero es *arrancar*, el segundo es *volver*. Es exactamente lo que ADR-056
 * prohíbe.
 *
 * ── ⭐ Lo que destraba el reloj: el trimestral de Kepler SÍ tiene historia ───────────────────
 *
 * El reloj miraba sólo *nuestros* folios. Pero el físico de Kepler se cuenta de verdad y está
 * fresco — medido el 2026-10-07 contra `analytics.mv_erp_physical_count_variance`: los 8
 * almacenes contaron entre el **4 y el 23 de septiembre**, y eso cubre:
 *
 * ```text
 *   almacén   SKUs del ABC   con fecha real de Kepler
 *      01         4,510           2,278   (51%)
 *      02         4,343           3,202   (74%)
 *      03         4,657           2,407   (52%)
 *      04         2,925           1,407   (48%)
 *      05         3,271           1,632   (50%)
 *      06         3,630           3,013   (83%)
 *      07         3,003           2,538   (85%)
 *      08         3,354           2,905   (87%)
 *      00 CEDIS     366               0   ( 0%)  <- Kepler no lo cuenta: es Wincaja
 * ```
 *
 * O sea que el reloj pasa de **100% sin historia** a **48–87% con fecha real**, sin contar un
 * solo SKU más. *El dato ya estaba; el reloj no lo miraba.*
 *
 * ── La forma: una vista, no lógica repetida en cada consumidor ──────────────────────────────
 *
 * `analytics.v_count_clock`, grano **(almacén, producto, ritmo)**. Emite la **rejilla completa**
 * —cada SKU del ABC por cada ritmo— a propósito: si sólo emitiera las filas CON historia, un SKU
 * sin contar llegaría ausente a un `LEFT JOIN`, saldría NULL y **se leería como sano**. Ése es el
 * modo de falla que ADR-057 documenta y que esta vista existe para no repetir.
 *
 * `estado` tiene CUATRO valores, no dos:
 *  · `nunca_contado` — sin historia de ningún origen. **No es «vencido»**: es «arrancar»
 *  · `al_dia`        — hay fecha y la cadencia no venció
 *  · `vencido`       — hay fecha y la cadencia venció
 *  · `sin_cadencia`  — el **diario** no tiene cadencia por SKU: tiene **cupo por sucursal**
 *                      (`[IC.18]`). Decir «vencido» de un SKU bajo el ritmo diario sería inventar
 *                      una regla que nadie definió
 *
 * `fuente` dice de dónde salió la fecha (`folio_propio` | `kepler`), porque no son lo mismo: el
 * folio propio cuenta lo que nosotros sembramos; Kepler cuenta lo que Kepler decidió, y su
 * «completo» deja fuera SKUs con existencia (§2 de la fase).
 *
 * ⚠️ `security_invoker` + `GRANT` explícitos (lección U.7).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const SQL_VIEW = `
CREATE OR REPLACE VIEW analytics.v_count_clock AS
WITH ritmos(ritmo, cadence_days) AS (
  VALUES ('diario', NULL::int), ('mensual', 30), ('trimestral', 90)
), universo AS (
  SELECT a.tenant_id, a.warehouse_id, w.code AS warehouse_code, a.product_id,
         r.ritmo, r.cadence_days
    FROM commercial.abc_classification a
    JOIN commercial.warehouses w ON w.id = a.warehouse_id
   CROSS JOIN ritmos r
), propio AS (
  SELECT c.tenant_id, c.warehouse_id, i.product_id, c.ritmo,
         MAX(c.reconciled_at) AS fecha
    FROM commercial.inventory_counts c
    JOIN commercial.inventory_count_items i
      ON i.count_id = c.id AND i.tenant_id = c.tenant_id
   WHERE c.status = 'reconciled' AND i.product_id IS NOT NULL
   GROUP BY c.tenant_id, c.warehouse_id, i.product_id, c.ritmo
), kepler AS (
  SELECT v.warehouse_code, v.product_id, MAX(v.fecha)::timestamptz AS fecha
    FROM analytics.mv_erp_physical_count_variance v
   WHERE v.product_id IS NOT NULL
   GROUP BY v.warehouse_code, v.product_id
)
SELECT u.tenant_id,
       u.warehouse_id,
       u.warehouse_code,
       u.product_id,
       u.ritmo,
       u.cadence_days,
       COALESCE(p.fecha, k.fecha) AS last_counted_at,
       CASE WHEN p.fecha IS NOT NULL THEN 'folio_propio'
            WHEN k.fecha IS NOT NULL THEN 'kepler'
       END AS fuente,
       CASE WHEN COALESCE(p.fecha, k.fecha) IS NULL OR u.cadence_days IS NULL THEN NULL
            ELSE COALESCE(p.fecha, k.fecha) + (u.cadence_days || ' days')::interval
       END AS next_due,
       CASE
         WHEN u.cadence_days IS NULL                      THEN 'sin_cadencia'
         WHEN COALESCE(p.fecha, k.fecha) IS NULL          THEN 'nunca_contado'
         WHEN COALESCE(p.fecha, k.fecha)
              + (u.cadence_days || ' days')::interval <= now() THEN 'vencido'
         ELSE 'al_dia'
       END AS estado
  FROM universo u
  LEFT JOIN propio p
         ON p.tenant_id = u.tenant_id AND p.warehouse_id = u.warehouse_id
        AND p.product_id = u.product_id AND p.ritmo = u.ritmo
  LEFT JOIN kepler k
         ON u.ritmo = 'trimestral'
        AND k.warehouse_code = u.warehouse_code AND k.product_id = u.product_id`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(SQL_VIEW);
  await knex.raw(`ALTER VIEW analytics.v_count_clock SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_count_clock TO app_runtime`);

  const opts = (await knex.raw(
    `SELECT unnest(c.reloptions) AS o
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_count_clock'`)).rows.map((r) => r.o);
  if (!opts.some((x) => String(x).includes('security_invoker'))) {
    throw new Error('v_count_clock perdio security_invoker');
  }

  // Guarda ACOTADA a un almacen (leccion de [IC.21]: una guarda no puede costar lo que cuesta
  // la pantalla, y menos con el candado global de migraciones tomado). El almacen sale de la
  // FOTO, que es tabla indexada, y se elige uno que Kepler SI haya contado -- en el CEDIS no
  // hay historia de Kepler y la guarda no significaria nada ahi.
  const cand = (await knex.raw(
    `SELECT w.code FROM commercial.warehouses w
      WHERE EXISTS (SELECT 1 FROM analytics.mv_erp_physical_count_variance v
                     WHERE v.warehouse_code = w.code AND v.product_id IS NOT NULL)
      ORDER BY w.code LIMIT 1`)).rows;
  if (!cand.length) {
    console.log('  [ic16-reloj] vista creada · ⓘ guarda NO MEDIDA: ningun almacen tiene conteo de Kepler');
    return;
  }
  const { code } = cand[0];

  const d = (await knex.raw(
    `SELECT count(*)::int AS filas,
            count(*) FILTER (WHERE ritmo = 'trimestral' AND fuente = 'kepler')::int AS con_kepler,
            count(*) FILTER (WHERE estado = 'nunca_contado')::int AS nunca,
            count(*) FILTER (WHERE estado = 'sin_cadencia')::int AS sin_cadencia,
            count(DISTINCT ritmo)::int AS ritmos
       FROM analytics.v_count_clock WHERE warehouse_code = ?`, [code])).rows[0];

  if (d.ritmos !== 3) throw new Error(`almacen ${code}: ${d.ritmos} ritmos, se esperaban 3`);
  // ⭐ Lo que esta migracion existe para arreglar: que el reloj DEJE de decir "todo sin historia".
  if (d.con_kepler < 1) {
    throw new Error(`almacen ${code}: 0 filas con fecha de Kepler — el reloj sigue ciego`);
  }
  // El diario no tiene cadencia por SKU: un tercio exacto de las filas debe ser `sin_cadencia`.
  if (d.sin_cadencia !== Math.round(d.filas / 3)) {
    throw new Error(`almacen ${code}: ${d.sin_cadencia} sin_cadencia de ${d.filas} — el diario deberia ser un tercio`);
  }

  console.log(`  [ic16-reloj] vista creada · guarda en ${code}: ${d.filas} filas (3 ritmos)`
    + ` · ${d.con_kepler} con fecha de Kepler · ${d.nunca} nunca_contado`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_count_clock`);
};
