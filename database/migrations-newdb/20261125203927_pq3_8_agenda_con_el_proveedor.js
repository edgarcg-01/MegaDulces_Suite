'use strict';
/**
 * `[PQ.3.8]` — Compras › Proveedores › **Citas**: la reunión con el proveedor y quién va.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` §9.1 y §10.15 (DC9, DC10, DC12, DC16, DC34).
 * La reunión es la raíz del apartado «Proveedores» (DC32): la revisión de negocio y el plan de trabajo SON reuniones,
 * y cada acuerdo (PQ.3.10) saldrá de una. Por eso es lo primero que se construye.
 *
 *   · `commercial.supplier_meetings`: una reunión con un proveedor — tipo (cita con ejecutivo · revisión de negocio ·
 *     plan de trabajo), estado (por confirmar · agendada · realizada · cancelada), inicio y fin, modalidad y lugar,
 *     temas en orden, quién organiza, el año del plan (sólo en el plan de trabajo, DC12) y la minuta.
 *       - REALIZADA exige la minuta (§9.1): una reunión que pasó sin minuta no se da por hecha.
 *       - CANCELADA exige el motivo. Nada se borra.
 *   · `commercial.supplier_meeting_participants`: quién va. Por Mega Dulces, un usuario con su área (Compras,
 *     Mercadotecnia, Finanzas o Dirección; DC9, DC16); por el proveedor, nombre y puesto. Un usuario no se repite en
 *     la misma reunión; quitar a alguien es poner `removed_at`, no borrar la fila.
 *
 * Datos PROPIOS de la Suite (regla 1: las reuniones no dejan rastro en Kepler; nada se copia). La clave del proveedor
 * es la de Kepler, la misma de `commercial.purchase_review_rules` y de la vista PQ.3.1: 24 claves vivas en Kepler sólo
 * tienen ficha BORRADA en `catalog.suppliers`, así que un FK a la ficha las dejaría fuera (§5, R4). Los usuarios
 * tampoco llevan FK a `identity.users` (igual que `reviewer_user_id` de las reglas): los valida el dominio.
 *
 * NO entra aquí (§10.15): el teléfono y el correo del ejecutivo (PQ.3.13 decide si se extiende el contacto que ya
 * existe, `finance.supplier_collection_contacts`), la periodicidad de la revisión (PQ.3.9), la invitación (PQ.3.12)
 * ni los acuerdos (PQ.3.10).
 *
 * ── Lo medido antes (sólo lectura, pg-prod 7688376744939610156, 2026-11-25) ───────────────────────────────────────
 *  · Ninguna tabla ni vista con «meeting», «reunion», «minuta» o «agenda_prov» en el nombre: las reuniones con el
 *    proveedor no viven en ninguna parte de la Suite (hoy se agendan fuera).
 *  · 47 de 340 proveedores hacen el 80 % de la compra (medido el 2026-11-20, §9.1): ésos llevan revisión trimestral.
 *
 * RLS forzado por tenant. `app_runtime`: SELECT/INSERT/UPDATE; el DELETE que dan los privilegios por defecto del
 * esquema `commercial` se REVOCA (lección de PQ.3.5). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLAS = ['supplier_meetings', 'supplier_meeting_participants'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS commercial`);

  if (!(await knex.schema.withSchema('commercial').hasTable('supplier_meetings'))) {
    await knex.raw(`
      CREATE TABLE commercial.supplier_meetings (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        supplier_code      text NOT NULL,
        kind               text NOT NULL,
        status             text NOT NULL DEFAULT 'scheduled',
        starts_at          timestamptz NOT NULL,
        ends_at            timestamptz NOT NULL,
        mode               text NOT NULL,
        location           text,
        topics             text[] NOT NULL DEFAULT '{}',
        organizer_user_id  uuid NOT NULL,
        work_plan_year     smallint,
        minutes            text,
        minutes_by         text,
        minutes_at         timestamptz,
        cancelled_reason   text,
        cancelled_by       text,
        cancelled_at       timestamptz,
        created_by         text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_by         text,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT supplier_meetings_tenant_id_key UNIQUE (tenant_id, id),
        CONSTRAINT supplier_meetings_supplier_chk CHECK (btrim(supplier_code) <> ''),
        CONSTRAINT supplier_meetings_kind_chk CHECK (kind IN ('executive', 'business_review', 'work_plan')),
        CONSTRAINT supplier_meetings_status_chk CHECK (status IN ('to_confirm', 'scheduled', 'held', 'cancelled')),
        CONSTRAINT supplier_meetings_mode_chk CHECK (mode IN ('in_person', 'call', 'video')),
        CONSTRAINT supplier_meetings_time_chk CHECK (ends_at > starts_at),
        CONSTRAINT supplier_meetings_location_chk CHECK (location IS NULL OR btrim(location) <> ''),
        -- ⚠️ Un CHECK que da NULL DEJA PASAR la fila (la trampa de PQ.3.2): array_position(…, NULL) es NULL cuando
        -- NO hay nulos, por eso se pregunta «IS NULL» y no se compara.
        CONSTRAINT supplier_meetings_topics_chk CHECK (array_position(topics, NULL) IS NULL AND cardinality(topics) <= 20),
        -- DC12: un plan de trabajo es de UN año; ningún otro tipo lleva año.
        CONSTRAINT supplier_meetings_work_plan_chk CHECK (
          (kind = 'work_plan') = (work_plan_year IS NOT NULL)
          AND (work_plan_year IS NULL OR work_plan_year BETWEEN 2025 AND 2100)),
        -- §9.1: realizada = con minuta, y la minuta dice quién y cuándo.
        CONSTRAINT supplier_meetings_held_chk CHECK (
          (status = 'held') = (minutes IS NOT NULL)
          AND (minutes IS NULL OR (btrim(minutes) <> '' AND minutes_by IS NOT NULL AND minutes_at IS NOT NULL))),
        CONSTRAINT supplier_meetings_cancelled_chk CHECK (
          (status = 'cancelled') = (cancelled_reason IS NOT NULL)
          AND (cancelled_reason IS NULL OR (btrim(cancelled_reason) <> '' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)))
      )`);
  }
  // La agenda se lee por semana; la ficha y el detalle, por proveedor (la última reunión primero).
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_supplier_meetings_inicio ON commercial.supplier_meetings (tenant_id, starts_at)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_supplier_meetings_proveedor
                    ON commercial.supplier_meetings (tenant_id, supplier_code, starts_at DESC)`);

  if (!(await knex.schema.withSchema('commercial').hasTable('supplier_meeting_participants'))) {
    await knex.raw(`
      CREATE TABLE commercial.supplier_meeting_participants (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        meeting_id   uuid NOT NULL,
        side         text NOT NULL,
        user_id      uuid,
        area         text,
        name         text,
        job_title    text,
        created_by   text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        removed_by   text,
        removed_at   timestamptz,
        CONSTRAINT fk_supplier_meeting_participants_meeting FOREIGN KEY (tenant_id, meeting_id)
          REFERENCES commercial.supplier_meetings (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT supplier_meeting_participants_side_chk CHECK (side IN ('internal', 'supplier')),
        CONSTRAINT supplier_meeting_participants_area_chk CHECK (area IS NULL OR area IN ('compras', 'marketing', 'finanzas', 'direccion')),
        -- Por Mega Dulces: usuario y área, sin nombre suelto. Por el proveedor: nombre, sin usuario ni área.
        CONSTRAINT supplier_meeting_participants_coherence_chk CHECK (COALESCE(
             (side = 'internal' AND user_id IS NOT NULL AND area IS NOT NULL AND name IS NULL AND job_title IS NULL)
          OR (side = 'supplier' AND user_id IS NULL AND area IS NULL AND btrim(COALESCE(name, '')) <> ''
                AND (job_title IS NULL OR btrim(job_title) <> '')),
          false)),
        CONSTRAINT supplier_meeting_participants_removed_chk CHECK ((removed_at IS NULL) = (removed_by IS NULL))
      )`);
  }
  // Un usuario va UNA vez a la misma reunión; quitado, puede volver a entrar.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_meeting_participants_usuario
      ON commercial.supplier_meeting_participants (tenant_id, meeting_id, user_id)
      WHERE side = 'internal' AND removed_at IS NULL`);
  // «Mis reuniones»: las de una persona.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_supplier_meeting_participants_usuario
      ON commercial.supplier_meeting_participants (tenant_id, user_id) WHERE removed_at IS NULL`);

  for (const t of TABLAS) {
    await knex.raw(`ALTER TABLE commercial.${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'commercial' AND tablename = '${t}' AND policyname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON commercial.${t}
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
          GRANT SELECT, INSERT, UPDATE ON commercial.${t} TO app_runtime;
          -- Los privilegios POR DEFECTO del esquema commercial le dan a app_runtime también DELETE (PQ.3.5):
          -- sin este REVOKE, «una reunión se cancela, no se borra» sería una intención.
          REVOKE DELETE, TRUNCATE ON commercial.${t} FROM app_runtime;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
          GRANT SELECT ON commercial.${t} TO dev_ro;
        END IF;
      END $$`);
  }
  await knex.raw(`COMMENT ON TABLE commercial.supplier_meetings IS
    '[PQ.3.8] Compras › Proveedores › Citas: una reunión con un proveedor (cita con ejecutivo, revisión de negocio o plan de trabajo; anexo C §9.1). Dato propio; clave de proveedor de Kepler. Realizada exige minuta; cancelada, motivo.'`);
  await knex.raw(`COMMENT ON TABLE commercial.supplier_meeting_participants IS
    '[PQ.3.8] Quién va a una reunión con el proveedor: por Mega Dulces, usuario y área; por el proveedor, nombre y puesto. Quitar = removed_at.'`);

  const { rows: [n] } = await knex.raw(`SELECT (SELECT count(*) FROM commercial.supplier_meetings)::int AS reuniones,
                                               (SELECT count(*) FROM commercial.supplier_meeting_participants)::int AS participantes`);
  // eslint-disable-next-line no-console
  console.log(`[PQ.3.8] commercial.supplier_meetings: ${n.reuniones} reunión(es) · supplier_meeting_participants: ${n.participantes}`);
};

/**
 * Deshace lo que hizo el `up` sin borrar decisiones humanas (regla 5): una tabla con filas (reuniones agendadas o
 * sus participantes) se conserva y se dice; sólo vacía se quita. Los participantes van primero (llave a la reunión).
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const tabla of ['supplier_meeting_participants', 'supplier_meetings']) {
    if (!(await knex.schema.withSchema('commercial').hasTable(tabla))) continue;
    const n = Number((await knex.raw(`SELECT count(*)::int AS n FROM commercial.${tabla}`)).rows[0].n);
    if (n > 0) {
      // eslint-disable-next-line no-console
      console.log(`[PQ.3.8] commercial.${tabla} tiene ${n} fila(s) hechas por personas: se conserva (regla 5).`);
      continue;
    }
    await knex.raw(`DROP TABLE commercial.${tabla}`);
  }
};
