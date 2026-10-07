/**
 * `analytics.v_route_plaza` — resolvedor CANÓNICO ruta→plaza (camioneta → sucursal padre).
 *
 * Por qué (Fase RS, robustez sobre heurística): el layout "Por plaza" del sell-out agrupaba las rutas
 * por el PRIMER DÍGITO del número (`RUTAS LA PIEDAD`=1, `RUTAS MORELIA`=2/3, `RUTAS CANINDO`=5) — un
 * parche frágil que atribuía MAL las camionetas de PH (RUTA-21..28, que son de La Piedad/PH) a Morelia
 * (dígito 2), y dejaba `RUTAS LA PIEDAD` vacía (no existe ninguna RUTA-1xx). El vínculo REAL vive en
 * `wincaja.branches`: cada ruta trae `parent_branch`, y cada sucursal padre trae su `kepler_code` /
 * `warehouse_code` (el almacén de la plataforma). Un self-join lo resuelve 100% desde datos — cero mapa
 * hardcodeado, y una camioneta nueva mapea sola en cuanto entra a `wincaja.branches`.
 *
 * Verificado 2026-09-10: RUTA-21..28→01 PADRE HIDALGO · RUTA-321/322→07 MORELIA MADERO ·
 * RUTA-501..505→06 CANINDO. Lo consumen `plazaColKey` (layout plaza) y `expandRouteWarehouses`
 * (filtro por-sucursal) — una sola fuente para los dos.
 *
 * `security_invoker` para que respete permisos del que consulta (lee wincaja.branches, sin RLS).
 * Idempotente (CREATE OR REPLACE VIEW). @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_plaza
      WITH (security_invoker = true) AS
      SELECT rt.tenant_id,
             'RUTA-' || btrim(rt.source_branch)                                   AS route_warehouse_code,
             btrim(rt.parent_branch)                                              AS parent_branch,
             COALESCE(NULLIF(btrim(pb.kepler_code), ''), NULLIF(btrim(pb.warehouse_code), '')) AS parent_warehouse_code,
             pb.branch_name                                                       AS parent_name
        FROM wincaja.branches rt
        JOIN wincaja.branches pb
          ON pb.tenant_id = rt.tenant_id
         AND btrim(pb.source_branch) = btrim(rt.parent_branch)
         AND pb.is_route = false
       WHERE rt.is_route = true
         AND btrim(rt.source_branch) ~ '^[0-9]+$'
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_route_plaza TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_route_plaza IS
    'RS: resolvedor canónico ruta→plaza (RUTA-NN → sucursal padre) derivado de wincaja.branches (parent_branch + kepler_code/warehouse_code). Reemplaza la heurística de primer-dígito. Lo usan plazaColKey y expandRouteWarehouses.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_plaza`);
};
