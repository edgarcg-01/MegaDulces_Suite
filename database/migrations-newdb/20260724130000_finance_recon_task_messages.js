/**
 * MA.8 — Chat por tarea de conciliación (Maat · ADR-028/016).
 *
 * `finance.recon_task_messages` = hilo de conversación de UNA tarea de
 * conciliación. La persona de Finanzas reporta que ya la concilió en Kepler;
 * **Maat verifica** (re-match: ¿el movimiento ya cruza en el 102?) y responde en
 * el mismo hilo; al verificar cierra la tarea y **asigna la siguiente**.
 *
 *   role   = quién habla: 'user' (persona) | 'maat' (motor, determinista)
 *   kind   = 'comment'    comentario libre
 *            'report'     "ya lo hice en Kepler" → dispara verificación
 *            'verify'     veredicto de Maat (verificado / aún no cruza)
 *            'assignment' Maat avisa la siguiente tarea asignada
 *
 * El LLM queda fuera: Maat "verifica" cruzando recon_status y "asigna" por el
 * mismo reparto determinista. Convención A.0mt: tenant_id + RLS forzado + grants.
 * FK compuesta a finance.recon_tasks (tenant_id, id). Idempotente (hasTable).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  await knex.raw(`GRANT USAGE ON SCHEMA finance TO app_runtime`);

  if (!(await knex.schema.withSchema('finance').hasTable('recon_task_messages'))) {
    await knex.raw(`
      CREATE TABLE finance.recon_task_messages (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        task_id     uuid NOT NULL,
        role        text NOT NULL CHECK (role IN ('user','maat')),
        kind        text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','report','verify','assignment')),
        username    text,
        body        text NOT NULL,
        meta        jsonb,                 -- {verified, next_task_id, matched, pending} — evidencia del veredicto
        created_at  timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, task_id) REFERENCES finance.recon_tasks (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_fin_recon_msgs_task ON finance.recon_task_messages (tenant_id, task_id, created_at)`);
    await knex.raw(`ALTER TABLE finance.recon_task_messages ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.recon_task_messages FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='recon_task_messages' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.recon_task_messages
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.recon_task_messages TO app_runtime`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('recon_task_messages');
};
