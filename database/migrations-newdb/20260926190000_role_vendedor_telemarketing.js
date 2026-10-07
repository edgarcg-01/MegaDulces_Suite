'use strict';
/**
 * `[RBAC.TLMK.1]` — Perfil propio para el VENDEDOR de telemarketing.
 *
 * ── Lo medido en prod (2026-09-26) ───────────────────────────────────────────
 * El rol `telemarketing` (37 permisos) lo comparten 4 personas con trabajos
 * distintos: 1 vendedor (`vendedor_tlmk`), 1 coordinadora y 2 facturadoras. El
 * vendedor recibía el paquete completo, que incluye:
 *   - ESCRIBIR precios de toda la empresa (`COMMERCIAL_PRICING_GESTIONAR`),
 *     promociones, metas de sell-out, catálogo y reasignar rutas ajenas;
 *   - VER margen/rentabilidad, cartera de todos los clientes (Wincaja), ventas
 *     de otros vendedores (sell-out por vendedor, ventas por ruta) y el chat de
 *     Thot en perfil ADMIN (todo el tenant);
 *   - disparar jobs de administración (sync Kepler, refresh de analítica,
 *     customer-360 de TODOS los tenants).
 * Además tenía `warehouse_code` vacío, y como el alcance del rol es
 * `warehouse: own`, las facturas y tickets le salían VACÍOS (own con la ficha
 * vacía = `WHERE false`, `[ID.26]`).
 *
 * ── Qué hace ─────────────────────────────────────────────────────────────────
 *   1. Crea `vendedor_telemarketing` con SOLO lo que usan sus pantallas
 *      (medido contra `app.routes.ts` y los servicios que llaman al backend):
 *        /telemarketing/*           → TELEVENTA_VER + TELEVENTA_OPERATE (guard)
 *        /telemarketing/cotizaciones → QUOTES_VER / QUOTES_GESTIONAR
 *        tomar pedido               → CUSTOMERS_VER (getCustomer), PRICING_VER
 *                                     (price-lists + prices), ORDERS_VER/CREAR/
 *                                     CONFIRMAR (draft, líneas, confirmar)
 *        /comercial/documentos      → SALES_DOCS_VER (sus facturas TM)
 *   2. Le copia el ALCANCE de `telemarketing` (6 dimensiones). No se inventa
 *      uno nuevo: cambiar permisos y alcance a la vez haría imposible saber cuál
 *      de los dos rompió algo.
 *   3. El puesto `vendedor_tlmk` apunta al perfil nuevo (`default_role`). Hoy
 *      sólo lo ocupa 1 persona, así que no le mueve el acceso a nadie más.
 *   4. Sergio Mendoza (`sergio_mendoza`, único `vendedor_tlmk`) pasa al perfil
 *      nuevo con sucursal `01` (código + id, como las otras 13 personas de la 01),
 *      y se le revocan las sesiones para que su menú viejo no quede en el token.
 *      Autorizado por Francisco López (2026-09-26). Sólo se aplica si la ficha
 *      sigue como se midió: si alguien ya la editó desde /admin/users, no se pisa.
 *
 * ── Lo que NO resuelve (queda declarado) ─────────────────────────────────────
 *   - `PRICING_VER` es necesario para tomar pedido y HOY también devuelve
 *     `cost_base`: `stripCostIfCustomer` sólo recorta para `customer_b2b`.
 *     Quitarle el costo al vendedor es cambio de código, no de permisos.
 *   - "Sólo lo mío" no lo exige el servidor: cotizaciones, clientes y pedidos
 *     devuelven todo el tenant salvo que el cliente mande `?mine`, y el detalle
 *     por id no revisa dueño. Las facturas quedan acotadas a la SUCURSAL 01, no
 *     al vendedor `10002`: no existe el vínculo usuario ↔ vendedor Kepler.
 *   - `telemarketing` NO se toca: la coordinadora y las facturadoras siguen
 *     igual hasta revisar qué usan.
 *
 * Idempotente: re-correrla no duplica ni pisa ajustes hechos desde /admin/roles.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'vendedor_telemarketing';
const ROL_ORIGEN = 'telemarketing';
const PUESTO = 'vendedor_tlmk';
const USUARIO = 'sergio_mendoza';
const SUCURSAL = '01';

const PERMISOS = [
  'COMMERCIAL_TELEVENTA_VER',
  'COMMERCIAL_TELEVENTA_OPERATE',
  'COMMERCIAL_QUOTES_VER',
  'COMMERCIAL_QUOTES_GESTIONAR',
  'COMMERCIAL_SALES_DOCS_VER',
  'COMMERCIAL_CUSTOMERS_VER',
  'COMMERCIAL_PRICING_VER',
  'COMMERCIAL_ORDERS_VER',
  'COMMERCIAL_ORDERS_CREAR',
  'COMMERCIAL_ORDERS_CONFIRMAR',
];

const NOTA = '[RBAC.TLMK.1] copiado de telemarketing: vendedor TLMK';

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').pluck('id');

  for (const tenant of tenants) {
    const origen = await knex('identity.role_permissions')
      .where({ tenant_id: tenant, role_name: ROL_ORIGEN })
      .whereNull('deleted_at')
      .first('role_name');
    if (!origen) continue; // Tenant sin telemarketing: nada que partir.

    // ── 1. El perfil ──
    const existe = await knex('identity.role_permissions')
      .where({ tenant_id: tenant, role_name: ROL })
      .first('role_name', 'deleted_at');
    if (!existe) {
      const mapa = {};
      for (const p of PERMISOS) mapa[p] = true;
      await knex('identity.role_permissions').insert({
        tenant_id: tenant,
        role_name: ROL,
        permissions: JSON.stringify(mapa),
        kind: 'perfil',
      });
      console.log(`  [RBAC.TLMK.1] perfil "${ROL}" creado con ${PERMISOS.length} permisos`);
    } else if (existe.deleted_at) {
      await knex('identity.role_permissions')
        .where({ tenant_id: tenant, role_name: ROL })
        .update({ deleted_at: null });
      console.log(`  [RBAC.TLMK.1] perfil "${ROL}" reactivado (permisos sin tocar)`);
    }

    // ── 2. El alcance, copiado del rol de origen ──
    const alcance = await knex('identity.role_scopes')
      .where({ tenant_id: tenant, role_name: ROL_ORIGEN })
      .select('dimension', 'mode', 'values', 'mode_write');
    for (const r of alcance) {
      await knex('identity.role_scopes')
        .insert({ tenant_id: tenant, role_name: ROL, ...r, nota: NOTA })
        .onConflict(['tenant_id', 'role_name', 'dimension'])
        .ignore();
    }

    // ── 3. El puesto apunta al perfil nuevo ──
    await knex('identity.positions')
      .where({ tenant_id: tenant, code: PUESTO, default_role: ROL_ORIGEN })
      .update({ default_role: ROL });

    // ── 4. La persona ──
    const almacen = await knex('commercial.warehouses')
      .where({ tenant_id: tenant, code: SUCURSAL })
      .whereNull('deleted_at')
      .first('id');
    const n = await knex('identity.users')
      .where({ tenant_id: tenant, username: USUARIO, role_name: ROL_ORIGEN, position_code: PUESTO })
      .whereNull('deleted_at')
      .whereNull('warehouse_code')
      .update({
        role_name: ROL,
        warehouse_code: SUCURSAL,
        warehouse_id: almacen ? almacen.id : null,
        sessions_revoked_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    console.log(
      n
        ? `  [RBAC.TLMK.1] ${USUARIO} → ${ROL}, sucursal ${SUCURSAL}, sesiones revocadas`
        : `  [RBAC.TLMK.1] ${USUARIO}: la ficha ya no está como se midió; no se toca`,
    );
  }
};

exports.down = async function down(knex) {
  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    await knex('identity.users')
      .where({ tenant_id: tenant, username: USUARIO, role_name: ROL, warehouse_code: SUCURSAL })
      .update({ role_name: ROL_ORIGEN, warehouse_code: null, warehouse_id: null, updated_at: knex.fn.now() });
    await knex('identity.positions')
      .where({ tenant_id: tenant, code: PUESTO, default_role: ROL })
      .update({ default_role: ROL_ORIGEN });

    const quedan = await knex('identity.users')
      .where({ tenant_id: tenant, role_name: ROL })
      .whereNull('deleted_at')
      .count({ n: '*' })
      .first();
    if (Number(quedan.n) > 0) continue; // Alguien más lo usa: no se borra.
    await knex('identity.user_roles').where({ tenant_id: tenant, role_name: ROL }).del();
    await knex('identity.role_scopes').where({ tenant_id: tenant, role_name: ROL }).del();
    await knex('identity.role_permissions').where({ tenant_id: tenant, role_name: ROL }).del();
  }
};
