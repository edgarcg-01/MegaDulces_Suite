/**
 * `[TP.12]` — Gerardo, Aide y Guillermo además GESTIONAN las obligaciones a proveedor.
 *
 * `[TP.11]` les dio `VER`. Esto agrega `COMPRAS_OBLIGACIONES_GESTIONAR` —capturar y editar,
 * no sólo mirar— a los tres que el usuario nombró.
 *
 * ── Uno de los tres ya lo tenía ─────────────────────────────────────────────
 *   gerardo_ramirez  auxiliar_compras     GESTIONAR ✓  → no se toca
 *   aide_piceno      compras_operaciones  falta
 *   guillermo_lopez  direccion            falta
 *
 * ── ⚠️ Por qué uno va por ROL y el otro por PERSONA ─────────────────────────
 * No es inconsistencia: son dos situaciones distintas y la medición las separa.
 *
 * **Aide → por ROL.** `compras_operaciones` tiene exactamente **una** persona (ella), es un rol
 * de Compras, y capturar obligaciones es parte de esa función. El permiso pertenece al rol.
 *
 * **Guillermo → por PERSONA** (`identity.user_permissions`), por dos razones medidas:
 *
 *   1. `direccion` son **DOS** personas: él y `superuser` (Luis Francisco López Gutiérrez, el
 *      dueño). Darlo al rol le entregaría en silencio un permiso de escritura de Compras a
 *      alguien que nadie nombró.
 *   2. El reparto actual muestra una **separación de funciones deliberada**:
 *
 *        rol               GESTIONAR  PLAZOS_AUTORIZAR
 *        compras               ✓            ✓
 *        gerente_compras       ✓            ✓
 *        auxiliar_compras      ✓            —
 *        direccion             —            ✓      ← autoriza plazos, NO captura
 *
 *      O sea que quien autoriza el plazo no es quien captura la obligación. Darle `GESTIONAR`
 *      al ROL `direccion` borraría esa separación para todo el que ocupe la dirección, hoy y
 *      mañana. Dárselo a **Guillermo** es una excepción nominal, visible y reversible.
 *
 * ⚠️ El permiso viaja en el JWT → **hay que volver a entrar**.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const CLAVE = 'COMPRAS_OBLIGACIONES_GESTIONAR';
const ROL_DE_AIDE = 'compras_operaciones';
const PERSONA = 'guillermo_lopez';

const NOTA_PERSONA =
  '[TP.12] Captura obligaciones a proveedor. Va por PERSONA y no por el rol `direccion` por dos ' +
  'motivos: el rol lo comparte con `superuser` (el dueno), y el reparto vigente separa a ' +
  'proposito quien AUTORIZA plazos (direccion) de quien CAPTURA la obligacion (compras). ' +
  'Pedido por el usuario, 2026-10-01.';

exports.up = async function up(knex) {
  // ── Candado 1: la clave existe en el padrón ──────────────────────────────
  const { rows: declarantes } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions WHERE permissions -> ? IS NOT NULL`,
    [CLAVE],
  );
  if (!declarantes.length) throw new Error(`[TP.12] Ningún rol declara "${CLAVE}".`);

  // ── Aide: por rol ────────────────────────────────────────────────────────
  // ⚠️ `-> 'KEY' IS NULL`, NO el operador `?` de JSONB: knex no lo escapa.
  const { rows: [estado] } = await knex.raw(
    `SELECT permissions -> ? IS NULL AS ausente, (permissions ->> ?)::bool AS valor
       FROM identity.role_permissions WHERE role_name = ?`,
    [CLAVE, CLAVE, ROL_DE_AIDE],
  );
  if (!estado) throw new Error(`[TP.12] No existe el rol "${ROL_DE_AIDE}".`);
  if (!estado.ausente && estado.valor === false) {
    throw new Error(
      `[TP.12] "${ROL_DE_AIDE}" tiene "${CLAVE}" en FALSE explícito. Un false puede ser una ` +
        `decisión y no residuo: se para y se mira, no se pisa.`,
    );
  }
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ?`,
    [CLAVE, ROL_DE_AIDE],
  );

  // ── Guillermo: por persona ───────────────────────────────────────────────
  const g = await knex('identity.users')
    .where({ tenant_id: TENANT, username: PERSONA })
    .whereNull('deleted_at')
    .first('id', 'role_name');
  if (!g) throw new Error(`[TP.12] No existe "${PERSONA}".`);

  const fila = {
    tenant_id: TENANT,
    user_id: g.id,
    permission_key: CLAVE,
    allow: true,
    nota: NOTA_PERSONA,
    granted_by_username: 'migracion [TP.12]',
    updated_at: knex.fn.now(),
  };
  await knex('identity.user_permissions')
    .insert(fila)
    .onConflict(['tenant_id', 'user_id', 'permission_key'])
    .merge(fila);

  // ── Candado 2: los TRES quedan pudiendo gestionar ────────────────────────
  // Se pregunta por el efecto —rol OR override OR god-mode—, no por «el UPDATE corrió».
  const NOMBRADOS = ['gerardo_ramirez', 'aide_piceno', PERSONA];
  const { rows: efectivo } = await knex.raw(
    `SELECT u.username,
            coalesce(up.allow,
                     (rp.permissions ->> ?)::bool,
                     false)
              OR lower(u.role_name) IN ('superadmin', 'admin') AS gestiona,
            CASE WHEN up.allow IS TRUE THEN 'persona'
                 WHEN (rp.permissions ->> ?)::bool IS TRUE THEN 'rol ' || u.role_name
                 WHEN lower(u.role_name) IN ('superadmin','admin') THEN 'god-mode'
                 ELSE 'NADA' END AS por
       FROM identity.users u
       LEFT JOIN identity.role_permissions rp ON rp.role_name = u.role_name
       LEFT JOIN identity.user_permissions up
              ON up.tenant_id = u.tenant_id AND up.user_id = u.id AND up.permission_key = ?
      WHERE u.deleted_at IS NULL AND u.username = ANY (?)`,
    [CLAVE, CLAVE, CLAVE, NOMBRADOS],
  );
  const sin = efectivo.filter((r) => !r.gestiona).map((r) => r.username);
  if (sin.length) throw new Error(`[TP.12] Siguen sin poder gestionar: ${sin.join(', ')}. Se revierte.`);
  if (efectivo.length !== NOMBRADOS.length) {
    throw new Error(`[TP.12] Se esperaban ${NOMBRADOS.length} personas y se encontraron ${efectivo.length}.`);
  }

  // ── Candado 3: el dueño NO quedó con el permiso de rebote ────────────────
  // Es la razón entera de haber ido por persona: si `superuser` lo gana, el criterio falló.
  const { rows: [dueno] } = await knex.raw(
    `SELECT coalesce((rp.permissions ->> ?)::bool, false) AS por_rol
       FROM identity.users u
       LEFT JOIN identity.role_permissions rp ON rp.role_name = u.role_name
      WHERE u.tenant_id = ? AND u.username = 'superuser'`,
    [CLAVE, TENANT],
  );
  if (dueno?.por_rol) {
    throw new Error(`[TP.12] El rol "direccion" quedó con "${CLAVE}": era justo lo que se evitaba.`);
  }

  efectivo.forEach((r) => console.log(`[TP.12] ${r.username.padEnd(18)} gestiona → por ${r.por}`));
  console.log('         ⚠️ Hay que volver a entrar: el permiso va en el JWT.');
};

exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE role_name = ?`,
    [CLAVE, ROL_DE_AIDE],
  );
  const g = await knex('identity.users').where({ tenant_id: TENANT, username: PERSONA }).first('id');
  if (g) {
    await knex('identity.user_permissions')
      .where({ tenant_id: TENANT, user_id: g.id, permission_key: CLAVE })
      .del();
  }
};
