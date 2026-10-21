'use strict';
/**
 * `[CGS.33]` — **A la Caja General entran tres personas**, y Dirección como suplente.
 *
 * Edgar, 2026-10-21: *«los únicos que tienen acceso es María del Carmen, Mayra Gutiérrez y María
 * Gutiérrez. María Gutiérrez es la supervisora y encargada de finanzas»*. Y en la misma ronda:
 * Dirección **se queda como suplente** (D2) y a Carmen **se le quita** su llave personal de
 * autorizar. Los superadmins se revisan aparte (pasan cualquier permiso: esto no los alcanza).
 *
 * ── Lo medido antes (prod, `dev_ro`, 2026-10-21) ────────────────────────────────────────────
 *  · **32 personas** con acceso efectivo a caja (rol + complementos + overrides). Capturaron 3.
 *  · `contabilidad` (4), `credito_cobranza` (2), `finanzas_operativo` (7, entre ellas Mayra),
 *    `gerente_compras` (2) y `marketing` (3) tenían VER + GESTIONAR + CAOS_VER. Ninguno de los
 *    que no son Mayra capturó, canceló ni abrió un corte nunca.
 *  · `carmen_rodriguez` tenía un override personal `FINANCE_CAJA_AUTORIZAR = true`: quien abre y
 *    cierra los 7 cortes podía además autorizar (la doble llave sólo le impedía los suyos).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. En esos roles (y en `auditor_externo` y `auxiliar finanzas`, sin personas activas) las
 *     cuatro claves de caja quedan en **`false`**: una decisión escrita, no un hueco. ⚠️ `false`
 *     en un rol no le quita a nadie lo que otro rol suyo le da (la unión gana): por eso el prevuelo
 *     mide el acceso EFECTIVO de cada persona después, no sólo la tabla de roles.
 *  2. **Mayra** comparte `finanzas_operativo` con otras seis: su acceso pasa a ser PERSONAL
 *     (override `true` de VER, GESTIONAR y CAOS_VER). Por rol no se podía separar.
 *  3. **Carmen**: su override de AUTORIZAR pasa a `false`.
 *  4. **No se tocan** `finanzas` (Carmen), `tesoreria` (María), `direccion` (suplente) ni
 *     `superadmin`.
 *
 * ⚠️ Sólo cambia filas: la compuerta de despliegue la clasifica NO_MEDIDO. Aplicala ANTES de
 *    mergear. Y los permisos viajan en el JWT: quien la pierda la sigue viendo en la pantalla
 *    hasta volver a entrar (el servidor ya no le responde: su caché vence en minutos).
 *
 * Idempotente. Al final mide el acceso efectivo y aborta si quedó alguien de más o de menos.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const CLAVES = ['FINANCE_CAJA_VER', 'FINANCE_CAJA_GESTIONAR', 'FINANCE_CAJA_AUTORIZAR', 'FINANCE_CAOS_VER'];
const ROLES_FUERA = [
  'contabilidad', 'credito_cobranza', 'finanzas_operativo', 'gerente_compras', 'marketing',
  'auditor_externo', 'auxiliar finanzas',
];
const MAYRA = 'mayra_gutierrez';
const CARMEN = 'carmen_rodriguez';
const NOTA = '[CGS.33] Edgar 2026-10-21: a Caja General entran Carmen, Mayra y Maria Gutierrez; Direccion de suplente.';

/** Quiénes deben quedar con acceso efectivo (sin contar superadmins, que pasan todo). */
const ESPERADOS = new Set([CARMEN, MAYRA, 'maria_gutierrez', 'guillermo_lopez', 'superuser']);

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const persona = async (username) => (await knex.raw(
    `SELECT id, username FROM identity.users
      WHERE tenant_id = ? AND username = ? AND activo AND deleted_at IS NULL`, [TENANT, username])).rows[0] ?? null;
  const mayra = await persona(MAYRA);
  const carmen = await persona(CARMEN);
  if (!mayra || !carmen) {
    console.log('  ⚠️ [CGS.33] NO MEDIDO: Carmen o Mayra no existen en este destino (base de prueba): se omite.');
    return;
  }

  // ── Prevuelo: nadie de los roles que salen hizo trabajo de caja en 30 días (salvo Mayra). ──
  const { rows: activos } = await knex.raw(`
    SELECT DISTINCT u.username
      FROM identity.users u
      JOIN finance.cash_ledger l ON l.tenant_id = u.tenant_id
       AND (l.created_by = u.id OR l.cancelled_by = u.id)
     WHERE u.tenant_id = ? AND u.role_name = ANY(?) AND u.username <> ?
       AND l.created_at > now() - interval '30 days'`, [TENANT, ROLES_FUERA, MAYRA]);
  if (activos.length) {
    throw new Error(`[CGS.33] ${activos.map((r) => r.username).join(', ')} capturó en caja en los últimos 30 días y perdería el acceso. Revisarlo con Edgar antes.`);
  }

  // ── 1. Los roles que salen: las cuatro claves en false ─────────────────────────────────
  for (const rol of ROLES_FUERA) {
    for (const clave of CLAVES) {
      await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = jsonb_set(permissions, ARRAY[?::text], 'false'::jsonb, true), updated_at = now()
          WHERE tenant_id = ? AND role_name = ? AND (permissions -> ?) IS DISTINCT FROM 'false'::jsonb`,
        [clave, TENANT, rol, clave]);
    }
  }

  // ── 2 y 3. Overrides personales ─────────────────────────────────────────────────────────
  const override = (userId, clave, allow) => knex.raw(
    `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, user_id, permission_key)
     DO UPDATE SET allow = EXCLUDED.allow, nota = EXCLUDED.nota, updated_at = now()`,
    [TENANT, userId, clave, allow, NOTA]);
  for (const clave of ['FINANCE_CAJA_VER', 'FINANCE_CAJA_GESTIONAR', 'FINANCE_CAOS_VER']) {
    await override(mayra.id, clave, true);
  }
  await override(carmen.id, 'FINANCE_CAJA_AUTORIZAR', false);

  // ── Verificación: el acceso EFECTIVO de cada persona, no la tabla de roles ──────────────
  const { rows: ef } = await knex.raw(`
    WITH u AS (SELECT id, username, role_name FROM identity.users
                WHERE tenant_id = ? AND activo AND deleted_at IS NULL),
    roles AS (SELECT u.id, u.role_name AS r FROM u
              UNION SELECT ur.user_id, ur.role_name FROM identity.user_roles ur JOIN u ON u.id = ur.user_id),
    k AS (SELECT unnest(?::text[]) AS key),
    por_rol AS (SELECT roles.id, k.key, bool_or((rp.permissions ->> k.key)::boolean) AS v
                  FROM roles CROSS JOIN k
                  LEFT JOIN identity.role_permissions rp ON rp.role_name = roles.r AND rp.tenant_id = ?
                 GROUP BY 1, 2),
    ef AS (SELECT p.id, p.key, coalesce(o.allow, p.v, false) AS v
             FROM por_rol p LEFT JOIN identity.user_permissions o
               ON o.tenant_id = ? AND o.user_id = p.id AND o.permission_key = p.key)
    SELECT u.username,
           bool_or(ef.v) FILTER (WHERE ef.key = 'FINANCE_CAJA_AUTORIZAR') AS aut,
           bool_or(r.r IN ('superadmin', 'admin')) AS admin
      FROM u JOIN ef ON ef.id = u.id JOIN roles r ON r.id = u.id
     GROUP BY u.username
    HAVING bool_or(ef.v)`, [TENANT, CLAVES, TENANT, TENANT]);
  const deMas = ef.filter((r) => !r.admin && !ESPERADOS.has(r.username)).map((r) => r.username);
  const faltan = [...ESPERADOS].filter((u) => !ef.some((r) => r.username === u));
  const carmenAut = ef.find((r) => r.username === CARMEN)?.aut === true;
  if (deMas.length || faltan.length || carmenAut) {
    throw new Error(`[CGS.33] el acceso efectivo no quedó como se pidió · de más: [${deMas.join(', ')}] · faltan: [${faltan.join(', ')}] · Carmen autoriza: ${carmenAut}`);
  }
  const admins = ef.filter((r) => r.admin && !ESPERADOS.has(r.username)).map((r) => r.username);
  console.log(`  ✔ [CGS.33] caja: ${[...ESPERADOS].join(', ')}. ⚠️ Además pasan por superadmin: ${admins.join(', ') || 'nadie'} (se revisan aparte).`);
};

/** Deshace: los roles vuelven a como estaban medidos (VER, GESTIONAR, CAOS en true; AUTORIZAR sin clave) y los overrides personales también. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const rol of ROLES_FUERA) {
    for (const clave of ['FINANCE_CAJA_VER', 'FINANCE_CAJA_GESTIONAR', 'FINANCE_CAOS_VER']) {
      await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = jsonb_set(permissions, ARRAY[?::text], 'true'::jsonb, true), updated_at = now()
          WHERE tenant_id = ? AND role_name = ? AND (permissions -> ?) = 'false'::jsonb`,
        [clave, TENANT, rol, clave]);
    }
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - 'FINANCE_CAJA_AUTORIZAR'::text, updated_at = now()
        WHERE tenant_id = ? AND role_name = ? AND (permissions -> 'FINANCE_CAJA_AUTORIZAR') = 'false'::jsonb`, [TENANT, rol]);
  }
  await knex.raw(
    `DELETE FROM identity.user_permissions
      WHERE tenant_id = ? AND nota = ? AND allow = true
        AND user_id = (SELECT id FROM identity.users WHERE tenant_id = ? AND username = ?)`,
    [TENANT, NOTA, TENANT, MAYRA]);
  await knex.raw(
    `UPDATE identity.user_permissions SET allow = true, updated_at = now()
      WHERE tenant_id = ? AND permission_key = 'FINANCE_CAJA_AUTORIZAR' AND nota = ?
        AND user_id = (SELECT id FROM identity.users WHERE tenant_id = ? AND username = ?)`,
    [TENANT, NOTA, TENANT, CARMEN]);
};
