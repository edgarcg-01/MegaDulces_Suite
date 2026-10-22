'use strict';
/**
 * `[MCP.3.11]` Reparte `COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR` («Cambiar sucursal de surtido de ruta»)
 * a `supervisor_ventas`.
 *
 * Pedido de David (2026-10-22), en «Cartera de ventas › Asignar rutas › Configurar»: el supervisor de
 * ruta debe poder elegir de qué sucursal se surte la ruta de su vendedor. Hasta hoy el endpoint
 * (`PUT /commercial/vendor-routes/routes/:id/warehouse`) pedía `COMMERCIAL_CARTERA_GESTIONAR`, que es
 * administrar TODA la cartera y que `supervisor_ventas` no tiene. Se creó una clave acotada en vez de
 * darle la grande (ADR-054: el permiso es una clave).
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · prod, 2026-10-22: `supervisor_ventas` = 5 personas activas, `COMMERCIAL_CARTERA_GESTIONAR` en
 *    false; es el perfil de los puestos «Supervisor de Ventas Vecinal» y «… Ruta Directa»
 *    (docs/MATRIZ_ACCESOS.md). El recorte por tipo de ruta lo pone el PUESTO, no el perfil: el
 *    servicio llama a `routeScope().assert(ruta)`, así que el vecinal sólo toca vecinales.
 *
 * ⚠️ Lo que mueve esa sucursal, además de lo que ve el vendedor: la tienda a la que reporta el
 *    arqueo de la ruta (`blind-count.service.ts`, SM.36) y la sucursal del alta de sus clientes
 *    nuevos (`new-customers-kepler.service.ts`). Avisar a Edgar ANTES de aplicarla en prod.
 *
 * ⚠️ Sólo hace UPDATE y no crea ningún objeto de esquema: la compuerta del despliegue la clasifica
 *    NO_MEDIDO y FRENA a todo el equipo hasta que alguien la aplique a mano. Aplicala ANTES de mergear.
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB). Si
 * alguien ya la puso en `false` a mano, no se le pisa — y se DECLARA quién quedó sin ella.
 *
 * Después de aplicarla, las personas tienen que volver a entrar: los permisos viajan en el JWT
 * (el servidor ya los lee frescos de la DB; la pantalla, del token).
 *
 * @param { import("knex").Knex } knex
 */
const KEY = 'COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR';
const ROLES = ['supervisor_ventas'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ANY(?)
        AND role_name NOT LIKE 'retirado%'
        AND permissions -> ?::text IS NULL`,
    [KEY, ROLES, KEY],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE role_name = ANY(?) AND permissions -> ?::text = 'true'::jsonb
      ORDER BY role_name`,
    [ROLES, KEY],
  );
  const con = rows.map((r) => r.role_name);
  const faltan = ROLES.filter((r) => !con.includes(r));
  // Un UPDATE de 0 filas se ve igual que «ya estaba»: se DECLARA quién quedó sin la clave.
  console.log(
    `[grant_sucursal_de_ruta_supervisor] ${KEY}: ${res.rowCount ?? 0} fila(s) · con la clave: [${con.join(', ') || 'NINGUNO'}]`
    + (faltan.length ? ` · ⚠️ SIN la clave (rol inexistente o en false a mano): [${faltan.join(', ')}]` : ''),
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita la clave sólo donde quedó en `true`. */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions - ?::text
      WHERE role_name = ANY(?) AND permissions -> ?::text = 'true'::jsonb`,
    [KEY, ROLES, KEY],
  );
};
