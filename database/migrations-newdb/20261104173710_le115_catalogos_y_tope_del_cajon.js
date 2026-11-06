'use strict';
/**
 * `[LE.1.15]` `[LE.2.10]` — **Los catálogos firmados de la Ventanilla y la regla del tope** (V1, V2, D20).
 *
 *  · `cashbook.drawer_limits`: el tope del cajón. D20 decidió $50,000; aquí NO se siembra: lo fija
 *    quien firma caja por su puesto (LE.4.9), y cada cambio es una fila nueva con quién y cuándo.
 *  · `cashbook.machine_users`: el usuario de la máquina → la persona (B43). Sin esto, Suspenso dice
 *    «vendedor7» y no a nombre de quién está. También una fila por cambio, firmada por puesto.
 *  · `cashbook.drawer_excess_finding(date, uuid)`: al cerrar, si el último conteo de cierre del cajón
 *    pasa del tope, abre UN hallazgo «excedente en ventanilla» a nombre de quien cerró (LE.2.10). La
 *    API la llama antes de `close_day`: no se reescribe el cierre, que ya está probado. Sin tope fijado
 *    devuelve NULL y la API lo declara (lo no medido no se da por bueno).
 *
 * Las tablas son de sólo inserción (B23: un cambio de catálogo no borra el anterior). Esquema propio,
 * dueño aparte, RLS forzada y `app_runtime` sólo SELECT/EXECUTE (D10), como el resto del libro.
 *
 * Tablas y funciones nuevas: la API desplegada no las usa (expand). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLAS = `
CREATE TABLE IF NOT EXISTS cashbook.drawer_limits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  set_by        uuid NOT NULL,
  set_by_puesto text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by    uuid
);
CREATE INDEX IF NOT EXISTS ix_cashbook_tope_vigente ON cashbook.drawer_limits (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cashbook.machine_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  device        text NOT NULL CHECK (length(btrim(device)) > 0),
  user_external text NOT NULL CHECK (length(btrim(user_external)) > 0),
  user_id       uuid,
  nombre        text,
  set_by        uuid NOT NULL,
  set_by_puesto text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by    uuid,
  -- Sin persona = se quita la asignación (queda en la historia quién la quitó).
  CONSTRAINT cashbook_usuario_maquina_con_nombre CHECK ((user_id IS NULL) = (nombre IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_cashbook_usuario_maquina ON cashbook.machine_users (tenant_id, device, user_external, created_at DESC);
`;

const FUNCIONES = `
-- El tope vigente: la última fila.
CREATE OR REPLACE FUNCTION cashbook.set_drawer_limit(p_amount bigint, p_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); v_puesto text; v_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN PERFORM cashbook._falla('cashbook_tope_invalido', 'el tope es un importe positivo'); END IF;
  v_puesto := cashbook._firma_de_caja(v_t, p_user);
  IF v_puesto IS NULL THEN PERFORM cashbook._falla('cashbook_catalogo_requiere_firma', 'el tope del cajón lo fija quien firma caja por su puesto (D20, LE.4.9)'); END IF;
  INSERT INTO cashbook.drawer_limits (tenant_id, amount_minor, set_by, set_by_puesto, created_by, updated_by)
  VALUES (v_t, p_amount, p_user, v_puesto, p_user, p_user) RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.set_machine_user(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); v_by uuid := nullif(p->>'set_by', '')::uuid; v_puesto text; v_id uuid;
BEGIN
  v_puesto := cashbook._firma_de_caja(v_t, v_by);
  IF v_puesto IS NULL THEN PERFORM cashbook._falla('cashbook_catalogo_requiere_firma', 'quién es cada usuario de la máquina lo dice quien firma caja por su puesto (B43, LE.4.9)'); END IF;
  INSERT INTO cashbook.machine_users (tenant_id, device, user_external, user_id, nombre, set_by, set_by_puesto, created_by, updated_by)
  VALUES (v_t, p->>'device', p->>'user_external', nullif(p->>'user_id', '')::uuid, nullif(btrim(p->>'nombre'), ''), v_by, v_puesto, v_by, v_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

-- V1 / LE.2.10: el excedente sobre el tope, UNA vez por día. NULL = sin tope fijado o sin conteo de cierre.
CREATE OR REPLACE FUNCTION cashbook.drawer_excess_finding(p_date date, p_owner uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); v_tope bigint; v_acc uuid; v_conteo record; v_id uuid;
BEGIN
  SELECT amount_minor INTO v_tope FROM cashbook.drawer_limits WHERE tenant_id = v_t ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT id INTO v_acc FROM cashbook.accounts WHERE tenant_id = v_t AND code = 'CAJA_MXN';
  SELECT c.id, c.total_minor INTO v_conteo FROM cashbook.counts c
    JOIN cashbook.business_days d ON d.tenant_id = c.tenant_id AND d.business_date = p_date
   WHERE c.tenant_id = v_t AND c.account_id = v_acc AND c.kind = 'cierre' AND c.recorded_at >= d.opened_at
   ORDER BY c.recorded_at DESC LIMIT 1;
  IF NOT FOUND OR v_conteo.total_minor <= v_tope THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM cashbook.findings
   WHERE tenant_id = v_t AND source = 'cierre' AND business_date = p_date AND detail->>'regla' = 'tope_del_cajon';
  IF FOUND THEN RETURN v_id; END IF;
  INSERT INTO cashbook.findings (tenant_id, source, account_id, count_id, business_date, amount_minor, detail, owner_user, created_by)
  VALUES (v_t, 'cierre', v_acc, v_conteo.id, p_date, v_conteo.total_minor - v_tope,
          jsonb_build_object('regla', 'tope_del_cajon', 'motivo', 'excedente en ventanilla sobre el tope (V1): se deposita en la máquina',
                             'tope_minor', v_tope::text, 'contado_minor', v_conteo.total_minor::text),
          p_owner, p_owner)
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;
`;

const NUEVAS = ['drawer_limits', 'machine_users'];
const PUBLICAS = ['set_drawer_limit(bigint, uuid)', 'set_machine_user(jsonb)', 'drawer_excess_finding(date, uuid)'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regprocedure('cashbook._firma_de_caja(uuid, uuid)') IS NOT NULL AS firma,
    to_regprocedure('cashbook.register_count(jsonb)') IS NOT NULL AS conteos`);
  if (!h.firma || !h.conteos) throw new Error('[LE.1.15] faltan LE.1.9 (20261027120749) y LE.4.9 (20261027162407): se aplica después.');

  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(TABLAS);
  for (const t of NUEVAS) {
    await knex.raw(`ALTER TABLE cashbook.${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE cashbook.${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON cashbook.${t}`);
    await knex.raw(`CREATE POLICY tenant_isolation ON cashbook.${t}
      USING (tenant_id = cashbook.current_tenant()) WITH CHECK (tenant_id = cashbook.current_tenant())`);
    await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_sin_truncate ON cashbook.${t}`);
    await knex.raw(`CREATE TRIGGER trg_cashbook_sin_truncate BEFORE TRUNCATE ON cashbook.${t} FOR EACH STATEMENT EXECUTE FUNCTION cashbook.sin_truncate()`);
    // Sólo inserción (B23): un cambio de catálogo es una fila nueva; la anterior queda.
    await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_catalogo_inmutable ON cashbook.${t}`);
    await knex.raw(`CREATE TRIGGER trg_cashbook_catalogo_inmutable BEFORE UPDATE OR DELETE ON cashbook.${t} FOR EACH ROW EXECUTE FUNCTION cashbook.inmutable()`);
  }
  await knex.raw(FUNCIONES);
  await knex.raw(`RESET ROLE`);

  for (const t of NUEVAS) {
    await knex.raw(`REVOKE ALL ON cashbook.${t} FROM PUBLIC`);
    await knex.raw(`REVOKE ALL ON cashbook.${t} FROM app_runtime`);
    await knex.raw(`GRANT SELECT ON cashbook.${t} TO app_runtime`);
  }
  for (const f of PUBLICAS) {
    await knex.raw(`REVOKE ALL ON FUNCTION cashbook.${f} FROM PUBLIC`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO app_runtime`);
  }
  const { rows: [ro] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') AS hay`);
  if (ro.hay) for (const t of NUEVAS) await knex.raw(`GRANT SELECT ON cashbook.${t} TO dev_ro`);
};

/** Sólo vacías: un catálogo firmado no se borra (B23). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [c] } = await knex.raw(`SELECT (SELECT count(*) FROM cashbook.drawer_limits) + (SELECT count(*) FROM cashbook.machine_users) AS n`);
  if (Number(c.n) > 0) throw new Error(`[LE.1.15] hay ${c.n} filas de catálogo firmadas: no se bajan, se congelan (B23).`);
  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  for (const f of PUBLICAS) await knex.raw(`DROP FUNCTION IF EXISTS cashbook.${f}`);
  for (const t of NUEVAS) await knex.raw(`DROP TABLE IF EXISTS cashbook.${t}`);
  await knex.raw(`RESET ROLE`);
};
