'use strict';
/**
 * `[VEC.10]` — **Se retiran las filas que dejó el importer vecinal, ya sin lectores.**
 *
 * `[VEC.0]` retiró `import-kepler-vecinal-routes.js` y la venta pasó a derivarse del ODS, pero lo
 * que ese importer había escrito **siguió en las tablas**: un monto **2.07×** el real, con líneas
 * de otras cajas. No es basura inofensiva — es la cifra vieja esperando a que alguien la lea.
 *
 *     analytics.sales_by_route_monthly        23 filas   $9,164,175.91
 *     analytics.route_push_lines         103,394 líneas  $9,152,046.92
 *
 * ⛔ **No se borró antes a propósito.** Al ir a hacerlo aparecieron **tres lectores** que todavía
 * las usaban, y borrar con ellos vivos les habría quitado datos **en silencio** — menos filas, sin
 * un solo error:
 *
 *   · `salesByRouteTops`  — el Top de productos y clientes de la MISMA pantalla cuyo total ya
 *     estaba corregido. Es el caso que más duele: la matriz decía la verdad y el Top de abajo
 *     seguía mintiendo.
 *   · `routeFilterOptions` — los combos de producto y cliente, que ofrecían SKUs que esa ruta
 *     nunca vendió.
 *   · `thot_sales_by_route` — la herramienta con la que Thot responde preguntas de dinero.
 *
 * Los tres se migraron a la fuente derivada en el mismo cambio que trae esta migración. Recién
 * entonces las filas quedan sin lectores, y recién entonces se borran.
 *
 * ── Lo que NO se toca, y por qué el patrón alcanza ──────────────────────────────────────────
 *
 *   · `WIN-VEC-PH-H` (18 filas, $10,762,292.88) — el histórico de Wincaja, **otra fuente** y la
 *     única que cubre ene–jun. Su `route_no` empieza con letra, así que `^[0-9]V[0-9]` no lo toca.
 *   · Las camionetas (124,670 líneas, $12,819,800.07) — `route_no` numérico, tampoco matchea.
 *
 * El borrado se verifica contra esas dos poblaciones **después** de ejecutarse: si alguna perdió
 * una sola fila, la migración aborta y revierte. Un `DELETE` que se pasó de la raya no avisa solo.
 *
 * ⚠️ `wincaja.branches` conserva sus 4 filas de ruta vecinal. Son **catálogo**, no venta, y el
 * servicio ya no depende de ellas para esta pierna (resuelve por la vista). Borrarlas sería un
 * segundo cambio con otro riesgo, y se deja declarado.
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';
const RX = '^[0-9]V[0-9]';

exports.up = async function up(knex) {
  const censo = async () => (await knex.raw(
    `SELECT
       (SELECT count(*) FROM analytics.sales_by_route_monthly
         WHERE tenant_id = ? AND COALESCE(route_no,'') ~ ?)::int AS mensual_vecinal,
       (SELECT count(*) FROM analytics.route_push_lines
         WHERE tenant_id = ? AND COALESCE(route_no,'') ~ ?)::int AS lineas_vecinal,
       (SELECT count(*) FROM analytics.sales_by_route_monthly
         WHERE tenant_id = ? AND route_code LIKE '%VEC-PH-H%')::int AS historico,
       (SELECT count(*) FROM analytics.route_push_lines
         WHERE tenant_id = ? AND COALESCE(route_no,'') ~ '^[0-9]+$')::int AS camionetas`,
    [T, RX, T, RX, T, T])).rows[0];

  const antes = await censo();
  console.log('[VEC.10] antes:', JSON.stringify(antes));

  await knex.raw(
    `DELETE FROM analytics.route_push_lines WHERE tenant_id = ? AND COALESCE(route_no,'') ~ ?`,
    [T, RX]);
  await knex.raw(
    `DELETE FROM analytics.sales_by_route_monthly WHERE tenant_id = ? AND COALESCE(route_no,'') ~ ?`,
    [T, RX]);

  const despues = await censo();
  console.log('[VEC.10] después:', JSON.stringify(despues));

  if (despues.mensual_vecinal !== 0 || despues.lineas_vecinal !== 0) {
    throw new Error(`[VEC.10] quedaron filas del importer: ${JSON.stringify(despues)}`);
  }
  // El freno que importa: lo que NO debía tocarse sigue intacto, al número.
  if (despues.historico !== antes.historico) {
    throw new Error(`[VEC.10] el histórico Wincaja perdió filas: ${antes.historico} → ${despues.historico}`);
  }
  if (despues.camionetas !== antes.camionetas) {
    throw new Error(`[VEC.10] las camionetas perdieron líneas: ${antes.camionetas} → ${despues.camionetas}`);
  }
};

exports.down = async function down() {
  // Sin vuelta: lo borrado lo escribía un importer que ya no existe, y la venta que representaba
  // se deriva del ODS en vivo. Reponerlo sería volver a publicar la cifra inflada.
};
