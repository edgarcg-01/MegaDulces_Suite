'use strict';
/**
 * `[RH.15.5]` + `[RH.15.11]` — La FIRMA DE LA SEMANA: en papel (la hoja del departamento, escaneada) y desde el
 * CELULAR (QR personal). Las dos se ligan a la semana CERRADA que se firmó. (Fusiona las que eran dos migraciones,
 * 2026-11-23: ninguna se había aplicado en prod y son el mismo acuerdo por dos caminos.)
 *
 * LFT art. 132 fr. XXXIV (DOF 1-may-2026): el registro electrónico de la jornada hace PRUEBA PLENA «si se acredita que
 * fue acordado entre la persona trabajadora y el patrón». El jefe de área firma como representante del patrón (art. 11).
 *
 * ── Lo medido antes (código de main) ─────────────────────────────────────────────────────────────
 *  · El «PDF para firmar» se generaba en el navegador y se descargaba (`doc.save`): no quedaba guardado si se firmó,
 *    quién, ni cuándo. Ninguna tabla de acuse o conformidad. → 0 semanas con acuerdo acreditable.
 *  · Decisión de RH (2026-11-17): se firma UNA HOJA POR DEPARTAMENTO, con las personas y el jefe de área; y desde el
 *    celular la autorización ES la firma (sin número de reloj ni confirmación del jefe). David (2026-11-23): la firma
 *    por QR sí cuenta. ⚠️ Riesgo declarado (falta que Jurídico lo valide): la liga es la única llave (quien la tenga ve
 *    la semana y puede firmar). Se mitiga con un solo uso, 72 h, entrega en mano, IP + navegador + hora, y «anular con
 *    motivo» para RH. La hoja en papel queda como respaldo.
 *
 * Qué hace (tres tablas, separadas a propósito: la hoja es una por departamento con varias personas; la firma del
 * celular es una por persona):
 *  · `hr.attendance_signoffs` — una fila por hoja firmada. Guarda la huella (sha256) de la versión cerrada: si la
 *    semana se reabre y cambia, la firma queda «de otra versión» y hay que volver a firmar.
 *  · `hr.attendance_sign_links` — la liga del QR. Se guarda SÓLO el sha256 del token (si alguien lee la tabla, no puede
 *    firmar). Un solo uso, vence a las 72 h, se revoca al generar otra.
 *  · `hr.attendance_digital_signatures` — la firma de la persona: el PNG del trazo, la versión de la semana, hora, IP y
 *    navegador. Cuenta como firmada en cuanto se guarda.
 *  Ninguna se borra (son evidencia): se ANULAN con motivo.
 *
 * ⚠️ Deuda con nombre: la persona se identifica por plaza + número de reloj (`person_code[s]`), no por su usuario de la
 * Suite (ADR-084 D1). Decidirlo antes de aplicar en prod.
 *
 * Idempotente. Sin DELETE para la app. Sin permisos nuevos: usa los de cerrar la semana.
 *
 * @param { import("knex").Knex } knex
 */

const rls = async (knex, tabla) => {
  await knex.raw(`ALTER TABLE hr.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE hr.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'hr' AND tablename = '${tabla}' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON hr.${tabla}
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // Sin DELETE: una firma se anula, no se borra.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON hr.${tabla} TO app_runtime`);
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hr = () => knex.schema.withSchema('hr');

  // ── 1) La hoja en papel ([RH.15.5]) ─────────────────────────────────────────────────────────
  if (!(await hr().hasTable('attendance_signoffs'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_signoffs (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        closure_id       uuid NOT NULL,
        site_code        text NOT NULL,
        period_start     date NOT NULL,                       -- jueves de la semana firmada
        department       text NOT NULL,                       -- el departamento de la hoja, como sale en el reporte
        person_codes     text[] NOT NULL,                     -- quiénes firmaron en esa hoja
        jefe_nombre      text NOT NULL,                       -- quién firmó como jefe de área
        snapshot_sha256  text NOT NULL,                       -- la versión de la semana que se firmó
        file_key         text NOT NULL,                       -- la hoja escaneada (bucket privado)
        file_name        text,
        file_type        text,
        file_bytes       integer,
        notes            text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        created_by       uuid,
        created_by_name  text,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       uuid,
        voided_at        timestamptz,
        voided_by        uuid,
        voided_by_name   text,
        void_reason      text,
        FOREIGN KEY (tenant_id, closure_id) REFERENCES hr.attendance_closures (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT attendance_signoffs_personas_ck CHECK (cardinality(person_codes) >= 1),
        CONSTRAINT attendance_signoffs_jefe_ck CHECK (length(btrim(jefe_nombre)) >= 3),
        CONSTRAINT attendance_signoffs_void_ck CHECK (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 5)
      )`);
    await knex.raw(`CREATE INDEX ix_hr_signoffs_semana ON hr.attendance_signoffs (tenant_id, site_code, period_start)`);
    await knex.raw(`CREATE INDEX ix_hr_signoffs_cierre ON hr.attendance_signoffs (tenant_id, closure_id)`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_signoffs IS
      '[RH.15.5] Hoja de la semana firmada por un departamento y su jefe de área (LFT 132-XXXIV: acuerdo). Se anula con motivo; no se borra.'`);
  }
  await rls(knex, 'attendance_signoffs');

  // ── 2) La liga del QR ([RH.15.11]) ──────────────────────────────────────────────────────────
  if (!(await hr().hasTable('attendance_sign_links'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_sign_links (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        closure_id       uuid NOT NULL,
        site_code        text NOT NULL,
        period_start     date NOT NULL,
        department       text NOT NULL,
        person_code      text NOT NULL,
        token_sha256     text NOT NULL UNIQUE,              -- el token NO se guarda: sólo su huella
        snapshot_sha256  text NOT NULL,                     -- la versión de la semana a la que apunta
        expires_at       timestamptz NOT NULL,
        used_at          timestamptz,
        revoked_at       timestamptz,
        revoke_reason    text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        created_by       uuid,
        created_by_name  text,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       uuid,
        FOREIGN KEY (tenant_id, closure_id) REFERENCES hr.attendance_closures (tenant_id, id) ON DELETE RESTRICT
      )`);
    // Una sola liga viva por persona y cierre: generar otra revoca la anterior (en la misma transacción).
    await knex.raw(`CREATE UNIQUE INDEX ux_hr_sign_links_viva ON hr.attendance_sign_links (tenant_id, closure_id, person_code)
      WHERE used_at IS NULL AND revoked_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_hr_sign_links_semana ON hr.attendance_sign_links (tenant_id, site_code, period_start)`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_sign_links IS
      '[RH.15.11] Liga personal (QR) para firmar la semana desde el celular. Sólo el sha256 del token; un uso; 72 h.'`);
  }
  await rls(knex, 'attendance_sign_links');

  // ── 3) La firma desde el celular ([RH.15.11]) ───────────────────────────────────────────────
  if (!(await hr().hasTable('attendance_digital_signatures'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_digital_signatures (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        link_id          uuid NOT NULL UNIQUE REFERENCES hr.attendance_sign_links (id) ON DELETE RESTRICT,
        closure_id       uuid NOT NULL,
        site_code        text NOT NULL,
        period_start     date NOT NULL,
        department       text NOT NULL,
        person_code      text NOT NULL,
        snapshot_sha256  text NOT NULL,                     -- lo que vio y firmó
        file_key         text NOT NULL,                     -- el trazo (PNG) en el bucket privado
        file_bytes       integer,
        signed_at        timestamptz NOT NULL DEFAULT now(),
        ip               text,
        user_agent       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        voided_at        timestamptz,                       -- RH la anuló (p. ej. firmó alguien más); no se borra
        voided_by        uuid,
        voided_by_name   text,
        void_reason      text,
        FOREIGN KEY (tenant_id, closure_id) REFERENCES hr.attendance_closures (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT attendance_digital_sig_void_ck CHECK (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 5)
      )`);
    // Una firma VIGENTE por persona y versión cerrada de su semana; anulada, puede volver a firmar con otra liga.
    await knex.raw(`CREATE UNIQUE INDEX ux_hr_digital_sig_persona ON hr.attendance_digital_signatures (tenant_id, closure_id, person_code)
      WHERE voided_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_hr_digital_sig_persona ON hr.attendance_digital_signatures (tenant_id, site_code, person_code)`);
    await knex.raw(`CREATE INDEX ix_hr_digital_sig_semana ON hr.attendance_digital_signatures (tenant_id, site_code, period_start)`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_digital_signatures IS
      '[RH.15.11] Firma de la semana hecha por la persona en su celular. Cuenta al guardarse; se anula con motivo, no se borra.'`);
  }
  await rls(knex, 'attendance_digital_signatures');
};

/** Deshace EXACTAMENTE lo que hizo el `up`. Se niega si ya hay firmas (en papel o digitales): son evidencia. */
exports.down = async function down(knex) {
  const hr = () => knex.schema.withSchema('hr');
  for (const t of ['attendance_digital_signatures', 'attendance_signoffs']) {
    if (!(await hr().hasTable(t))) continue;
    const n = Number((await knex.raw(`SELECT count(*)::int n FROM hr.${t}`)).rows[0].n);
    if (n > 0) throw new Error(`[RH.15.5/RH.15.11] down: hr.${t} tiene ${n} firma(s); son evidencia y no se borran con un down.`);
  }
  await knex.raw(`DROP TABLE IF EXISTS hr.attendance_digital_signatures`);
  await knex.raw(`DROP TABLE IF EXISTS hr.attendance_sign_links`);
  await knex.raw(`DROP TABLE IF EXISTS hr.attendance_signoffs`);
};
