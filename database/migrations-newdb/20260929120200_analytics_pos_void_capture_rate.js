'use strict';
/**
 * `[BP.9]` — `analytics.v_pos_void_capture_rate`: **el denominador que vuelve auditable la
 * captura manual de retiros.**
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────────────────────
 * `commercial.pos_line_voids` es captura humana (§ Fase BP: Kepler autentica el retiro y no lo
 * escribe). Sin un denominador, una captura manual es un papel: nadie sabe cuánto se omite, y un
 * supervisor que no registra nada se ve idéntico a uno que no autorizó nada.
 *
 * ── ⛔ El termómetro que se DESCARTÓ, y por qué ───────────────────────────────────────────────
 * El primer diseño contaba las lecturas de `kdpv_gerentes` —la tabla que `pv_aut_cambios.kpl`
 * consulta para validar la contraseña— vía `pg_stat_user_tables`. Se midió y se cayó solo:
 *
 *   · Las lecturas **no se replican**: el contador real vive en el Postgres de cada sucursal, así
 *     que habría que abrir conexiones a **las 9 máquinas donde se cobra**. El `seq_scan=1019` de
 *     la réplica es ruido de nuestro propio pipeline releyendo el catálogo, no actividad del POS.
 *   · **Mezcla** aperturas de caja (`PV_abre_caja.kpl`) con autorizaciones.
 *   · **No dice quién ni en qué caja.**
 *   · **Se reinicia** si el Postgres de la sucursal cae, y el hueco no se puede interpolar.
 *   · Y **no puede publicar nada sin calibrar** cuántos escaneos genera una autorización.
 *   · Encima el poller se contaba a sí mismo: verificado, cada consulta a la tabla suma +1.
 *
 * `pg_stat_statements` daría un denominador exacto, pero **está disponible y no instalada**, y
 * activarla exige reiniciar el Postgres de la sucursal = parar la venta. Descartado.
 *
 * ── El denominador que se eligió: TICKETS ────────────────────────────────────────────────────
 * Los tickets del POS ya están en el ODS (`kepler_ods.kdm1`, doctype `U-D-10`, frescos al día).
 * La tasa **capturas por cada mil tickets** es comparable entre sucursales y entre semanas, no
 * necesita calibración, no necesita una sola conexión nueva, y se DERIVA — cero tablas, cero
 * importers, como manda la regla del proyecto.
 *
 * ⚠️ **Lo que esta vista mide, y lo que NO:** mide cumplimiento **RELATIVO** —una plaza contra
 * sus pares, una semana contra la anterior—. **No** dice cuántos retiros quedaron sin registrar:
 * eso exigiría saber cuántos ocurrieron, que es justo lo que Kepler no guarda. Una plaza con 0.2
 * capturas por mil tickets al lado de otra con 8 es una pregunta; no es una medición de fraude.
 *
 * ── Rendimiento, medido ──────────────────────────────────────────────────────────────────────
 * 12 semanas: **318 ms** contra prod. La forma importa — agregar `kdm1` primero y unir después
 * (96 filas en vez de 44 mil) bajó de **702 ms a 318**. Si algún día no alcanza, se materializa
 * con su umbral registrado (§19), pero hoy no hace falta.
 *
 * ── `security_invoker` obligatorio ───────────────────────────────────────────────────────────
 * `pos_line_voids` y `warehouses` tienen RLS forzado. Sin `security_invoker` la vista leería con
 * los privilegios del dueño y **saltaría el aislamiento por tenant**. ⚠️ Y hay que re-aplicarlo
 * después de cada `CREATE OR REPLACE VIEW`: no se hereda (regla dura, ADR-057).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_pos_void_capture_rate AS
    WITH tickets AS (
      -- Agregar PRIMERO: 44 mil filas se vuelven 96 antes de unir. 318 ms contra 702.
      SELECT h.sucursal,
             date_trunc('week', h.c9)::date AS week_start,
             count(*)::bigint               AS tickets
        FROM kepler_ods.kdm1 h
       WHERE h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = '10'
         AND h.c9 >= (date_trunc('week', now() AT TIME ZONE 'America/Mexico_City') - interval '11 weeks')
       GROUP BY 1, 2
    ), capturas AS (
      SELECT v.tenant_id,
             v.warehouse_id,
             date_trunc('week', v.occurred_at AT TIME ZONE 'America/Mexico_City')::date AS week_start,
             count(*)::bigint                        AS capturas,
             count(DISTINCT v.supervisor_code)::int  AS supervisores,
             sum(v.est_value)                        AS valor_valorado,
             count(*) FILTER (WHERE v.est_value IS NULL)::bigint AS sin_valorar
        FROM commercial.pos_line_voids v
       WHERE v.occurred_at >= (date_trunc('week', now() AT TIME ZONE 'America/Mexico_City') - interval '11 weeks')
       GROUP BY 1, 2, 3
    )
    SELECT w.tenant_id,
           w.code                        AS warehouse_code,
           w.name                        AS warehouse_name,
           t.week_start,
           t.tickets,
           COALESCE(c.capturas, 0)       AS capturas,
           COALESCE(c.supervisores, 0)   AS supervisores,
           -- La tasa. NULL si no hubo tickets: sin denominador no hay razón, y un 0 diría
           -- "nadie registró" donde en realidad no hubo con qué comparar (ADR-056).
           CASE WHEN t.tickets > 0
                THEN round(COALESCE(c.capturas, 0) * 1000.0 / t.tickets, 2)
                ELSE NULL END            AS capturas_por_mil_tickets,
           -- El monto viaja SIEMPRE con cuántos quedaron sin valorar. Leer la suma sola afirma
           -- algo distinto de lo que el dato sostiene.
           c.valor_valorado,
           COALESCE(c.sin_valorar, 0)    AS sin_valorar
      FROM tickets t
      JOIN commercial.warehouses w
        ON w.code = t.sucursal AND w.deleted_at IS NULL
      LEFT JOIN capturas c
        ON c.tenant_id = w.tenant_id AND c.warehouse_id = w.id AND c.week_start = t.week_start
  `);

  // ⚠️ Se re-aplica SIEMPRE después de CREATE OR REPLACE: no se hereda, y sin esto la vista
  // leería con los privilegios del dueño y saltaría el RLS de `pos_line_voids`.
  await knex.raw(`ALTER VIEW analytics.v_pos_void_capture_rate SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_pos_void_capture_rate TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_pos_void_capture_rate IS
      '[BP.9] Cumplimiento RELATIVO de la captura de retiros en caja: capturas por cada mil tickets, '
      'por sucursal y semana, 12 semanas. Derivada (cero tablas, cero importers). '
      'MIDE una plaza contra sus pares y una semana contra la anterior. NO mide cuantos retiros '
      'quedaron sin registrar: eso exigiria saber cuantos ocurrieron, que es justo lo que Kepler no guarda. '
      'Se descarto contar lecturas de kdpv_gerentes (exigia conectarse a los 9 POS, mezclaba aperturas '
      'de caja, sin atribucion, se reinicia, el poller se contaba a si mismo y necesitaba calibracion). '
      'Medido: 318 ms agregando kdm1 antes de unir (702 ms al revés).'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_pos_void_capture_rate`);
};
