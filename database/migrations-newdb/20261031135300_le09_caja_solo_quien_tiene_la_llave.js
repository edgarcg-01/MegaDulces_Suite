'use strict';
/**
 * `[LE.0.9]` — **Opera la caja sólo quien tiene la llave, y el superadmin no cuenta en la caja.**
 *
 * Edgar, 2026-10-31 (fase LE, ventanilla bancaria, ADR-112): D21 *Tesorería deja de operar y sólo
 * firma*; D22 *arquea el jefe de finanzas que hoy dispensa, y deja de operar*; D23 *«yo autorizo que
 * lo quites»*: regla en la base + quitar el superadmin a quien no es de sistemas.
 *
 * ── Lo medido antes (prod, sólo lectura, sid 7688376744939610156, 2026-10-31) ────────────────
 *  · Fuera de los superadmins, la caja ya sólo la tenían quienes la operan o firman (CGS.33).
 *  · El hueco: **14 cuentas con superadmin**. `RolesGuard` les da god-mode, y además el MAPA del
 *    rol `superadmin` trae `FINANCE_CAJA_GESTIONAR` y `_AUTORIZAR` en `true`: no basta con «no
 *    contar el god-mode», hay que no contar el rol. Una cuenta genérica de sistemas registró 19
 *    movimientos y canceló 3.
 *  · Con la llave efectiva SIN superadmin, operan hoy 4 personas (la cajera, la auxiliar de caja,
 *    Tesorería y el jefe de finanzas que dispensa: tiene 36 roles de complemento, entre ellos
 *    `tesoreria` y `direccion`) y firman 5.
 *  · Historia completa del libro: 726 altas de 4 cuentas, ninguna sin `created_by`; 18 cortes de 2.
 *  · No hay bitácora de peticiones: lo que pierden las 4 cuentas a las que se les quita el superadmin
 *    fuera de la caja es NO MEDIDO. Se deshace con `down()`.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. `finance.caja_llave(tenant, usuario, clave)`: la llave EFECTIVA con la semántica del servidor
 *     (`permissions-cache.service.ts`: la excepción personal gana; si no, la unión de los roles de
 *     `user_roles`, o el perfil base si no hay filas) **sin los roles `superadmin` ni `admin`**.
 *     Persona desconocida → NULL: el disparador no decide (las pruebas usan ids sintéticos; en prod
 *     el servicio siempre manda al usuario del token). Es un límite declarado, no un hueco callado.
 *  2. Disparadores: registrar o cancelar en el libro, y abrir o cerrar un corte, exigen
 *     `FINANCE_CAJA_GESTIONAR`; autorizar un corte exige `FINANCE_CAJA_AUTORIZAR`
 *     (`caja_exige_llave_chk`).
 *  3. Excepciones personales: quien tiene el rol `tesoreria` pierde la de operar (D21); el jefe de
 *     finanzas que arquea pierde operar y firmar (D22).
 *  4. Se quita el complemento `superadmin` a las 4 cuentas que confirmó el PM (su perfil base no
 *     es superadmin). Dirección, sistemas y los perfiles base superadmin no se tocan aquí.
 *
 * Al final mide quién opera y quién firma, y aborta si no es exactamente lo firmado; después prueba
 * la regla con filas reales dentro de puntos de guardado que se deshacen.
 *
 * ⚠️ La API desplegada no manda nada nuevo (expand/contract): sólo deja de aceptar a quien no tiene
 *    la llave. Los permisos personales viajan en caché de 30 s.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const NOTA = '[LE.0.9] Edgar 2026-10-31 (D21-D23): opera quien opera; Tesoreria firma; el jefe de finanzas que arquea no opera ni firma.';
const NOTA_SUPERADMIN = '[LE.0.9] Edgar 2026-10-31 (D23): se quita el superadmin a quien no es de sistemas.';
const ARQUEA = 'jesus_carrillo';
const SIN_SUPERADMIN = ['luis_hernandez', 'jlh_lopez', 'claudia_mata', ARQUEA];
const OPERAN = ['carmen_rodriguez', 'mayra_gutierrez'];
const FIRMAN = ['guillermo_lopez', 'maria_gutierrez', 'superuser'];

const FUNCIONES = `
CREATE OR REPLACE FUNCTION finance.caja_llave(p_tenant uuid, p_user uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  DECLARE
    v_base  text;
    v_allow boolean;
    v_roles text[];
  BEGIN
    IF p_user IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT lower(u.role_name::text) INTO v_base
      FROM identity.users u WHERE u.tenant_id = p_tenant AND u.id = p_user;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    SELECT o.allow INTO v_allow
      FROM identity.user_permissions o
     WHERE o.tenant_id = p_tenant AND o.user_id = p_user AND o.permission_key = p_key;
    IF FOUND THEN
      RETURN v_allow;
    END IF;

    SELECT array_agg(lower(r.role_name)) INTO v_roles
      FROM identity.user_roles r WHERE r.tenant_id = p_tenant AND r.user_id = p_user;
    IF v_roles IS NULL THEN
      v_roles := ARRAY[v_base];
    END IF;

    RETURN coalesce((
      SELECT bool_or((rp.permissions ->> p_key) = 'true')
        FROM identity.role_permissions rp
       WHERE rp.tenant_id = p_tenant
         AND lower(rp.role_name) = ANY (v_roles)
         AND lower(rp.role_name) NOT IN ('superadmin', 'admin')), false);
  END
$function$;

CREATE OR REPLACE FUNCTION finance.caja_exige_llave()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
  DECLARE
    v_quien uuid;
    v_clave text;
    v_acto  text;
  BEGIN
    IF TG_TABLE_NAME = 'cash_ledger' THEN
      IF TG_OP = 'INSERT' THEN
        v_quien := NEW.created_by; v_clave := 'FINANCE_CAJA_GESTIONAR'; v_acto := 'registrar en la caja';
      ELSIF NEW.cancelled_by IS NOT NULL AND NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by THEN
        v_quien := NEW.cancelled_by; v_clave := 'FINANCE_CAJA_GESTIONAR'; v_acto := 'cancelar un movimiento de la caja';
      END IF;
    ELSE
      IF TG_OP = 'INSERT' THEN
        v_quien := NEW.created_by; v_clave := 'FINANCE_CAJA_GESTIONAR'; v_acto := 'abrir un corte';
      ELSE
        IF NEW.authorized_by IS NOT NULL AND NEW.authorized_by IS DISTINCT FROM OLD.authorized_by
           AND finance.caja_llave(NEW.tenant_id, NEW.authorized_by, 'FINANCE_CAJA_AUTORIZAR') IS FALSE THEN
          RAISE EXCEPTION 'Para autorizar el corte % hace falta la llave FINANCE_CAJA_AUTORIZAR; en la caja el superadmin no cuenta (D23).', NEW.folio
            USING ERRCODE = 'check_violation', CONSTRAINT = 'caja_exige_llave_chk';
        END IF;
        IF NEW.closed_by IS NOT NULL AND NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
          v_quien := NEW.closed_by; v_clave := 'FINANCE_CAJA_GESTIONAR'; v_acto := 'cerrar un corte';
        END IF;
      END IF;
    END IF;

    IF v_quien IS NOT NULL AND finance.caja_llave(NEW.tenant_id, v_quien, v_clave) IS FALSE THEN
      RAISE EXCEPTION 'Para % hace falta la llave %; en la caja el superadmin no cuenta (D23).', v_acto, v_clave
        USING ERRCODE = 'check_violation', CONSTRAINT = 'caja_exige_llave_chk';
    END IF;
    RETURN NEW;
  END
$function$;
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(FUNCIONES);
  await knex.raw(`COMMENT ON FUNCTION finance.caja_llave(uuid, uuid, text) IS
    '[LE.0.9] Llave efectiva de una persona (excepcion personal > union de roles) SIN superadmin ni admin. NULL = persona desconocida.'`);
  await knex.raw(`COMMENT ON FUNCTION finance.caja_exige_llave() IS
    '[LE.0.9] Registrar, cancelar, abrir y cerrar exigen FINANCE_CAJA_GESTIONAR; autorizar, FINANCE_CAJA_AUTORIZAR. El superadmin no cuenta (D23, Edgar 2026-10-31).'`);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_exige_llave ON finance.cash_ledger`);
  await knex.raw(`
    CREATE TRIGGER trg_cash_ledger_exige_llave
      BEFORE INSERT OR UPDATE OF cancelled_by ON finance.cash_ledger
      FOR EACH ROW EXECUTE FUNCTION finance.caja_exige_llave()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_exige_llave ON finance.cash_ledger_cuts`);
  await knex.raw(`
    CREATE TRIGGER trg_cash_cut_exige_llave
      BEFORE INSERT OR UPDATE OF closed_by, authorized_by ON finance.cash_ledger_cuts
      FOR EACH ROW EXECUTE FUNCTION finance.caja_exige_llave()`);

  const persona = async (username) => (await knex.raw(
    `SELECT id, role_name::text AS base FROM identity.users
      WHERE tenant_id = ? AND username = ? AND activo AND deleted_at IS NULL`, [TENANT, username])).rows[0] ?? null;
  if (!(await persona(OPERAN[0]))) {
    console.log('  ⚠️ [LE.0.9] NO MEDIDO: las personas de la caja no existen en este destino (base de prueba): sólo la regla.');
    return;
  }

  const override = (userId, clave, allow) => knex.raw(
    `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, user_id, permission_key)
     DO UPDATE SET allow = EXCLUDED.allow, nota = EXCLUDED.nota, updated_at = now()`,
    [TENANT, userId, clave, allow, NOTA]);

  // ── D21: quien tiene el rol tesoreria firma y no opera ─────────────────────────────────────
  const { rows: tesoreria } = await knex.raw(`
    SELECT DISTINCT u.id FROM identity.users u
      LEFT JOIN identity.user_roles r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
     WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
       AND (lower(u.role_name::text) = 'tesoreria' OR lower(r.role_name) = 'tesoreria')`, [TENANT]);
  for (const t of tesoreria) await override(t.id, 'FINANCE_CAJA_GESTIONAR', false);

  // ── D22: el jefe de finanzas que arquea no opera ni firma ────────────────────────────────────
  const arquea = await persona(ARQUEA);
  if (!arquea) throw new Error(`[LE.0.9] no existe ${ARQUEA}: el arqueo de D22 quedó sin persona. Revisarlo con Edgar.`);
  await override(arquea.id, 'FINANCE_CAJA_GESTIONAR', false);
  await override(arquea.id, 'FINANCE_CAJA_AUTORIZAR', false);

  // ── D23: fuera el complemento superadmin de quien no es de sistemas ─────────────────────────
  for (const username of SIN_SUPERADMIN) {
    const p = await persona(username);
    if (!p) throw new Error(`[LE.0.9] no existe ${username}: la lista que confirmó el PM ya no cuadra.`);
    if (['superadmin', 'admin'].includes(String(p.base).toLowerCase())) {
      throw new Error(`[LE.0.9] el perfil base de ${username} es superadmin: quitarlo lo deja sin perfil; no era parte de lo firmado.`);
    }
    await knex.raw(
      `DELETE FROM identity.user_roles WHERE tenant_id = ? AND user_id = ? AND lower(role_name) IN ('superadmin', 'admin')`,
      [TENANT, p.id]);
    const { rows: quedan } = await knex.raw(
      `SELECT count(*)::int AS n FROM identity.user_roles WHERE tenant_id = ? AND user_id = ?`, [TENANT, p.id]);
    if (quedan[0].n === 0) {
      await knex.raw(
        `INSERT INTO identity.user_roles (tenant_id, user_id, role_name, is_primary, nota) VALUES (?, ?, ?, true, ?)`,
        [TENANT, p.id, p.base, NOTA_SUPERADMIN]);
    }
  }

  // ── Verificación: quién opera y quién firma, con la MISMA función que usa el disparador ─────
  const { rows: ef } = await knex.raw(`
    SELECT u.username,
           finance.caja_llave(u.tenant_id, u.id, 'FINANCE_CAJA_GESTIONAR') AS opera,
           finance.caja_llave(u.tenant_id, u.id, 'FINANCE_CAJA_AUTORIZAR') AS firma
      FROM identity.users u
     WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL`, [TENANT]);
  const opera = ef.filter((r) => r.opera).map((r) => r.username).sort();
  const firma = ef.filter((r) => r.firma).map((r) => r.username).sort();
  const igual = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());
  if (!igual(opera, OPERAN) || !igual(firma, FIRMAN)) {
    throw new Error(`[LE.0.9] la caja no quedó como se firmó · operan: [${opera.join(', ')}] (se esperaba ${OPERAN.join(', ')}) · firman: [${firma.join(', ')}] (se esperaba ${FIRMAN.join(', ')})`);
  }
  const { rows: dios } = await knex.raw(`
    SELECT u.username FROM identity.users u
      JOIN identity.user_roles r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
     WHERE u.tenant_id = ? AND u.username = ANY(?) AND lower(r.role_name) IN ('superadmin', 'admin')`,
    [TENANT, SIN_SUPERADMIN]);
  if (dios.length) throw new Error(`[LE.0.9] siguen con superadmin: ${dios.map((r) => r.username).join(', ')}`);

  await probar(knex);
  console.log(`  ✔ [LE.0.9] operan: ${opera.join(', ')} · firman: ${firma.join(', ')} · sin superadmin: ${SIN_SUPERADMIN.join(', ')}.`);
};

/** La regla contra filas reales: una copia del último movimiento, dada de alta por cada persona. */
async function probar(knex) {
  const { rows: ult } = await knex.raw(
    `SELECT id FROM finance.cash_ledger WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [TENANT]);
  if (!ult.length) {
    console.log('  ⚠️ [LE.0.9] NO MEDIDO: el libro está vacío; la regla no se probó con filas reales.');
    return;
  }
  const { rows: cols } = await knex.raw(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'finance' AND table_name = 'cash_ledger' AND column_name IN ('origen_ref', 'client_uuid')`);
  const extra = cols.map((c) => `, '${c.column_name}', NULL`).join('');
  const casos = [
    ['la cajera registra', 'carmen_rodriguez', 'PASA'],
    ['Tesorería registra', 'maria_gutierrez', 'FALLA'],
    ['el jefe de finanzas que arquea registra', ARQUEA, 'FALLA'],
    ['la cuenta genérica de sistemas (superadmin) registra', 'superoot', 'FALLA'],
  ];
  const fallos = [];
  let n = 0;
  for (const [nombre, username, espera] of casos) {
    n += 1;
    await knex.raw('SAVEPOINT le09_prueba');
    let real;
    let detalle = '';
    try {
      await knex.raw(`
        INSERT INTO finance.cash_ledger
        SELECT (jsonb_populate_record(NULL::finance.cash_ledger, to_jsonb(l) || jsonb_build_object(
                 'id', gen_random_uuid(), 'folio', 'LE09-PRUEBA-' || ?::text, 'corte_id', NULL,
                 'created_by', u.id, 'created_by_username', u.username, 'cancelled_by', NULL${extra}))).*
          FROM finance.cash_ledger l, identity.users u
         WHERE l.id = ? AND u.tenant_id = ? AND u.username = ?`, [`${Date.now()}-${n}`, ult[0].id, TENANT, username]);
      real = 'PASA';
    } catch (e) {
      real = e.constraint === 'caja_exige_llave_chk' ? 'FALLA' : 'OTRO_ERROR';
      detalle = ` (${e.constraint || e.message})`;
    }
    await knex.raw('ROLLBACK TO SAVEPOINT le09_prueba');
    await knex.raw('RELEASE SAVEPOINT le09_prueba');
    if (real !== espera) fallos.push(`«${nombre}»: se esperaba ${espera} y dio ${real}${detalle}`);
  }
  if (fallos.length) throw new Error(`[LE.0.9] la regla no se comporta como debe:\n    - ${fallos.join('\n    - ')}`);
  console.log(`  ✔ [LE.0.9] ${casos.length} casos probados contra una copia del último movimiento, todos revertidos.`);
}

/** Deshace EXACTAMENTE lo que hizo el `up`: la regla, las excepciones con su nota y el superadmin quitado. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_exige_llave ON finance.cash_ledger`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_exige_llave ON finance.cash_ledger_cuts`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caja_exige_llave()`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caja_llave(uuid, uuid, text)`);
  await knex.raw(`DELETE FROM identity.user_permissions WHERE tenant_id = ? AND nota = ?`, [TENANT, NOTA]);
  await knex.raw(`DELETE FROM identity.user_roles WHERE tenant_id = ? AND nota = ?`, [TENANT, NOTA_SUPERADMIN]);
  await knex.raw(`
    INSERT INTO identity.user_roles (tenant_id, user_id, role_name, is_primary, nota)
    SELECT u.tenant_id, u.id, 'superadmin', false, ?
      FROM identity.users u
     WHERE u.tenant_id = ? AND u.username = ANY(?)
       AND NOT EXISTS (SELECT 1 FROM identity.user_roles r
                        WHERE r.tenant_id = u.tenant_id AND r.user_id = u.id AND r.role_name = 'superadmin')`,
    [NOTA_SUPERADMIN, TENANT, SIN_SUPERADMIN]);
};
