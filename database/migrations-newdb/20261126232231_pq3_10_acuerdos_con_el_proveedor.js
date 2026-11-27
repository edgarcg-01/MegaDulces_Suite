'use strict';
/**
 * `[PQ.3.10]` — Compras › Proveedores › **Acuerdos**: lo que se decide en una reunión con el proveedor, con dueño,
 * fecha compromiso y cierre con nota.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` §9.3 y §10.20 (DC43–DC46). ADR-128: el
 * acuerdo es la NOVENA fuente del contrato único de tareas (`[OR.4]`, `libs/contracts/src/work/task.contract.ts`),
 * no una tabla de tareas nueva — esta tabla es el dato propio del acuerdo y, a la vez, la tarea de su responsable.
 *
 *   · `commercial.supplier_agreements`:
 *       - `meeting_id` OBLIGATORIO (DC45): el acuerdo cuelga de su reunión (llave compuesta con el tenant). El
 *         proveedor NO se copia: se deriva de la reunión (ADR-056).
 *       - `area`: compras · marketing · finanzas · direccion (las de los participantes de Citas) · supplier.
 *       - `assigned_to` SIEMPRE una persona de la Suite. Si el área es `supplier`, es quien organizó la reunión
 *         (DC43, lo pone el dominio) y `supplier_contact` guarda el nombre de la persona del proveedor: obligatorio en
 *         ese caso y prohibido en los demás.
 *       - `status` en el canónico del contrato (pending · in_progress · done · cancelled). Cerrar exige nota:
 *         done/cancelled ⇔ closed_at, closed_by y closing_note (no vacía).
 *
 * Los usuarios no llevan FK a `identity.users` (igual que `organizer_user_id` de las reuniones): los valida el
 * dominio. Que la reunión esté REALIZADA para recibir acuerdos es regla del dominio (C1), no de la base: cruza tablas.
 *
 * ── Lo medido antes (sólo lectura, pg-prod 7688376744939610156, 2026-11-26) ───────────────────────────────────────
 *  · Citas salió ese día: 0 reuniones en `commercial.supplier_meetings`; sus llaves en 8 roles, 18 personas.
 *  · Ninguna de las ocho fuentes de `FUENTES_TAREA` es de Compras con el proveedor; la más parecida
 *    (`commercial.supervisor_tasks`) no guarda quién cerró ni con qué nota (ADR-128).
 *
 * RLS forzado por tenant. `app_runtime`: SELECT/INSERT/UPDATE; el DELETE de los privilegios por defecto del esquema
 * `commercial` se REVOCA (un acuerdo se cancela, no se borra). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS commercial`);

  if (!(await knex.schema.withSchema('commercial').hasTable('supplier_agreements'))) {
    await knex.raw(`
      CREATE TABLE commercial.supplier_agreements (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        meeting_id        uuid NOT NULL,
        area              text NOT NULL,
        description       text NOT NULL,
        supplier_contact  text,
        assigned_to       uuid NOT NULL,
        assigned_by       uuid NOT NULL,
        assigned_at       timestamptz NOT NULL DEFAULT now(),
        due_date          date NOT NULL,
        status            text NOT NULL DEFAULT 'pending',
        closed_at         timestamptz,
        closed_by         uuid,
        closing_note      text,
        created_by        text NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT supplier_agreements_tenant_id_key UNIQUE (tenant_id, id),
        CONSTRAINT fk_supplier_agreements_meeting FOREIGN KEY (tenant_id, meeting_id)
          REFERENCES commercial.supplier_meetings (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT supplier_agreements_area_chk CHECK (area IN ('compras', 'marketing', 'finanzas', 'direccion', 'supplier')),
        CONSTRAINT supplier_agreements_description_chk CHECK (btrim(description) <> '' AND char_length(description) <= 500),
        -- ⚠️ Un CHECK que da NULL DEJA PASAR la fila (la trampa de PQ.3.2): COALESCE(…, false) lo vuelve rechazo.
        CONSTRAINT supplier_agreements_contact_chk CHECK (COALESCE(
          (area = 'supplier') = (supplier_contact IS NOT NULL)
          AND (supplier_contact IS NULL OR (btrim(supplier_contact) <> '' AND char_length(supplier_contact) <= 120)),
          false)),
        CONSTRAINT supplier_agreements_status_chk CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
        CONSTRAINT supplier_agreements_closed_chk CHECK (COALESCE(
          (status IN ('done', 'cancelled')) = (closed_at IS NOT NULL)
          AND (closed_at IS NULL) = (closed_by IS NULL)
          AND (closed_at IS NULL) = (closing_note IS NULL)
          AND (closing_note IS NULL OR btrim(closing_note) <> ''),
          false))
      )`);
  }
  // Los acuerdos de una reunión (el detalle de la cita y la reunión siguiente, que abre con los pendientes).
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_supplier_agreements_reunion ON commercial.supplier_agreements (tenant_id, meeting_id)`);
  // «Mi trabajo»: lo abierto de una persona.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_supplier_agreements_responsable
      ON commercial.supplier_agreements (tenant_id, assigned_to) WHERE status IN ('pending', 'in_progress')`);
  // La pestaña: vencidos y de la semana primero.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_supplier_agreements_vence
      ON commercial.supplier_agreements (tenant_id, due_date) WHERE status IN ('pending', 'in_progress')`);

  await knex.raw(`ALTER TABLE commercial.supplier_agreements ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.supplier_agreements FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'commercial' AND tablename = 'supplier_agreements' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON commercial.supplier_agreements
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON commercial.supplier_agreements TO app_runtime;
        -- Los privilegios POR DEFECTO del esquema commercial le dan a app_runtime también DELETE (PQ.3.5):
        -- sin este REVOKE, «un acuerdo se cancela, no se borra» sería una intención.
        REVOKE DELETE, TRUNCATE ON commercial.supplier_agreements FROM app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON commercial.supplier_agreements TO dev_ro;
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON TABLE commercial.supplier_agreements IS
    '[PQ.3.10] Compras › Proveedores › Acuerdos: lo que se decide en una reunión con el proveedor, con área, responsable, fecha compromiso y cierre con nota (anexo C §10.20). Novena fuente del contrato único de tareas (ADR-128). El del proveedor lo sigue quien organizó la cita (DC43).'`);

  const { rows: [n] } = await knex.raw(`SELECT count(*)::int AS acuerdos FROM commercial.supplier_agreements`);
  // eslint-disable-next-line no-console
  console.log(`[PQ.3.10] commercial.supplier_agreements: ${n.acuerdos} acuerdo(s)`);
};

/**
 * Deshace lo que hizo el `up` sin borrar decisiones humanas (regla 5): con acuerdos capturados la tabla se conserva y
 * se dice; sólo vacía se quita.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('commercial').hasTable('supplier_agreements'))) return;
  const n = Number((await knex.raw(`SELECT count(*)::int AS n FROM commercial.supplier_agreements`)).rows[0].n);
  if (n > 0) {
    // eslint-disable-next-line no-console
    console.log(`[PQ.3.10] commercial.supplier_agreements tiene ${n} acuerdo(s) hechos por personas: se conserva (regla 5).`);
    return;
  }
  await knex.raw(`DROP TABLE commercial.supplier_agreements`);
};
