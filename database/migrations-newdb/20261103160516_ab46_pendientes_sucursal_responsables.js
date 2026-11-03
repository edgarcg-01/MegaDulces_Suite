'use strict';
/**
 * `[AB.46]` — Quién se atribuyó cada pendiente de la sucursal.
 *
 * Edgar (2026-11-03): «darle acceso a cada persona de la sucursal a la misma información … para que
 * todos puedan atribuirse el resolver los pendientes». Una fila = una persona dijo «yo lo resuelvo» de
 * UN pendiente (`cola` + `clave`, ver `sucursal-pendientes.registry.ts` / `.sql.ts`) de UN almacén.
 *
 * - Un pendiente tiene a lo más UN responsable vivo (índice único parcial `deleted_at IS NULL`).
 * - Soltarlo es borrado lógico (`deleted_at`/`deleted_by`): queda la constancia de quién lo tuvo.
 * - No se guarda el pendiente: la cola lo sigue calculando del dato dueño. Cuando el pendiente se
 *   resuelve deja de salir en la cola y su fila aquí ya no se pinta (no hace falta limpiarla).
 *
 * Aditiva: la API desplegada no la lee; el código nuevo la lee y escribe. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[ab46_responsables]';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('commercial').hasTable('sucursal_pendiente_responsables'))) {
    await knex.raw(`
      CREATE TABLE commercial.sucursal_pendiente_responsables (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        warehouse_id uuid NOT NULL REFERENCES commercial.warehouses(id),
        cola         text NOT NULL,
        clave        text NOT NULL,
        user_id      uuid NOT NULL,
        nombre       text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        created_by   uuid NOT NULL,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        updated_by   uuid,
        deleted_at   timestamptz,
        deleted_by   uuid,
        CONSTRAINT sucursal_pend_resp_cola_chk  CHECK (length(btrim(cola)) > 0),
        CONSTRAINT sucursal_pend_resp_clave_chk CHECK (length(btrim(clave)) > 0)
      )`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_sucursal_pend_resp_vivo
                    ON commercial.sucursal_pendiente_responsables (tenant_id, warehouse_id, cola, clave)
                    WHERE deleted_at IS NULL`);

  await knex.raw(`ALTER TABLE commercial.sucursal_pendiente_responsables ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.sucursal_pendiente_responsables FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='sucursal_pendiente_responsables' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON commercial.sucursal_pendiente_responsables
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // Soltar es UPDATE (borrado lógico); nada se borra de verdad.
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        REVOKE DELETE ON commercial.sucursal_pendiente_responsables FROM app_runtime;
        GRANT SELECT, INSERT, UPDATE ON commercial.sucursal_pendiente_responsables TO app_runtime;
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON TABLE commercial.sucursal_pendiente_responsables IS
    '[AB.46] Quién se atribuyó cada pendiente de la sucursal (cola + clave). Uno vivo por pendiente; soltar = borrado lógico.'`);
  console.log(`${TAG} lista`);
};

exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('commercial').hasTable('sucursal_pendiente_responsables')) {
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.sucursal_pendiente_responsables`);
    if (rows[0].n > 0) throw new Error(`${TAG} hay ${rows[0].n} fila(s): bajar la migración tiraría quién tomó cada pendiente.`);
  }
  await knex.raw(`DROP TABLE IF EXISTS commercial.sucursal_pendiente_responsables`);
};
