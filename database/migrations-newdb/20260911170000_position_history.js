'use strict';
/**
 * `[OR.6]` — Historia de puesto: «¿quién respondía de esto en marzo?».
 *
 * ── ⚠️ Se aparta del plan, y conviene decir por qué ──────────────────────────────────────────
 * El plan pedía una TABLA `identity.position_history`. **Sería una segunda materialización de algo
 * que ya está registrado**: `identity.user_events` es la bitácora append-only de la persona y ya
 * guarda `puesto_asignado` (41 filas de `[OR.1c]`/`[OR.1d]`). La regla más dura del proyecto es
 * «si necesitás otra forma del dato, **derivá** (vista), no materialices una segunda» — y este es
 * exactamente ese caso. Así que la historia es una **VISTA**, y lo que sí faltaba es el
 * **mecanismo que la alimenta solo**.
 *
 * ── El hueco real ───────────────────────────────────────────────────────────────────────────
 * Hoy los eventos de puesto los escriben **las migraciones y nada más**. Un cambio hecho desde la
 * UI, un importer o un script no deja rastro, así que la historia se rompería en cuanto alguien
 * mueva a una persona por fuera. Por eso el asiento pasa a un **trigger sobre `identity.users`**:
 * el que escribe el dato es el que escribe el renglón, sin depender de que cada camino se acuerde.
 *
 * ── Lo que NO se sabe, y se DECLARA (ADR-056) ───────────────────────────────────────────────
 * Medido: **41 de 100 personas tienen evento de puesto; 59 no tienen ninguno.** De esas 59 no
 * sabemos desde cuándo ocupan su puesto. Rellenar con `users.created_at` y callarlo sería dibujar
 * un dato: diría que llevan en el puesto desde que se creó su cuenta, que es falso para cualquiera
 * que haya cambiado de puesto antes de que esto existiera.
 *
 * La vista expone **`desde_origen`** con tres valores, y ninguno se confunde con otro:
 *   · `cambio`            el trigger lo vio pasar. **Es la fecha real.**
 *   · `registro_sistema`  la fecha en que el sistema lo supo (los 41 del backfill de `[OR.1]`).
 *                         NO es la fecha en que la persona tomó el puesto.
 *   · `estimado_alta`     no se sabe: se usa `users.created_at` como piso. **Es una estimación.**
 *
 * ── Detalle que importa ─────────────────────────────────────────────────────────────────────
 * El inicio del tramo va en `detalle->>'desde'`, **no** en `created_at` del evento. Retrofechar el
 * `created_at` haría que la bitácora mienta sobre cuándo se registró el asiento; separar las dos
 * fechas deja las dos verdades: cuándo empezó el tramo y cuándo se supo.
 *
 * Aditiva e idempotente. No toca personas ni permisos.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // ── 1. El trigger que alimenta la historia sola ───────────────────────────
  // Escribe en la bitácora que YA existe. `identity.user_events` es append-only
  // y app_runtime sólo tiene SELECT/INSERT, así que nadie puede reescribir la
  // historia desde la app.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity.registrar_cambio_de_puesto() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = identity, public AS $fn$
    BEGIN
      IF NEW.position_code IS NOT DISTINCT FROM OLD.position_code THEN
        RETURN NEW;
      END IF;

      INSERT INTO identity.user_events
        (tenant_id, user_id, event, detalle, actor_user_id, actor_username)
      VALUES (
        NEW.tenant_id,
        NEW.id,
        CASE WHEN NEW.position_code IS NULL THEN 'puesto_retirado' ELSE 'puesto_asignado' END,
        jsonb_build_object(
          'position_code', NEW.position_code,
          'position_code_anterior', OLD.position_code,
          'department_code', NEW.department_code,
          'desde', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
          'desde_origen', 'cambio',
          'origen', 'trigger identity.users'
        ),
        NEW.updated_by,
        NULL
      );
      RETURN NEW;
    END;
    $fn$`);

  const trg = await knex.raw(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'identity.users'::regclass
      AND tgname = 'trg_registrar_cambio_de_puesto'`,
  );
  if (!trg.rows.length) {
    await knex.raw(`
      CREATE TRIGGER trg_registrar_cambio_de_puesto
        AFTER UPDATE OF position_code ON identity.users
        FOR EACH ROW EXECUTE FUNCTION identity.registrar_cambio_de_puesto()`);
    console.log('  [OR.6] + trigger trg_registrar_cambio_de_puesto');
  }

  // ── 2. Las 59 sin rastro, declaradas como estimación ──────────────────────
  // ⚠️ `desde` va al DETALLE con `users.created_at`; el `created_at` del evento
  // queda en `now()`, que es la verdad: hoy se registró. Dos fechas, dos hechos.
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');
  for (const tenant of tenants) {
    const sinRastro = await knex.raw(
      `SELECT u.id, u.username, u.position_code, u.department_code, u.created_at
         FROM identity.users u
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.position_code IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM identity.user_events e
             WHERE e.tenant_id = u.tenant_id AND e.user_id = u.id
               AND e.event IN ('puesto_asignado', 'puesto_retirado'))
        ORDER BY u.username`,
      [tenant],
    );

    for (const u of sinRastro.rows) {
      await knex('identity.user_events').insert({
        tenant_id: tenant,
        user_id: u.id,
        event: 'puesto_asignado',
        detalle: JSON.stringify({
          position_code: u.position_code,
          department_code: u.department_code,
          desde: u.created_at,
          // Lo que NO se sabe, dicho con su nombre.
          desde_origen: 'estimado_alta',
          origen: 'backfill [OR.6]',
          nota: 'no habia rastro de cuando tomo el puesto: se usa la fecha de alta de la cuenta como PISO, no como hecho',
        }),
        actor_user_id: null,
        actor_username: 'migracion [OR.6]',
      });
    }
    console.log(`  [OR.6] ${sinRastro.rows.length} persona/s sin rastro: tramo abierto con fecha ESTIMADA`);

    // ── 3. La vista ─────────────────────────────────────────────────────────
    // Los tramos salen de emparejar eventos consecutivos con LEAD(): el
    // siguiente evento de la misma persona es el que cierra el anterior. Un
    // `puesto_retirado` cierra sin abrir.
    await knex.raw(`
      CREATE OR REPLACE VIEW identity.v_position_history AS
      WITH ev AS (
        SELECT
          e.tenant_id,
          e.user_id,
          e.detalle ->> 'position_code'   AS position_code,
          e.detalle ->> 'department_code' AS department_code,
          COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at) AS desde,
          COALESCE(
            e.detalle ->> 'desde_origen',
            CASE WHEN e.detalle ->> 'origen' LIKE 'backfill%'
                   OR e.detalle ->> 'origen' LIKE 'decision del lead%'
                 THEN 'registro_sistema' ELSE 'cambio' END
          ) AS desde_origen,
          e.detalle ->> 'criterio' AS motivo,
          e.actor_user_id,
          e.actor_username,
          e.created_at AS registrado_at,
          LEAD(COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at))
            OVER (PARTITION BY e.tenant_id, e.user_id
                      ORDER BY COALESCE((e.detalle ->> 'desde')::timestamptz, e.created_at),
                               e.created_at) AS hasta
        FROM identity.user_events e
        WHERE e.event IN ('puesto_asignado', 'puesto_retirado')
      )
      SELECT
        ev.tenant_id, ev.user_id, ev.position_code, ev.department_code,
        ev.desde, ev.hasta,
        (ev.hasta IS NULL) AS vigente,
        ev.desde_origen, ev.motivo,
        ev.actor_user_id, ev.actor_username, ev.registrado_at
      FROM ev
      WHERE ev.position_code IS NOT NULL`);

    // ⚠️ GOTCHA del proyecto: tras cada CREATE OR REPLACE VIEW sobre una vista
    // que lee una tabla con RLS hay que RE-APLICAR `security_invoker` y el
    // GRANT — no se heredan, y una migración de la Fase U ya perdió uno.
    await knex.raw(`ALTER VIEW identity.v_position_history SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON identity.v_position_history TO app_runtime`);
    await knex.raw(`COMMENT ON VIEW identity.v_position_history IS
      '[OR.6] Historia de puesto DERIVADA de identity.user_events (no es una tabla: seria una segunda materializacion). Los tramos salen de emparejar eventos con LEAD(). desde_origen dice que tan cierta es la fecha de inicio: cambio = el trigger lo vio (real) · registro_sistema = cuando el sistema lo supo, NO cuando la persona tomo el puesto · estimado_alta = no se sabe, se usa la fecha de alta como piso.'`);

    // ── 4. La foto ──────────────────────────────────────────────────────────
    const foto = await knex.raw(
      `SELECT desde_origen, count(*)::int n, count(*) FILTER (WHERE vigente)::int vigentes
         FROM identity.v_position_history WHERE tenant_id = ?
        GROUP BY 1 ORDER BY 2 DESC`, [tenant]);
    console.log(`  [OR.6] tramos por certeza de la fecha de inicio:`);
    foto.rows.forEach((r) =>
      console.log(`     ${String(r.desde_origen).padEnd(18)} ${String(r.n).padStart(4)} tramo/s · ${r.vigentes} vigente/s`));

    const cubiertos = await knex.raw(
      `SELECT count(*)::int n FROM identity.users u
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
          AND EXISTS (SELECT 1 FROM identity.v_position_history h
                       WHERE h.tenant_id = u.tenant_id AND h.user_id = u.id AND h.vigente)`, [tenant]);
    const total = await knex('identity.users')
      .where({ tenant_id: tenant, kind: 'interno', activo: true })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    console.log(`  [OR.6] ${cubiertos.rows[0].n}/${total.n} personas con tramo VIGENTE en la historia`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS identity.v_position_history`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_registrar_cambio_de_puesto ON identity.users`);
  await knex.raw(`DROP FUNCTION IF EXISTS identity.registrar_cambio_de_puesto()`);
  // Los eventos NO se borran: `user_events` es append-only por diseño.
  console.log('  [OR.6] down: vista y trigger retirados. Los eventos se conservan.');
};
