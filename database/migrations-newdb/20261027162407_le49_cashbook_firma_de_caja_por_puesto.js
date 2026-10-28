'use strict';
/**
 * `[LE.4.9]` — En la caja firma un PUESTO, no un rol ni un nombre (D6, PM 2026-10-27): «primero el
 * de maria_gutierrez [Jefe de Tesorería], luego Dirección General».
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-27) ────────────────────────────────────────
 *  · Las rutas que firman (autorizar/rechazar una solicitud, cerrar la jornada, cerrar un hallazgo)
 *    piden `FINANCE_CAJA_AUTORIZAR`, y el guard deja pasar todo al god-mode de plataforma
 *    (ADR-054): firmaban cuentas que no son de Tesorería ni de Dirección (detalle en el inventario
 *    privado; el repo es público).
 *  · El puesto vive en `identity.users.position_code`; `maria_gutierrez` → `tesoreria` (Jefe de
 *    Tesorería); `direccion` (Dirección General) tiene 2 cuentas activas.
 *  · `identity.position_responsibilities` ya expresa «quién responde, y quién primero»
 *    (`es_principal`): no se inventa otra tabla (ADR-056).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · Responsabilidad nueva `finanzas.caja_firma`: `tesoreria` principal, `direccion` suplente.
 *    Las dos pueden firmar; «primero» decide a quién le llega la bandeja.
 *  · La regla vive EN LA BASE: un trigger antes de cada firma (solicitud decidida, jornada
 *    cerrada, hallazgo cerrado con nota) exige que quien firma tenga ese puesto, esté activo y sea
 *    una cuenta `interno`. Ni el god-mode de la API ni otro camino de escritura la saltan.
 *    Cuando el mismo cambio ya viola los cuatro ojos, el trigger no se adelanta: deja que lo
 *    rechace su candado con su nombre de siempre.
 *  · Cerrar un hallazgo CON UN ASIENTO no pide puesto: la firma está en el asiento, que ya pasó
 *    por una solicitud autorizada por el puesto.
 *  · Alerta (extiende LE.4.8 sin tocarla): entrar o salir de un puesto que firma, o cambiar qué
 *    puestos firman, abre un hallazgo `permiso` que revisa otra persona.
 *
 * La firma lee `identity` y el dueño del libro no tiene acceso a ese esquema (a propósito): la
 * lectura la hacen dos funciones angostas `SECURITY DEFINER` de quien aplica la migración, que sólo
 * responden «¿este puesto / este usuario firma caja?».
 *
 * ⛔ Ni un `?` en el SQL (knex lo convierte en parámetro). Idempotente.
 * Prueba: `database/tests/test-newdb-cashbook-firma-puesto.js`.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'finanzas.caja_firma';
/** [puesto, es_principal] — el orden lo dio el PM. */
const FIRMAN = [['tesoreria', true], ['direccion', false]];
const RESPONSABILIDAD = {
  key: CLAVE,
  label: 'Caja General: firmar',
  descripcion: 'Autorizar o rechazar lo que la caja pide con cuatro ojos (apertura, faltantes, ajustes, reversas), '
    + 'autorizar el cierre de la jornada y cerrar con una nota los hallazgos del libro de efectivo. '
    + 'Primero Tesorería; Dirección General como suplente.',
  orden: 42,
};

// Quién firma, por puesto. Corre con los derechos de quien aplicó la migración (lee `identity`).
const LECTURA = `
CREATE OR REPLACE FUNCTION cashbook._firma_del_puesto(p_t uuid, p_puesto text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE v text;
BEGIN
  SELECT CASE WHEN bool_or(pr.es_principal) THEN 'principal' ELSE 'suplente' END INTO v
    FROM identity.position_responsibilities pr
   WHERE pr.tenant_id = p_t AND pr.position_code = p_puesto AND pr.responsibility_key = '${CLAVE}'
     AND pr.deleted_at IS NULL
  HAVING count(*) > 0;
  RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook._firma_de_caja(p_t uuid, p_user uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE u record;
BEGIN
  SELECT position_code, activo, deleted_at, kind INTO u FROM identity.users WHERE tenant_id = p_t AND id = p_user;
  IF NOT FOUND OR u.deleted_at IS NOT NULL OR NOT coalesce(u.activo, false) OR coalesce(u.kind, 'interno') <> 'interno' THEN
    RETURN NULL;
  END IF;
  RETURN cashbook._firma_del_puesto(p_t, u.position_code);
END $fn$;
`;

const REGLA = `
-- Antes de cada firma. Corre como el dueño del libro (las tablas sólo se escriben por sus funciones).
CREATE OR REPLACE FUNCTION cashbook.firma_por_puesto()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_firma uuid; v_que text;
BEGIN
  IF TG_TABLE_NAME = 'requests' THEN
    IF OLD.state <> 'pendiente' OR NEW.state NOT IN ('autorizada', 'rechazada') THEN RETURN NEW; END IF;
    v_firma := NEW.decided_by; v_que := 'decidir una solicitud de caja';
  ELSIF TG_TABLE_NAME = 'business_days' THEN
    IF OLD.state = 'cerrada' OR NEW.state <> 'cerrada' THEN RETURN NEW; END IF;
    -- La misma persona: lo rechaza cashbook_cierre_cuatro_ojos, con su nombre.
    IF NEW.authorized_by IS NOT DISTINCT FROM NEW.closed_by THEN RETURN NEW; END IF;
    v_firma := NEW.authorized_by; v_que := 'autorizar el cierre de la jornada';
  ELSIF TG_TABLE_NAME = 'findings' THEN
    -- Con un asiento la firma ya está en el asiento (lo autorizó el puesto por su solicitud).
    IF OLD.state <> 'abierto' OR NEW.state <> 'cerrado' OR NEW.closing_entry_id IS NOT NULL THEN RETURN NEW; END IF;
    IF NEW.source = 'permiso' THEN
      IF NEW.closed_by IS NOT DISTINCT FROM NEW.created_by OR NEW.closed_by::text IS NOT DISTINCT FROM NEW.detail->>'usuario' THEN
        RETURN NEW;   -- lo rechaza cashbook_permiso_lo_revisa_otro
      END IF;
      v_firma := NEW.closed_by;
    ELSE
      IF NEW.closing_authorized_by IS NULL OR NEW.closing_authorized_by = NEW.closed_by THEN
        RETURN NEW;   -- lo rechaza cashbook_hallazgo_se_cierra_con_algo
      END IF;
      v_firma := NEW.closing_authorized_by;
    END IF;
    v_que := 'cerrar un hallazgo con una nota';
  ELSE
    RETURN NEW;
  END IF;
  IF v_firma IS NULL OR cashbook._firma_de_caja(NEW.tenant_id, v_firma) IS NULL THEN
    PERFORM cashbook._falla('cashbook_firma_por_puesto',
      'para ' || v_que || ' hay que tener un puesto que firma caja (Jefe de Tesorería o Dirección General) y estar activo');
  END IF;
  RETURN NEW;
END $fn$;
`;

const ALERTA = `
-- Entrar o salir de un puesto que firma, o cambiar qué puestos firman. Corre con los derechos de
-- quien hace el cambio, como la alerta de LE.4.8, y escribe por la misma función.
CREATE OR REPLACE FUNCTION cashbook.alerta_de_firma()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_fila jsonb := coalesce(v_new, v_old);
  v_t uuid := (v_fila->>'tenant_id')::uuid;
  v_antes jsonb := '{}'::jsonb;
  v_despues jsonb := '{}'::jsonb;
  v_det jsonb;
  v_col text := 'updated_by';
  v_actor text;
  v_ea boolean; v_ed boolean; v_fa text; v_fd text;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    v_ea := coalesce((v_old->>'activo')::boolean, false) AND v_old->>'deleted_at' IS NULL;
    v_ed := coalesce((v_new->>'activo')::boolean, false) AND v_new->>'deleted_at' IS NULL;
    v_fa := CASE WHEN v_ea THEN cashbook._firma_del_puesto(v_t, v_old->>'position_code') END;
    v_fd := CASE WHEN v_ed THEN cashbook._firma_del_puesto(v_t, v_new->>'position_code') END;
    IF v_fa IS NOT DISTINCT FROM v_fd
       AND (v_fa IS NULL OR (v_old->>'position_code') IS NOT DISTINCT FROM (v_new->>'position_code')) THEN
      RETURN NULL;
    END IF;
    -- Entrar o dejar de entrar con permisos de caja ya alerta LE.4.8: el mismo cambio, una alerta.
    IF v_ea <> v_ed AND cashbook._caja_de_usuario(v_t, (v_fila->>'id')::uuid) THEN RETURN NULL; END IF;
    v_antes := jsonb_build_object('firma_caja', v_fa, 'puesto', v_old->>'position_code');
    v_despues := jsonb_build_object('firma_caja', v_fd, 'puesto', v_new->>'position_code');
    v_det := jsonb_build_object('usuario', v_fila->>'id', 'username', v_fila->>'username');

  ELSIF TG_TABLE_NAME = 'position_responsibilities' THEN
    IF v_old IS NOT NULL AND v_old->>'responsibility_key' = '${CLAVE}' AND v_old->>'deleted_at' IS NULL THEN
      v_antes := jsonb_build_object('puesto', v_old->>'position_code',
                   'firma_caja', CASE WHEN (v_old->>'es_principal')::boolean THEN 'principal' ELSE 'suplente' END);
    END IF;
    IF v_new IS NOT NULL AND v_new->>'responsibility_key' = '${CLAVE}' AND v_new->>'deleted_at' IS NULL THEN
      v_despues := jsonb_build_object('puesto', v_new->>'position_code',
                   'firma_caja', CASE WHEN (v_new->>'es_principal')::boolean THEN 'principal' ELSE 'suplente' END);
    END IF;
    IF v_antes = v_despues THEN RETURN NULL; END IF;
    v_det := jsonb_build_object('puesto', coalesce(v_new->>'position_code', v_old->>'position_code'));
    IF TG_OP = 'INSERT' THEN v_col := 'created_by'; END IF;
  ELSE
    RETURN NULL;
  END IF;

  -- Quién: sólo si la fila lo dice EN ESTE cambio (mismo criterio que LE.4.8).
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND ((v_old->>v_col) IS DISTINCT FROM (v_new->>v_col)
                                                OR (v_old->>'updated_at') IS DISTINCT FROM (v_new->>'updated_at'))) THEN
    v_actor := v_new->>v_col;
  END IF;
  v_actor := coalesce(v_actor, nullif(current_setting('app.actor', true), ''));
  IF v_actor IS NOT NULL AND v_actor !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_det := v_det || jsonb_build_object('actor_declarado', v_actor);
    v_actor := NULL;
  END IF;

  PERFORM cashbook._alerta_de_permiso(v_t, v_actor::uuid, v_det || jsonb_build_object(
    'tabla', TG_TABLE_NAME, 'operacion', TG_OP, 'antes', v_antes, 'despues', v_despues,
    'actor', v_actor, 'rol_de_base', current_user, 'que', 'firma de caja por puesto'));
  RETURN NULL;
END $fn$;
`;

const DE_LECTURA = ['_firma_del_puesto(uuid, text)', '_firma_de_caja(uuid, uuid)'];
const DEL_LIBRO = ['firma_por_puesto()', 'alerta_de_firma()'];
const FIRMAS = ['requests', 'business_days', 'findings'];
const ALERTAS = {
  users: 'AFTER UPDATE OF activo, deleted_at, position_code',
  position_responsibilities: 'AFTER INSERT OR UPDATE OR DELETE',
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regprocedure('cashbook._alerta_de_permiso(uuid, uuid, jsonb)') IS NOT NULL AS hay`);
  if (!h.hay) throw new Error('[LE.4.9] falta LE.4.8 (20261027132017): se aplica después.');

  // 1. Las dos lecturas de `identity`, de quien aplica la migración.
  await knex.raw(LECTURA);
  for (const f of DE_LECTURA) {
    await knex.raw(`REVOKE ALL ON FUNCTION cashbook.${f} FROM PUBLIC`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO cashbook_owner, app_runtime`);
  }

  // 2. La regla y la alerta, del dueño del libro.
  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(`SET LOCAL check_function_bodies = off`);
  await knex.raw(REGLA);
  await knex.raw(ALERTA);
  for (const t of FIRMAS) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_firma_por_puesto ON cashbook.${t}`);
    await knex.raw(`CREATE TRIGGER trg_cashbook_firma_por_puesto BEFORE UPDATE ON cashbook.${t}
      FOR EACH ROW EXECUTE FUNCTION cashbook.firma_por_puesto()`);
  }
  await knex.raw(`RESET ROLE`);
  for (const f of DEL_LIBRO) {
    await knex.raw(`REVOKE ALL ON FUNCTION cashbook.${f} FROM PUBLIC`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO app_runtime`);
  }
  for (const [t, cuando] of Object.entries(ALERTAS)) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_alerta_firma ON identity.${t}`);
    await knex.raw(`CREATE TRIGGER trg_cashbook_alerta_firma ${cuando} ON identity.${t}
      FOR EACH ROW EXECUTE FUNCTION cashbook.alerta_de_firma()`);
  }

  // 3. La responsabilidad y quién la tiene. Con la alerta ya puesta: darle la firma a un puesto
  //    también la deja registrada para que otra persona la vea.
  await knex.raw(`INSERT INTO identity.responsibilities (key, label, descripcion, orden, created_at)
    SELECT v.key, v.label, v.descripcion, v.orden, now()
      FROM (VALUES (?::varchar, ?::varchar, ?::text, ?::int)) v (key, label, descripcion, orden)
     WHERE NOT EXISTS (SELECT 1 FROM identity.responsibilities r WHERE r.key = v.key)`,
  [RESPONSABILIDAD.key, RESPONSABILIDAD.label, RESPONSABILIDAD.descripcion, RESPONSABILIDAD.orden]);
  for (const [puesto, principal] of FIRMAN) {
    const r = await knex.raw(`INSERT INTO identity.position_responsibilities (tenant_id, position_code, responsibility_key, es_principal)
      SELECT p.tenant_id, p.code, ?, ? FROM identity.positions p
       WHERE p.code = ? AND p.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM identity.position_responsibilities x
                          WHERE x.tenant_id = p.tenant_id AND x.position_code = p.code
                            AND x.responsibility_key = ? AND x.deleted_at IS NULL)`, [CLAVE, principal, puesto, CLAVE]);
    console.log(`  [LE.4.9] ${puesto} (${principal ? 'principal' : 'suplente'}): ${r.rowCount} empresa(s)`);
  }
  const { rows: gente } = await knex.raw(`SELECT u.position_code, count(*)::int AS n FROM identity.users u
    JOIN identity.position_responsibilities pr ON pr.tenant_id = u.tenant_id AND pr.position_code = u.position_code
     AND pr.responsibility_key = ? AND pr.deleted_at IS NULL
   WHERE u.deleted_at IS NULL AND u.activo GROUP BY 1 ORDER BY 1`, [CLAVE]);
  // En prod debe decir «direccion 2 · tesoreria 1» (medido antes). «nadie» en prod = la firma quedó
  // sin dueño y TODA firma de caja va a ser rechazada: se revisa antes de soltar.
  console.log(`  [LE.4.9] pueden firmar caja: ${gente.map((g) => `${g.position_code} ${g.n}`).join(' · ') || 'nadie'}`);
};

/** Quita la regla y la alerta. La responsabilidad se da de baja lógica: una fila de identity no se borra. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const t of Object.keys(ALERTAS)) await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_alerta_firma ON identity.${t}`);
  for (const t of FIRMAS) await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_firma_por_puesto ON cashbook.${t}`);
  await knex.raw(`UPDATE identity.position_responsibilities SET deleted_at = now(), updated_at = now()
    WHERE responsibility_key = ? AND deleted_at IS NULL`, [CLAVE]);
  for (const f of [...DEL_LIBRO, ...DE_LECTURA]) await knex.raw(`DROP FUNCTION IF EXISTS cashbook.${f}`);
};
