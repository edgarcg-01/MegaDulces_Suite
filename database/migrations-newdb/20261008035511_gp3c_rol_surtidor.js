'use strict';
/**
 * `[GP.3c.5]` — Rol `surtidor`: el que surte en el celular y nada más.
 *
 * Francisco lo pidió el 2026-10-08: que el surtidor entre DIRECTO a "Tomar siguiente"
 * (`/almacen/surtir`), como el contador entra directo a "Contar camión". El área Pedidos del
 * almacén aterriza en el primer tab que el perfil alcanza y deja las pantallas de foco al final;
 * `almacenista` ve el Tablero (`ALMACEN_PEDIDOS_VER`), así que cae en el Tablero. Hace falta un
 * perfil que surta y NO vea el Tablero.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-08) ────────────────────────────────────────
 *  · Francisco creó el rol desde `/admin/roles` con sus 4 claves, pero esa pantalla no da
 *    ALCANCE, y el alcance es fail-closed: `surtidor` tiene **0 filas en `role_scopes`**, o sea
 *    no ve ninguna sucursal. La lista de almacenes del surtidor sale vacía y no puede tomar
 *    trabajo.
 *  · Lo usan 2 cuentas de prueba (`francisco.surtidor`, `francisco2surtidor`).
 *  · Un rol que sólo existe porque alguien lo capturó en prod no existe en ningún otro ambiente:
 *    acá queda reproducible.
 *
 * ── Qué deja ─────────────────────────────────────────────────────────────────────────────────
 *  · Permisos: `COMMERCIAL_PICKING_VER` (retomar la ola que trae) + `COMMERCIAL_PICKING_GESTIONAR`
 *    (tomar, marcar, cerrar) + `ALMACEN_UBICACIONES_VER` + `SERVICIO_REPORTAR`. Se SUMAN a lo que
 *    tenga la fila (`||`): no se le quita nada que alguien le haya puesto a mano.
 *  · Alcance: su sucursal y su zona; ni clientes, ni marcas, ni rutas, ni áreas de gasto. Calca a
 *    `verificador_precios` / `etiquetas_anaquel` (cuenta de piso, recortada).
 *
 * ⚠️ Sólo hace INSERT/UPDATE y no crea ningún objeto de esquema: la compuerta del despliegue la
 *    clasifica NO_MEDIDO y FRENA a todo el equipo hasta que alguien la aplique a mano. Aplicala
 *    ANTES de mergear.
 *
 * Idempotente: UPSERT por `(tenant_id, role_name)` y `(tenant_id, role_name, dimension, area)` con área `*`.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'surtidor';
const CLAVES = ['COMMERCIAL_PICKING_VER', 'COMMERCIAL_PICKING_GESTIONAR', 'ALMACEN_UBICACIONES_VER', 'SERVICIO_REPORTAR'];
/** Si el rol trae cualquiera de éstas, el surtidor deja de entrar directo a Surtir. */
const QUITAN_LA_ENTRADA_DIRECTA = ['ALMACEN_PEDIDOS_VER', 'ALMACEN_SURTIDO_COORDINAR'];
const ALCANCE = {
  brand: 'none',
  customer: 'none',
  expense_area: 'none',
  route: 'none',
  warehouse: 'own',
  zone: 'own',
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: tenants } = await knex.raw(
    `SELECT id, slug FROM identity.tenants WHERE deleted_at IS NULL ORDER BY slug`,
  );
  if (!tenants.length) throw new Error('No hay tenants en identity.tenants.');

  const permisos = JSON.stringify(Object.fromEntries(CLAVES.map((k) => [k, true])));
  for (const t of tenants) {
    await knex.raw(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES (?, ?, ?::jsonb)
       ON CONFLICT (tenant_id, role_name) DO UPDATE
         SET permissions = role_permissions.permissions || ?::jsonb,
             updated_at = now()`,
      [t.id, ROL, permisos, permisos],
    );
    for (const [dimension, mode] of Object.entries(ALCANCE)) {
      await knex.raw(
        `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, area, mode, values)
         VALUES (?, ?, ?, '*', ?, NULL)
         ON CONFLICT (tenant_id, role_name, dimension, area) DO UPDATE
           SET mode = EXCLUDED.mode, values = NULL, updated_at = now()`,
        [t.id, ROL, dimension, mode],
      );
    }
    console.log(`  ✓ [${t.slug}] rol ${ROL}: ${CLAVES.length} claves + alcance a su sucursal (6 dimensiones).`);
  }

  // ── Gates ─────────────────────────────────────────────────────────────────────────────────
  // (a) Las 6 dimensiones quedaron en cada tenant y ninguna en 'all'.
  const { rows: dims } = await knex.raw(
    `SELECT dimension, mode FROM identity.role_scopes WHERE role_name = ? AND area = '*' ORDER BY dimension`,
    [ROL],
  );
  if (dims.length < Object.keys(ALCANCE).length * tenants.length) {
    throw new Error(`El rol ${ROL} quedo con ${dims.length} reglas de alcance; se esperaban ${Object.keys(ALCANCE).length * tenants.length}.`);
  }
  const abiertas = dims.filter((r) => r.mode === 'all').map((r) => r.dimension);
  if (abiertas.length) throw new Error(`El rol ${ROL} quedo con alcance 'all' en: ${abiertas.join(', ')}`);

  // (b) Informa, no falla: si alguien le puso a mano el Tablero o la Consola, el surtidor ya no
  //     entra directo a Surtir. Quitarle una clave a mano es decisión de quien administra.
  const { rows: extra } = await knex.raw(
    `SELECT DISTINCT e.k FROM identity.role_permissions rp, jsonb_each(rp.permissions) e(k, v)
      WHERE rp.role_name = ? AND v = 'true'::jsonb AND e.k = ANY(?::text[])`,
    [ROL, QUITAN_LA_ENTRADA_DIRECTA],
  );
  if (extra.length) {
    console.log(`  ⚠️ ${ROL} trae ${extra.map((r) => r.k).join(', ')}: aterriza en el Tablero, no directo en Surtir.`);
  }

  const { rows: cuentas } = await knex.raw(
    `SELECT count(*)::int n FROM identity.users WHERE role_name = ? AND deleted_at IS NULL`,
    [ROL],
  );
  console.log(`  Cuentas con el rol ${ROL} como perfil base: ${cuentas[0].n}. Deben volver a entrar.`);
};

/**
 * Sólo retira el ALCANCE. Los permisos los pudo haber dado una persona desde /admin/roles (así
 * nació el rol en prod), y borrarlos dejaría a los surtidores sin pantalla. Sin alcance el rol
 * vuelve a ser fail-closed, que es exactamente como estaba antes del `up`.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DELETE FROM identity.role_scopes WHERE role_name = ? AND area = '*'`, [ROL]);
  console.log(`[GP.3c.5] alcance del rol ${ROL} retirado (los permisos se conservan).`);
};
