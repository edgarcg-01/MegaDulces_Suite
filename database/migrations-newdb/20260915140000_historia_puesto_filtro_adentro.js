/**
 * `[AU.19]` — La historia de puesto se cerraba sola contra un evento sin puesto.
 *
 * ── Cómo apareció ─────────────────────────────────────────────────────────
 *
 * `[AU.18]` movió a tres personas a `jefe_zona` y **las tres quedaron sin tramo
 * vigente**: su puesto actual figuraba con fecha de fin el mismo día que empezó.
 *
 * La causa no fue el cambio: fue que `v_position_history` calcula el `lead()`
 * DENTRO del CTE y aplica `WHERE position_code IS NOT NULL` DESPUÉS. O sea, un
 * evento `puesto_asignado` sin `position_code` no se muestra como tramo, pero
 * **sí participa de la ventana**: se vuelve «el siguiente» y le pone fecha de
 * fin al tramo que de verdad está vigente.
 *
 * Es fragilidad latente, no un caso raro: cualquier evento con ese nombre y otra
 * forma de `detalle` —una migración, un script, otra sesión— borra del tablero
 * el puesto actual de alguien, sin ruido.
 *
 * ⛔ Lo que NO cambia: la definición de tramo, el origen, ni una sola fila de
 * datos. Sólo se mueve el filtro adentro de la ventana, que es donde tenía que
 * estar para que `lead()` mire sólo tramos reales.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW identity.v_position_history AS
    WITH ev AS (
      SELECT e.tenant_id,
             e.user_id,
             e.detalle ->> 'position_code'   AS position_code,
             e.detalle ->> 'department_code' AS department_code,
             COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at) AS desde,
             COALESCE(
               e.detalle ->> 'desde_origen',
               CASE WHEN (e.detalle ->> 'origen') LIKE 'backfill%'
                      OR (e.detalle ->> 'origen') LIKE 'decision del lead%'
                    THEN 'registro_sistema' ELSE 'cambio' END) AS desde_origen,
             e.detalle ->> 'criterio' AS motivo,
             e.actor_user_id,
             e.actor_username,
             e.created_at AS registrado_at,
             lead(COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at))
               OVER (PARTITION BY e.tenant_id, e.user_id
                         ORDER BY COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at),
                                  e.created_at) AS hasta
        FROM identity.user_events e
       WHERE e.event IN ('puesto_asignado', 'puesto_retirado')
         -- ⭐ ADENTRO de la ventana: un evento sin puesto no es un tramo y no
         --    puede cerrar el de nadie.
         AND e.detalle ->> 'position_code' IS NOT NULL
    )
    SELECT tenant_id, user_id, position_code, department_code, desde, hasta,
           hasta IS NULL AS vigente,
           desde_origen, motivo, actor_user_id, actor_username, registrado_at
      FROM ev;
  `);

  // `[ADR-057]` Tras un CREATE OR REPLACE VIEW hay que re-aplicar lo que no se
  // hereda. Se re-otorga sólo si el rol existe.
  const { rows: rol } = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`);
  if (rol.length) {
    await knex.raw(`GRANT SELECT ON identity.v_position_history TO app_runtime`);
  }

  // `[AU.18]` dejó 3 eventos redundantes: el trigger `trg_registrar_cambio_de_puesto`
  // ya había asentado el cambio con la forma correcta. Se retiran los duplicados,
  // no los `desvio_de_puesto`, que sí aportan el motivo.
  const borrados = await knex('identity.user_events')
    .where({ event: 'puesto_asignado' })
    .whereRaw(`detalle ->> 'origen' = 'migracion_AU.18'`)
    .del();

  const { rows: v } = await knex.raw(
    `SELECT count(*)::int AS internos,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM identity.v_position_history h
               WHERE h.tenant_id = u.tenant_id AND h.user_id = u.id AND h.hasta IS NULL))::int AS con_tramo_vigente
       FROM identity.users u
      WHERE u.tenant_id = '00000000-0000-0000-0000-00000000d01c'
        AND u.deleted_at IS NULL AND u.kind = 'interno'`,
  );

  console.log(
    `[AU.19] ${borrados} evento(s) duplicado(s) retirado(s) · ` +
      `${v[0].con_tramo_vigente}/${v[0].internos} personas con tramo VIGENTE`,
  );

  if (v[0].con_tramo_vigente !== v[0].internos) {
    throw new Error(
      `[AU.19] Quedan ${v[0].internos - v[0].con_tramo_vigente} persona(s) sin tramo vigente: ` +
        `el arreglo no alcanzó y hay otra causa. Se revierte.`,
    );
  }
};

exports.down = async function down(knex) {
  // Vuelve a la definición anterior: el filtro afuera de la ventana.
  await knex.raw(`
    CREATE OR REPLACE VIEW identity.v_position_history AS
    WITH ev AS (
      SELECT e.tenant_id, e.user_id,
             e.detalle ->> 'position_code'   AS position_code,
             e.detalle ->> 'department_code' AS department_code,
             COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at) AS desde,
             COALESCE(e.detalle ->> 'desde_origen',
               CASE WHEN (e.detalle ->> 'origen') LIKE 'backfill%'
                      OR (e.detalle ->> 'origen') LIKE 'decision del lead%'
                    THEN 'registro_sistema' ELSE 'cambio' END) AS desde_origen,
             e.detalle ->> 'criterio' AS motivo,
             e.actor_user_id, e.actor_username, e.created_at AS registrado_at,
             lead(COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at))
               OVER (PARTITION BY e.tenant_id, e.user_id
                         ORDER BY COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at),
                                  e.created_at) AS hasta
        FROM identity.user_events e
       WHERE e.event IN ('puesto_asignado', 'puesto_retirado')
    )
    SELECT tenant_id, user_id, position_code, department_code, desde, hasta,
           hasta IS NULL AS vigente, desde_origen, motivo, actor_user_id,
           actor_username, registrado_at
      FROM ev WHERE position_code IS NOT NULL;
  `);
};
