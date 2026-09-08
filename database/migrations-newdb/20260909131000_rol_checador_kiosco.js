'use strict';
/**
 * `[CH.1.2]` — Rol `checador_kiosco`: la cuenta de una pantalla de asistencia.
 *
 * Una cuenta por checador (kiosco por sitio) para que el empleado marque su entrada
 * sin que nadie teclee una contraseña cada mañana. El rol concede UNA sola clave y
 * su alcance está recortado, calcando `etiquetas_anaquel` (`[IDG.9.12]`): una
 * pantalla de piso no tiene nada que hacer con la cartera de clientes, las marcas ni
 * las rutas.
 *
 * ── Por qué el rol se crea acá y las CUENTAS no ──────────────────────────────
 * Crear un usuario exige una contraseña, y un hash de contraseña no va en un archivo
 * versionado. Las cuentas las da de alta `database/scripts/provision-checadores.js`,
 * que además imprime la credencial una sola vez. Misma división que las etiqueteras.
 *
 * ── `HR_ATTENDANCE_CHECAR` todavía no gatea una pantalla ─────────────────────
 * Se declara acá porque una cuenta sin ninguna clave no puede existir con sentido, y
 * porque es la clave que va a gatear el kiosco de `[CH.0.10]` (módulo/UI de
 * asistencia, aún sin construir). **Hasta que esa pantalla exista, la cuenta puede
 * entrar y no tiene a dónde ir** — eso está declarado en el tracker, no disimulado.
 * Es la razón por la que la clave entra al `AUTHZ_TREE` **sin `route`**: aparece como
 * casilla asignable en `/admin/roles` (si no, sería un permiso invisible que nadie
 * puede ver ni quitar) pero nunca se ofrece como ruta navegable en un 404/403.
 *
 * ── El permiso es RESTRICTIVO ────────────────────────────────────────────────
 * No se reparte a ningún rol existente ni entra a `role-presets`: sólo lo tiene
 * `checador_kiosco`. Un permiso que nadie más necesita no se derrama.
 *
 * Idempotente: UPSERT por `(tenant_id, role_name)` y por `(tenant_id, role_name,
 * dimension)`. No pisa un `false` puesto a mano en otro rol porque no toca otros roles.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'checador_kiosco';
const CLAVE = 'HR_ATTENDANCE_CHECAR';
/** Mismo recorte que `etiquetas_anaquel`: sólo su sucursal y su zona. */
const ALCANCE = {
  brand: 'none',
  customer: 'none',
  expense_area: 'none',
  route: 'none',
  warehouse: 'own',
  zone: 'own',
};

exports.up = async function up(knex) {
  const { rows: tenants } = await knex.raw(
    `SELECT id, slug FROM identity.tenants WHERE deleted_at IS NULL ORDER BY slug`,
  );
  if (!tenants.length) throw new Error('No hay tenants en identity.tenants.');

  for (const t of tenants) {
    await knex.raw(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES (?, ?, ?::jsonb)
       ON CONFLICT (tenant_id, role_name) DO UPDATE
         SET permissions = role_permissions.permissions || ?::jsonb,
             updated_at = now()`,
      [t.id, ROL, JSON.stringify({ [CLAVE]: true }), JSON.stringify({ [CLAVE]: true })],
    );

    for (const [dimension, mode] of Object.entries(ALCANCE)) {
      await knex.raw(
        `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, mode, values)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (tenant_id, role_name, dimension) DO UPDATE
           SET mode = EXCLUDED.mode, values = NULL, updated_at = now()`,
        [t.id, ROL, dimension, mode],
      );
    }
    console.log(`  ✓ [${t.slug}] rol ${ROL} con ${CLAVE} + alcance recortado (6 dimensiones).`);
  }

  // ── Gates ─────────────────────────────────────────────────────────────────
  // (a) El rol concede exactamente una clave, y es la del checador. Si concediera
  //     más, una pantalla de piso tendría permisos que nadie le dio a propósito.
  const { rows: g1 } = await knex.raw(
    `SELECT rp.tenant_id, e.k
       FROM identity.role_permissions rp, jsonb_each(rp.permissions) e(k, v)
      WHERE rp.role_name = ? AND v = 'true'::jsonb AND e.k <> ?`,
    [ROL, CLAVE],
  );
  if (g1.length) {
    throw new Error(`El rol ${ROL} concede claves de mas: ${[...new Set(g1.map((r) => r.k))].join(', ')}`);
  }

  // (b) La clave NO se derramó a ningún otro rol.
  const { rows: g2 } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb AND role_name <> ?`,
    [CLAVE, ROL],
  );
  if (g2.length) {
    console.log(`  ! ${CLAVE} tambien lo conceden: ${g2.map((r) => r.role_name).join(', ')} (revisar si es intencional).`);
  }

  // (c) Las 6 dimensiones quedaron, y ninguna en `all`.
  const { rows: g3 } = await knex.raw(
    `SELECT dimension, mode FROM identity.role_scopes WHERE role_name = ? ORDER BY dimension`,
    [ROL],
  );
  if (g3.length < Object.keys(ALCANCE).length) {
    throw new Error(`El rol ${ROL} quedo con ${g3.length} de ${Object.keys(ALCANCE).length} dimensiones de alcance.`);
  }
  const abiertas = g3.filter((r) => r.mode === 'all').map((r) => r.dimension);
  if (abiertas.length) throw new Error(`El rol ${ROL} quedo con alcance 'all' en: ${abiertas.join(', ')}`);

  // Cobertura: cuántas cuentas lo usan hoy. Se DECLARA — el rol sin cuentas no
  // sirve de nada, y el alta la hace el script porque exige contraseña.
  const { rows: cuentas } = await knex.raw(
    `SELECT count(*)::int n FROM identity.users WHERE role_name = ? AND deleted_at IS NULL`,
    [ROL],
  );
  console.log(`\n  Cuentas con el rol ${ROL}: ${cuentas[0].n}.`);
  if (cuentas[0].n === 0) {
    console.log('  Alta: node database/scripts/provision-checadores.js --sucursal NN --apply');
  }
};

exports.down = async function down(knex) {
  // El rol NO se borra si tiene cuentas: dejaría kioscos sin perfil. Se apaga la
  // clave, que es reversible y explícito.
  const { rows: cuentas } = await knex.raw(
    `SELECT count(*)::int n FROM identity.users WHERE role_name = ? AND deleted_at IS NULL`,
    ['checador_kiosco'],
  );
  const off = JSON.stringify({ HR_ATTENDANCE_CHECAR: false });
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions || ?::jsonb, updated_at = now()
      WHERE role_name = ?`,
    [off, ROL],
  );
  if (cuentas[0].n === 0) {
    await knex.raw(`DELETE FROM identity.role_scopes WHERE role_name = ?`, [ROL]);
    await knex.raw(`DELETE FROM identity.role_permissions WHERE role_name = ?`, [ROL]);
    console.log(`  Rol ${ROL} eliminado (no tenia cuentas).`);
  } else {
    console.log(`  ${cuentas[0].n} cuenta(s) usan ${ROL}: se apago la clave, el rol se conserva.`);
  }
};
