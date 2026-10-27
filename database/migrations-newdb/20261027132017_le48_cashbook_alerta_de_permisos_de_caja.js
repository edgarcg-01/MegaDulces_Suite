'use strict';
/**
 * `[LE.4.8]` — Cada cambio a quién puede tocar la caja abre un HALLAZGO del libro (regla B21).
 *
 * Un banco no se entera de que alguien se dio permiso de autorizar leyendo una bitácora: le llega
 * una alerta que alguien más tiene que ver y cerrar. Aquí la alerta es un hallazgo de origen
 * `permiso` en la MISMA bandeja de hallazgos del libro (`cashbook.findings`), no una bandeja nueva
 * (ADR-056: ocho fases ya inventaron la suya).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-27) ────────────────────────────────────────
 *  · Cuatro caminos dan acceso a la caja: la clave en el rol (`role_permissions`), un complemento o
 *    perfil base (`user_roles`), un permiso personal (`user_permissions`) y el god-mode por rol
 *    (`superadmin`/`admin`, ADR-054; `is_platform_admin` en 1 rol). Un usuario inactivo no entra.
 *  · Sólo `app_runtime` y `postgres` pueden escribir esas cuatro tablas; las cuatro tienen RLS
 *    forzada por `current_tenant_id()`.
 *  · `users.role_name` NO es un camino aparte: `trg_sync_primary_role` lo copia a `user_roles`, y
 *    alertar en los dos lados contaría el mismo cambio dos veces.
 *  · Las pantallas que escriben esas tablas no siempre dicen quién fue: `user_roles` lleva
 *    `updated_by`, `user_permissions` lleva `granted_by`, y el catálogo de roles no lleva ninguno.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · Un trigger por tabla compara el acceso a caja ANTES y DESPUÉS de la fila (sólo las claves
 *    `FINANCE_CAJA_*`/`FINANCE_CAOS_*` en `true`, más el god-mode). Si no cambió, no hace nada:
 *    guardar el mismo permiso otra vez o tocar otra clave no alerta.
 *  · Si cambió, abre el hallazgo con el antes, el después, el rol o la persona, y quién lo hizo
 *    (si la fila lo dice en ESTE cambio; si no, `actor: null`: no se adivina).
 *  · ⛔ Si el hallazgo no se puede escribir, el cambio de permiso tampoco entra: ningún permiso de
 *    caja cambia sin dejar su alerta.
 *  · El hallazgo se cierra con una nota de una persona DISTINTA de quien hizo el cambio y de
 *    quien lo recibió (`cashbook_permiso_lo_revisa_otro`).
 *  · La escritura del hallazgo la hace `_alerta_de_permiso` (dueño del libro), que sólo acepta
 *    llamadas desde un trigger: la app no puede fabricar ni callar una alerta.
 *
 * ⛔ Ni un `?` en el SQL (knex lo convierte en parámetro: así se rompió `[CGA-A.55]`).
 * Idempotente. Prueba: `database/tests/test-newdb-cashbook-alerta-permisos.js`.
 *
 * @param { import("knex").Knex } knex
 */

const CAJA = `'^FINANCE_(CAJA|CAOS)_'`;

const FUNCIONES = `
-- El acceso a caja que da un mapa de permisos: sólo las claves de caja en true, más el god-mode.
CREATE OR REPLACE FUNCTION cashbook._claves_de_caja(p_perm jsonb, p_rol text, p_admin boolean, p_borrado boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN p_rol IS NULL OR coalesce(p_borrado, false) THEN '{}'::jsonb ELSE
    coalesce((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
                CASE WHEN jsonb_typeof(p_perm) = 'object' THEN p_perm ELSE '{}'::jsonb END) e
               WHERE e.key ~ ${CAJA} AND e.value = 'true'::jsonb), '{}'::jsonb)
    || CASE WHEN coalesce(p_admin, false) OR lower(p_rol) IN ('superadmin', 'admin')
            THEN '{"_todo_por_rol": true}'::jsonb ELSE '{}'::jsonb END
  END
$fn$;

-- Lo que da un rol hoy. Corre con los derechos de quien cambia el permiso (la RLS de identity aplica).
CREATE OR REPLACE FUNCTION cashbook._caja_del_rol(p_t uuid, p_rol text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT coalesce(
    (SELECT cashbook._claves_de_caja(rp.permissions, rp.role_name, rp.is_platform_admin, rp.deleted_at IS NOT NULL)
       FROM identity.role_permissions rp
      WHERE rp.tenant_id = p_t AND lower(rp.role_name) = lower(p_rol) LIMIT 1),
    cashbook._claves_de_caja('{}'::jsonb, p_rol, false, false))
$fn$;

CREATE OR REPLACE FUNCTION cashbook._caja_de_usuario(p_t uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM identity.user_roles ur
                  WHERE ur.tenant_id = p_t AND ur.user_id = p_user AND cashbook._caja_del_rol(p_t, ur.role_name) <> '{}'::jsonb)
      OR EXISTS (SELECT 1 FROM identity.users u
                  WHERE u.tenant_id = p_t AND u.id = p_user AND cashbook._caja_del_rol(p_t, u.role_name) <> '{}'::jsonb)
      OR EXISTS (SELECT 1 FROM identity.user_permissions up
                  WHERE up.tenant_id = p_t AND up.user_id = p_user AND up.allow AND up.permission_key ~ ${CAJA})
$fn$;

-- La única escritura: dueño del libro, y sólo desde un trigger. Fija el tenant de la FILA (una
-- migración corre sin app.tenant_id) y deja el de la sesión como estaba.
CREATE OR REPLACE FUNCTION cashbook._alerta_de_permiso(p_t uuid, p_actor uuid, p_det jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_prev text := current_setting('app.tenant_id', true);
BEGIN
  IF pg_trigger_depth() < 1 THEN
    PERFORM cashbook._falla('cashbook_alerta_solo_por_trigger', 'la alerta de permisos la abre el cambio, no una llamada');
  END IF;
  IF p_t IS NULL THEN PERFORM cashbook._falla('cashbook_sin_tenant', 'el cambio de permisos no dice de qué empresa es'); END IF;
  PERFORM set_config('app.tenant_id', p_t::text, true);
  INSERT INTO cashbook.findings (tenant_id, source, business_date, amount_minor, detail, created_by)
  VALUES (p_t, 'permiso', (clock_timestamp() AT TIME ZONE 'America/Mexico_City')::date, 0, p_det, p_actor);
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.alerta_de_permiso()
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
BEGIN
  IF TG_TABLE_NAME = 'role_permissions' THEN
    IF v_old IS NOT NULL THEN
      v_antes := cashbook._claves_de_caja(v_old->'permissions', v_old->>'role_name', (v_old->>'is_platform_admin')::boolean, v_old->>'deleted_at' IS NOT NULL);
    END IF;
    IF v_new IS NOT NULL THEN
      v_despues := cashbook._claves_de_caja(v_new->'permissions', v_new->>'role_name', (v_new->>'is_platform_admin')::boolean, v_new->>'deleted_at' IS NOT NULL);
    END IF;
    IF v_antes = v_despues AND (v_antes = '{}'::jsonb OR (v_old->>'role_name') IS NOT DISTINCT FROM (v_new->>'role_name')) THEN RETURN NULL; END IF;
    v_det := jsonb_build_object('rol', v_fila->>'role_name', 'rol_antes', v_old->>'role_name');

  ELSIF TG_TABLE_NAME = 'user_permissions' THEN
    IF v_old IS NOT NULL AND (v_old->>'permission_key') ~ ${CAJA} THEN
      v_antes := jsonb_build_object(v_old->>'permission_key', v_old->'allow');
    END IF;
    IF v_new IS NOT NULL AND (v_new->>'permission_key') ~ ${CAJA} THEN
      v_despues := jsonb_build_object(v_new->>'permission_key', v_new->'allow');
    END IF;
    IF v_antes = v_despues AND (v_antes = '{}'::jsonb OR (v_old->>'user_id') IS NOT DISTINCT FROM (v_new->>'user_id')) THEN RETURN NULL; END IF;
    v_det := jsonb_build_object('usuario', v_fila->>'user_id');
    v_col := 'granted_by';

  ELSIF TG_TABLE_NAME = 'user_roles' THEN
    -- Marcar o desmarcar el perfil base no cambia lo que la persona puede hacer.
    IF TG_OP = 'UPDATE' AND (v_old->>'role_name') IS NOT DISTINCT FROM (v_new->>'role_name')
       AND (v_old->>'user_id') IS NOT DISTINCT FROM (v_new->>'user_id') THEN RETURN NULL; END IF;
    IF v_old IS NOT NULL THEN v_antes := cashbook._caja_del_rol(v_t, v_old->>'role_name'); END IF;
    IF v_new IS NOT NULL THEN v_despues := cashbook._caja_del_rol(v_t, v_new->>'role_name'); END IF;
    IF v_antes = '{}'::jsonb AND v_despues = '{}'::jsonb THEN RETURN NULL; END IF;
    v_det := jsonb_build_object('usuario', v_fila->>'user_id', 'rol_antes', v_old->>'role_name', 'rol', v_new->>'role_name');

  ELSIF TG_TABLE_NAME = 'users' THEN
    v_antes := jsonb_build_object('puede_entrar', coalesce((v_old->>'activo')::boolean, false) AND v_old->>'deleted_at' IS NULL);
    v_despues := jsonb_build_object('puede_entrar', coalesce((v_new->>'activo')::boolean, false) AND v_new->>'deleted_at' IS NULL);
    IF v_antes = v_despues OR NOT cashbook._caja_de_usuario(v_t, (v_fila->>'id')::uuid) THEN RETURN NULL; END IF;
    v_det := jsonb_build_object('usuario', v_fila->>'id', 'username', v_fila->>'username');
  ELSE
    RETURN NULL;
  END IF;

  -- Quién: sólo si la fila lo dice EN ESTE cambio (si la columna no se tocó, es el del cambio anterior).
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
    'actor', v_actor, 'rol_de_base', current_user));
  RETURN NULL;
END $fn$;
`;

const DEL_LIBRO = ['_claves_de_caja(jsonb, text, boolean, boolean)', '_caja_del_rol(uuid, text)', '_caja_de_usuario(uuid, uuid)',
  '_alerta_de_permiso(uuid, uuid, jsonb)', 'alerta_de_permiso()'];

const TRIGGERS = {
  role_permissions: 'AFTER INSERT OR UPDATE OR DELETE',
  user_permissions: 'AFTER INSERT OR UPDATE OR DELETE',
  user_roles: 'AFTER INSERT OR UPDATE OR DELETE',
  // Sólo entrar o dejar de entrar: el cambio de perfil base ya alerta por `user_roles`.
  users: 'AFTER UPDATE OF activo, deleted_at',
};

const ORIGEN_NUEVO = `CHECK (source IN ('conteo','cierre','feed','reconstruccion','otro','permiso'))`;
const ORIGEN_ANTERIOR = `CHECK (source IN ('conteo','cierre','feed','reconstruccion','otro'))`;
const CIERRE_NUEVO = `CHECK (state <> 'cerrado' OR closing_entry_id IS NOT NULL
  OR (length(trim(coalesce(closing_note, ''))) > 0 AND closing_authorized_by IS NOT NULL AND closing_authorized_by <> closed_by)
  OR (source = 'permiso' AND length(trim(coalesce(closing_note, ''))) > 0))`;
const CIERRE_ANTERIOR = `CHECK (state <> 'cerrado' OR closing_entry_id IS NOT NULL
  OR (length(trim(coalesce(closing_note, ''))) > 0 AND closing_authorized_by IS NOT NULL AND closing_authorized_by <> closed_by))`;
const LO_REVISA_OTRO = `CHECK (source <> 'permiso' OR state <> 'cerrado'
  OR (closed_by IS DISTINCT FROM created_by AND closed_by::text IS DISTINCT FROM detail->>'usuario'))`;

/** El CHECK de `source` nació sin nombre: se busca por lo que dice, no por cómo lo bautizó Postgres. */
async function checksDeOrigen(knex) {
  const { rows } = await knex.raw(`SELECT conname FROM pg_constraint
    WHERE conrelid = 'cashbook.findings'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%source%' AND pg_get_constraintdef(oid) LIKE '%reconstruccion%'`);
  return rows.map((r) => r.conname);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regclass('cashbook.findings') IS NOT NULL AS hay`);
  if (!h.hay) throw new Error('[LE.4.8] falta LE.1.9 (20261027120749): se aplica después.');

  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  for (const c of await checksDeOrigen(knex)) await knex.raw(`ALTER TABLE cashbook.findings DROP CONSTRAINT ${c}`);
  await knex.raw(`ALTER TABLE cashbook.findings ADD CONSTRAINT cashbook_hallazgo_origen ${ORIGEN_NUEVO}`);
  await knex.raw(`ALTER TABLE cashbook.findings DROP CONSTRAINT IF EXISTS cashbook_hallazgo_se_cierra_con_algo`);
  await knex.raw(`ALTER TABLE cashbook.findings ADD CONSTRAINT cashbook_hallazgo_se_cierra_con_algo ${CIERRE_NUEVO}`);
  await knex.raw(`ALTER TABLE cashbook.findings DROP CONSTRAINT IF EXISTS cashbook_permiso_lo_revisa_otro`);
  await knex.raw(`ALTER TABLE cashbook.findings ADD CONSTRAINT cashbook_permiso_lo_revisa_otro ${LO_REVISA_OTRO}`);
  // Las funciones que leen `identity` corren con los derechos de QUIEN CAMBIA el permiso, no del
  // dueño del libro (que no tiene ni debe tener `USAGE` en `identity`): no se validan al crearlas.
  await knex.raw(`SET LOCAL check_function_bodies = off`);
  await knex.raw(FUNCIONES);
  await knex.raw(`RESET ROLE`);

  for (const f of DEL_LIBRO) {
    await knex.raw(`REVOKE ALL ON FUNCTION cashbook.${f} FROM PUBLIC`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO app_runtime`);
  }
  for (const [t, cuando] of Object.entries(TRIGGERS)) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_alerta_permiso ON identity.${t}`);
    await knex.raw(`CREATE TRIGGER trg_cashbook_alerta_permiso ${cuando} ON identity.${t}
      FOR EACH ROW EXECUTE FUNCTION cashbook.alerta_de_permiso()`);
  }
};

/** Sólo sin alertas de permiso abiertas ni cerradas: un hallazgo no se borra (B23). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [c] } = await knex.raw(`SELECT count(*)::int AS n FROM cashbook.findings WHERE source = 'permiso'`);
  if (c.n > 0) throw new Error(`[LE.4.8] hay ${c.n} alertas de permiso: no se bajan, se congelan (B23).`);
  for (const t of Object.keys(TRIGGERS)) await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_alerta_permiso ON identity.${t}`);
  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  for (const f of [...DEL_LIBRO].reverse()) await knex.raw(`DROP FUNCTION IF EXISTS cashbook.${f}`);
  await knex.raw(`ALTER TABLE cashbook.findings DROP CONSTRAINT IF EXISTS cashbook_permiso_lo_revisa_otro`);
  await knex.raw(`ALTER TABLE cashbook.findings DROP CONSTRAINT IF EXISTS cashbook_hallazgo_se_cierra_con_algo`);
  await knex.raw(`ALTER TABLE cashbook.findings ADD CONSTRAINT cashbook_hallazgo_se_cierra_con_algo ${CIERRE_ANTERIOR}`);
  await knex.raw(`ALTER TABLE cashbook.findings DROP CONSTRAINT IF EXISTS cashbook_hallazgo_origen`);
  await knex.raw(`ALTER TABLE cashbook.findings ADD CONSTRAINT findings_source_check ${ORIGEN_ANTERIOR}`);
  await knex.raw(`RESET ROLE`);
};
