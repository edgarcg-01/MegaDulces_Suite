'use strict';
/**
 * `[RH.1.4b]` Fase RH (ADR-084) — **la ficha de cada persona en cada plaza**: su sección del reporte de
 * RH, su casilla de promotora y si está activa EN ESA plaza. Es lo que Mega Talento guarda en
 * `empleados` por (sucursal, código) y la Suite no tenía dónde poner.
 *
 * ── Por qué, medido en Mega Talento (sólo lectura, 12-oct) ──────────────────────────────────
 *  · El «departamento» de Mega Talento NO es un departamento de la organización: es la SECCIÓN del
 *    reporte semanal de RH (sale de los PDF de nómina de ContPAQi, `tools/parsear-reportes.py`) y
 *    mezcla área con plaza a propósito: «SUC.PADRE HIDALGO», «STAFF LA PIEDAD» (en Morelia, Yurécuaro
 *    y Canindo), «PH» (en 8 Esquinas), «PADRE HIDALGO STAFF» (en corporativo). El reporte calcado de la
 *    Suite (`[RH.1.7c]`) agrupa por ese texto: traducirlo a los 21 departamentos de la Suite —lo que
 *    hacía `[RH.1.4]`— juntaba «SUC.PADRE HIDALGO», «STAFF» y «PISO DE VENTA» en «Tienda» y el
 *    reporte dejaba de ser el de RH. La paridad no lo veía porque no comparaba el departamento.
 *  · 21 nombres completos aparecen en dos o tres plazas: es la MISMA persona (staff que rota), con
 *    fichas activas y checadas de esta semana en las dos. En la Suite es UNA persona; lo que cambia
 *    por plaza —la sección, si sigue activa ahí— va aquí. Quien se mudó tiene la ficha vieja de baja y
 *    la nueva activa: sin `is_active` por ficha, volvería a salir con faltas en la plaza que dejó.
 *  · La casilla `es_promotora` existe aparte del texto (RH la concilia al guardar): se conserva.
 *
 * Llave = (sitio, código de la persona en ese sitio), la misma de `hr.person_schedules`.
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('hr').hasTable('person_site_profiles'))) {
    await knex.raw(`
      CREATE TABLE hr.person_site_profiles (
        tenant_id       uuid NOT NULL REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        site_code       text NOT NULL,
        person_code     text NOT NULL,
        report_section  text,                              -- la sección del reporte de RH, tal cual (MAYÚSCULAS)
        is_promoter     boolean NOT NULL DEFAULT false,    -- la casilla de Mega Talento (\`es_promotora\`)
        is_active       boolean NOT NULL DEFAULT true,     -- activa EN ESTA plaza (baja en una no es baja de la persona)
        source          text NOT NULL DEFAULT 'mega_talento',
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        updated_by      uuid,
        PRIMARY KEY (tenant_id, site_code, person_code),
        CONSTRAINT person_site_profiles_section_ck CHECK (report_section IS NULL OR report_section = upper(btrim(report_section)))
      )`);
  }
  await knex.raw(`ALTER TABLE hr.person_site_profiles ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE hr.person_site_profiles FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='hr' AND tablename='person_site_profiles' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON hr.person_site_profiles
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON hr.person_site_profiles TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE hr.person_site_profiles IS
    '[RH.1.4b] La ficha de una persona en una plaza (Mega Talento: empleados por sucursal y código): sección del reporte de RH, casilla de promotora y si está activa en esa plaza. La persona es identity.users; esto es lo que cambia por plaza.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM hr.person_site_profiles`).catch(() => ({ rows: [{ n: 0 }] }));
  if (rows[0].n) throw new Error(`[RH.1.4b] hr.person_site_profiles tiene ${rows[0].n} ficha(s): no se tira con datos de RH.`);
  await knex.raw(`DROP TABLE IF EXISTS hr.person_site_profiles`);
};
