'use strict';
/**
 * `[EMB.56]` — Rol `chofer` y la clave `LOGISTICS_GUIA_REPARTO_VER`: el chofer imprime su hoja de ruta.
 *
 * La guía de reparto la imprime y la lleva el chofer, y el chofer NO cobra (sólo el vendedor). El PM
 * aprobó el 2026-11-09 un rol `chofer` con UN solo permiso: ver e imprimir las guías de reparto de su
 * sucursal (FASE_EMB §8).
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · Matriz de accesos (generada 2026-11-04): el puesto «Chofer» no tiene rol propuesto ni personas
 *    con acceso a la Suite. Este rol es la casa; darles usuario es acto de la sucursal / RH.
 *  · La lista de viajes de Logística (`/logistica/shipments`) la usa `coordinador_embarques`
 *    (13 de 30 días en `analytics.ui_usage`, 2026-11-09). No se toca.
 *
 * ── Qué deja ─────────────────────────────────────────────────────────────────────────────────
 *  · Rol `chofer`: SÓLO `LOGISTICS_GUIA_REPARTO_VER`, con alcance a su sucursal y su zona; ni
 *    clientes, ni marcas, ni rutas, ni áreas de gasto (calca a `surtidor`). Se SUMA a lo que tenga
 *    la fila (`||`): no se le quita nada que alguien le haya puesto a mano.
 *  · La misma clave a todo rol que YA tiene `LOGISTICS_SHIPMENTS_VER` en true: esos roles ya ven el
 *    viaje con más datos (costo, comisión); la guía es un subconjunto SIN dinero, así que no se
 *    abre nada que no vieran. Sin esto, quien coordina no podría reimprimirle la guía al chofer.
 *
 * ⚠️ Sólo hace INSERT/UPDATE y no crea ningún objeto de esquema: la compuerta del despliegue la
 *    clasifica NO_MEDIDO y FRENA a todo el equipo hasta que alguien la aplique a mano. Aplicala
 *    ANTES de mergear.
 *
 * Idempotente: UPSERT por `(tenant_id, role_name)` y `(tenant_id, role_name, dimension, area)`.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'chofer';
const CLAVE = 'LOGISTICS_GUIA_REPARTO_VER';
const QUIEN_YA_VE_EL_VIAJE = 'LOGISTICS_SHIPMENTS_VER';
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

  const permiso = JSON.stringify({ [CLAVE]: true });
  for (const t of tenants) {
    await knex.raw(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES (?, ?, ?::jsonb)
       ON CONFLICT (tenant_id, role_name) DO UPDATE
         SET permissions = role_permissions.permissions || ?::jsonb,
             updated_at = now()`,
      [t.id, ROL, permiso, permiso],
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

    // Quien ya ve el viaje entero recibe la guía (subconjunto sin dinero). Sólo donde la clave
    // falta: `permissions -> 'KEY' IS NULL`, no el operador `?` (knex no lo escapa).
    const { rows: suman } = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE tenant_id = ? AND role_name <> ?
          AND permissions -> ? = 'true'::jsonb
          AND permissions -> ? IS NULL
        RETURNING role_name`,
      [permiso, t.id, ROL, QUIEN_YA_VE_EL_VIAJE, CLAVE],
    );
    console.log(`  ✓ [${t.slug}] rol ${ROL}: ${CLAVE} + alcance a su sucursal (6 dimensiones).`);
    console.log(`  ✓ [${t.slug}] ${CLAVE} a ${suman.length} rol(es) que ya ven embarques: ${suman.map((r) => r.role_name).join(', ') || '—'}`);
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

  // (b) La clave quedó OTORGADA (valor true), no sólo presente.
  const { rows: sinClave } = await knex.raw(
    `SELECT t.slug FROM identity.tenants t
      WHERE t.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM identity.role_permissions rp
         WHERE rp.tenant_id = t.id AND rp.role_name = ? AND rp.permissions -> ? = 'true'::jsonb)`,
    [ROL, CLAVE],
  );
  if (sinClave.length) throw new Error(`El rol ${ROL} quedo sin ${CLAVE} en: ${sinClave.map((r) => r.slug).join(', ')}`);

  // (c) Informa, no falla: el chofer debe tener sólo su guía. Si alguien le puso más a mano, se dice.
  const { rows: extra } = await knex.raw(
    `SELECT DISTINCT e.k FROM identity.role_permissions rp, jsonb_each(rp.permissions) e(k, v)
      WHERE rp.role_name = ? AND v = 'true'::jsonb AND e.k <> ?`,
    [ROL, CLAVE],
  );
  if (extra.length) console.log(`  ⚠️ ${ROL} trae además: ${extra.map((r) => r.k).join(', ')}`);

  const { rows: cuentas } = await knex.raw(
    `SELECT count(*)::int n FROM identity.users WHERE role_name = ? AND deleted_at IS NULL`,
    [ROL],
  );
  console.log(`  Cuentas con el rol ${ROL}: ${cuentas[0].n}. El item no se entrega hasta repartirlo a los choferes (regla 20).`);
};

/**
 * Retira la clave de los roles a los que el `up` se la sumó y el alcance del chofer. La fila del
 * rol `chofer` se conserva: si alguien la usó desde /admin/roles, borrarla dejaría cuentas sin
 * perfil. Sin alcance y sin la clave, el rol vuelve a ser fail-closed.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?, updated_at = now()
      WHERE permissions -> ? IS NOT NULL`,
    [CLAVE, CLAVE],
  );
  await knex.raw(`DELETE FROM identity.role_scopes WHERE role_name = ? AND area = '*'`, [ROL]);
  console.log(`[EMB.56] ${CLAVE} retirada y alcance del rol ${ROL} borrado (la fila del rol se conserva).`);
};
