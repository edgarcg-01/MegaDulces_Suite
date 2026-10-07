'use strict';
/**
 * `[CV.25]` — Rol `verificador_precios`: la cuenta de un checador de precios de mostrador.
 *
 * Una cuenta por terminal para que el cliente —o quien lo atiende— consulte el precio sin
 * que nadie teclee una contraseña cada mañana. El rol concede UNA sola clave,
 * `STORE_PRICE_CHECK_VER` (`/tienda/verificador`), y su alcance está recortado: una
 * terminal colgada en un pasillo no tiene nada que hacer con la cartera de clientes, las
 * marcas ni las rutas.
 *
 * Calca `etiquetas_anaquel` (`[IDG.9.12]`) y `checador_kiosco` (`[CH.1.2]`), que es el
 * mismo patrón ya resuelto dos veces: cuenta de PUESTO, una clave, alcance a su sucursal.
 *
 * ── Por qué un rol nuevo y no uno de los 7 que ya conceden la clave ─────────
 * Hoy `STORE_PRICE_CHECK_VER` la conceden `auxiliar_compras` (28 claves),
 * `auxiliar_tienda` (13), `direccion` (88), `encargado_tienda` (68), `piso_tienda` (8),
 * `superadmin` (166) y `supervisor` (19) — medido en prod el 2026-09-12. Todos son roles
 * de PERSONA, y está bien que lo tengan: el mostrador lo consulta gente.
 *
 * Pero una terminal no es una persona. Ponerle `piso_tienda` a un kiosco de pasillo le
 * daría ocho claves por una que necesita, y esa cuenta vive con la sesión abierta todo el
 * día a la vista del público. El mismo argumento que `20260909120000` ya usó para NO
 * derramarle esta clave a `etiquetas_anaquel`: *"si el mostrador lo necesita, se le asigna
 * a mano, que es una decisión explícita y no un efecto colateral"*.
 *
 * ── ⚠️ Diferencia con `checador_kiosco`: acá la pantalla SÍ existe ──────────
 * `HR_ATTENDANCE_CHECAR` no gatea ninguna ruta y su cuenta aterriza en nada. Ésta no:
 * `STORE_PRICE_CHECK_VER` está en `AUTHZ_TREE` con `route: '/tienda/verificador'`, o sea
 * que la cuenta entra y tiene a dónde ir. Es la pantalla de `[CV.24]`, con respaldo
 * offline por sucursal (service worker + IndexedDB) — y por eso el alcance por almacén
 * importa: **385 códigos tienen precio distinto entre plazas**, y desde `[NORM.3]` el
 * precio de etiqueta y su mayoreo se guardan POR TIENDA.
 *
 * ── Las CUENTAS no se crean acá ──────────────────────────────────────────────
 * Crear un usuario exige una contraseña, y un hash de contraseña no va en un archivo
 * versionado. Las da de alta `database/scripts/provision-kiosco.js --tipo=verificador`,
 * que imprime la credencial una sola vez y fuera del repo.
 *
 * Idempotente: UPSERT por `(tenant_id, role_name)` y por `(tenant_id, role_name, dimension)`.
 * No pisa un `false` puesto a mano en otro rol porque no toca otros roles.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'verificador_precios';
const CLAVE = 'STORE_PRICE_CHECK_VER';
/** Mismo recorte que `etiquetas_anaquel` y `checador_kiosco`: sólo su sucursal y su zona. */
const ALCANCE = {
  brand: 'none',
  customer: 'none',
  expense_area: 'none',
  route: 'none',
  warehouse: 'own',
  zone: 'own',
};

exports.up = async function up(knex) {
  // Sólo INSERTs (locks de fila, no ACCESS EXCLUSIVE), pero el seguro es gratis y evita
  // quedar colgada esperando a una transacción larga de otro proceso.
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

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
  // (a) El rol concede EXACTAMENTE una clave. Si concediera más, una terminal de
  //     pasillo tendría permisos que nadie le dio a propósito.
  const { rows: g1 } = await knex.raw(
    `SELECT rp.tenant_id, e.k
       FROM identity.role_permissions rp, jsonb_each(rp.permissions) e(k, v)
      WHERE rp.role_name = ? AND v = 'true'::jsonb AND e.k <> ?`,
    [ROL, CLAVE],
  );
  if (g1.length) {
    throw new Error(`El rol ${ROL} concede claves de mas: ${[...new Set(g1.map((r) => r.k))].join(', ')}`);
  }

  // (b) Quién más concede la clave. A diferencia de `checador_kiosco`, acá compartirla
  //     es CORRECTO —el mostrador lo consulta gente— así que esto informa, no falla.
  //     Se imprime para que el reparto quede a la vista y nadie lo descubra por accidente.
  const { rows: g2 } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb AND role_name <> ?
      ORDER BY role_name`,
    [CLAVE, ROL],
  );
  console.log(`  · ${CLAVE} tambien lo conceden (roles de PERSONA, esperado): ${g2.map((r) => r.role_name).join(', ') || '(ninguno)'}`);

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

  // Cobertura: se DECLARA. Un rol sin cuentas no sirve de nada, y el alta la hace el
  // script porque exige contraseña.
  const { rows: cuentas } = await knex.raw(
    `SELECT count(*)::int n FROM identity.users WHERE role_name = ? AND deleted_at IS NULL`,
    [ROL],
  );
  console.log(`\n  Cuentas con el rol ${ROL}: ${cuentas[0].n}.`);
  if (cuentas[0].n === 0) {
    console.log('  ⬜ Ninguna todavia. Alta: node database/scripts/provision-kiosco.js --tipo=verificador --apply');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const { rows: cuentas } = await knex.raw(
    `SELECT username FROM identity.users WHERE role_name = ? AND deleted_at IS NULL`,
    [ROL],
  );
  if (cuentas.length) {
    throw new Error(
      `No se revierte: ${cuentas.length} cuenta(s) usan el rol ${ROL} (${cuentas.map((r) => r.username).join(', ')}). ` +
        'Dalas de baja primero — borrar el rol las dejaria entrando sin ninguna clave.',
    );
  }
  await knex.raw(`DELETE FROM identity.role_scopes WHERE role_name = ?`, [ROL]);
  await knex.raw(`DELETE FROM identity.role_permissions WHERE role_name = ?`, [ROL]);
  console.log(`[CV.25] rol ${ROL} retirado (no habia cuentas usandolo).`);
};
