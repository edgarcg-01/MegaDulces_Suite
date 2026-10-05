'use strict';
/**
 * `[RD.27]` — **El resolvedor de costo y precio, materializado.**
 *
 * `[RD.26]` dejó la vista `analytics.v_rd_route_unit_value`, que es correcta y la cuenta cierra.
 * Lo que no cierra es el reloj: medida contra prod, **la consulta real del servicio pasó de 163
 * a 667 ms** — el resolvedor une el ledger con las tres filas de escalera de `kepler_ods.kdii`
 * por cada producto, y eso se paga en cada carga de la pantalla.
 *
 * El límite de esta casa es medio segundo y no es negociable, así que el resolvedor se
 * materializa. Es el mismo movimiento que `[RD.14]` hizo con la identidad de las rutas por la
 * misma razón, y el que la fase ya tiene montado: `mv_rd_route_ledger` se refresca cada 30 min
 * y este objeto entra en esa misma pasada.
 *
 * ⛔ **No es una copia de datos: es la misma derivación, guardada.** La vista sigue siendo la
 * definición; la matvista es su resultado. Si divergen, manda la vista — por eso el candado
 * compara las dos en periodo cerrado.
 *
 * ⚠️ Una matvista **no soporta `security_invoker` ni RLS** (limitación de Postgres, ya
 * documentada en la Fase C). Por eso todo consumidor filtra `tenant_id` explícitamente, igual
 * que con las otras dos matvistas de esta fase.
 *
 * El índice único es obligatorio para `REFRESH CONCURRENTLY`: sin él, el refresco toma un lock
 * exclusivo y la pantalla se queda esperando justo cuando alguien la está mirando.
 */

const MV = 'analytics.mv_rd_route_unit_value';

exports.up = async function up(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS
                  SELECT * FROM analytics.v_rd_route_unit_value`);
  // La llave natural del resolvedor. Unica por construccion: la vista agrupa por estas cuatro.
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_rd_route_unit_value
                    ON ${MV} (tenant_id, route_no, sku, unidad)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW ${MV} IS $$[RD.27] El resolvedor de costo y precio de ruta
    (v_rd_route_unit_value), materializado: la consulta del servicio pasaba de 163 a 667 ms con
    la vista en vivo y el limite de la casa son 500. Se refresca con el ciclo de analytics cada
    30 min. La vista sigue siendo la definicion; esto es su resultado.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
