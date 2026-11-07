'use strict';
/**
 * `[ALC.0.6]` — Crédito y Cobranza **ve** la bandeja de altas de clientes (sólo consulta).
 *
 * Decisión de Francisco (2026-11-06): *«Paulina y Gloria ven solicitudes de alta, también las
 * gerencias de zona y Dirección General»*. Ver no es capturar: la llave nueva
 * `COMMERCIAL_ALTA_CLIENTES_VER` abre la bandeja, el detalle, el PDF de la constancia y los
 * catálogos; **no** crea, no liga, no cancela y no decide crédito (esas siguen con
 * `COMMERCIAL_ALTA_CLIENTES` y `COMMERCIAL_ALTA_CLIENTES_CREDITO`).
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-06) ──
 *  · Rol `credito_cobranza`: primario de `paula_alanis` y `gloria_vera` (puesto
 *    `auxiliar_credito_cobranza`), y secundario de `jesus_carrillo` (Gerencia Administrativa y
 *    Financiera, que YA ve la bandeja por sus roles `finanzas` y `direccion`). Ninguno de los tres
 *    tenía `COMMERCIAL_ALTA_CLIENTES` ni `_CREDITO` por el rol `credito_cobranza` (ambas en false).
 *  · Su alcance de sucursal es `all` (área `*`): verán las de las nueve sucursales.
 *  · Gerencia de Zona (puesto `jefe_zona`): `aaron_alejo`, `ivette_cruz`, `ramon_rodriguez`, los
 *    tres con rol `superadmin`, que ya tiene las dos llaves. El rol por defecto del puesto
 *    (`supervisor_ventas`) también trae `COMMERCIAL_ALTA_CLIENTES`. Nada que repartir.
 *  · Dirección General (puesto `direccion`): `guillermo_lopez` y `superuser`, rol `direccion`, que
 *    ya tiene las dos llaves. Nada que repartir.
 *
 * Por ROL y no por persona: `credito_cobranza` es exactamente el área (3 personas, medido), así
 * que una gestora nueva la recibe sin que nadie se acuerde de dársela.
 *
 * ── `[ALC.0.7]` María de la Paz NO aprueba crédito (Francisco, 2026-11-06: «maria de la paz no») ──
 * `maria_gutierrez` (Jefe de Tesorería) recibía `COMMERCIAL_ALTA_CLIENTES_CREDITO` sin que nadie
 * la nombrara: por su rol SECUNDARIO `finanzas` (medido: sus roles son `analisis_ventas`,
 * `finanzas` y `tesoreria`). La decisión D3 es Perla y, en su ausencia, Gerencia Administrativa y
 * Financiera (`jefe_finanzas`: Carmen Rodríguez y Jesús Carrillo) y Dirección General. No se le
 * quita el rol `finanzas` (le da todo lo demás de Finanzas): se le NIEGA la llave por persona en
 * `identity.user_permissions`, que gana sobre el rol en los dos sentidos (`[ID.21]`,
 * `permissions-cache.service.ts`). Sin ninguna llave de alta, tampoco ve la bandeja.
 *
 * ⚠️ Sólo toca datos (un UPDATE de roles y una fila en `user_permissions`): no crea ningún objeto
 *    de esquema, y la compuerta del despliegue la clasifica NO_MEDIDO y FRENA. Se aplica con
 *    `aplicar-migracion.sh` en cuanto esté en `origin/main`, ANTES de soltar.
 *
 * Idempotente: sólo toca el rol al que le FALTA la clave (`permissions -> 'KEY' IS NULL`, nunca el
 * operador `?`: knex no lo escapa), y la negación es un upsert; una segunda corrida no cambia nada.
 * Medido antes: `maria_gutierrez` no tenía fila para `COMMERCIAL_ALTA_CLIENTES_CREDITO`, así que el
 * `down()` borra la que puso esta migración y deja todo como estaba.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[alc_ver_solicitudes_credito_cobranza]';
const LLAVE = 'COMMERCIAL_ALTA_CLIENTES_VER';
const ROLES = ['credito_cobranza', 'superadmin'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OTORGADO_POR = 'migracion_20261106181031';
const NEGADAS = [{
  username: 'maria_gutierrez',
  llave: 'COMMERCIAL_ALTA_CLIENTES_CREDITO',
  nota: '[ALC.0.7] No aprueba el crédito de clientes nuevos: le llegaba por su rol secundario finanzas. '
    + 'Aprueban Perla y, en su ausencia, Gerencia Adm. y Financiera y Dirección General. Francisco, 2026-11-06.',
}];
/** `?,?,?` para una lista: knex EXPANDE un arreglo en varios `?`. */
const marcas = (xs) => xs.map(() => '?').join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [hay] } = await knex.raw('SELECT count(*)::int n FROM identity.role_permissions WHERE deleted_at IS NULL');
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, (role_name IN (${marcas(ROLES)})))
      WHERE permissions -> ?::text IS NULL
        AND role_name NOT LIKE 'retirado%'
        AND deleted_at IS NULL`,
    [LLAVE, ...ROLES, LLAVE],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL
      ORDER BY 1`,
    [LLAVE],
  );
  // Regla 20: una llave declarada y sin dueño es una pantalla que nadie abre.
  if (hay.n > 0 && !rows.length) {
    throw new Error(`${TAG} Ningun rol (fuera de superadmin) quedo con ${LLAVE} (regla 20)`);
  }
  console.log(`  ${TAG} ${LLAVE}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);

  // Quiénes la reciben hoy, con nombre: lo que hay que verificar al aplicarla y quién debe volver a entrar.
  const { rows: personas } = await knex.raw(
    `SELECT DISTINCT u.username
       FROM identity.users u
       LEFT JOIN identity.user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
      WHERE u.deleted_at IS NULL AND u.activo
        AND (u.role_name = 'credito_cobranza' OR ur.role_name = 'credito_cobranza')
      ORDER BY 1`,
  );
  console.log(`  ${TAG} con el rol credito_cobranza (deben volver a entrar): ${personas.map((p) => p.username).join(', ') || '(nadie)'}`);

  // ── `[ALC.0.7]` La negación por persona ─────────────────────────────────────────────────────
  for (const p of NEGADAS) {
    const u = await knex('identity.users').where({ tenant_id: TENANT, username: p.username }).first('id');
    // ⛔ No se inventa a la persona: sin ella (la base del CI no la tiene) se DICE y no se toca nada.
    if (!u) { console.log(`  ${TAG} ⚠️ NO MEDIDO: no existe '${p.username}' en este tenant — ${p.llave} no se negó.`); continue; }
    const r = await knex.raw(
      `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota, granted_by_username, created_at, updated_at)
            VALUES (?, ?, ?, false, ?, ?, now(), now())
       ON CONFLICT (tenant_id, user_id, permission_key)
       DO UPDATE SET allow = false, nota = EXCLUDED.nota, granted_by_username = EXCLUDED.granted_by_username, updated_at = now()
         RETURNING (xmax = 0) AS insertada`,
      [TENANT, u.id, p.llave, p.nota, OTORGADO_POR],
    );
    console.log(`  ${TAG} ${p.llave} NEGADA a ${p.username}: ${r.rows?.[0]?.insertada ? 'nueva' : 'ya tenía fila (quedó en allow=false)'}.`);
  }
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: la llave es nueva, así que se quita de todos los roles; y
 * la negación por persona que puso esta migración (por su marca en `granted_by_username`).
 */
exports.down = async function down(knex) {
  for (const p of NEGADAS) {
    await knex.raw(
      `DELETE FROM identity.user_permissions up USING identity.users u
        WHERE up.user_id = u.id AND up.tenant_id = ? AND u.username = ? AND up.permission_key = ? AND up.granted_by_username = ?`,
      [TENANT, p.username, p.llave, OTORGADO_POR],
    );
  }
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`,
    [LLAVE, LLAVE],
  );
};
