'use strict';
/**
 * `[RD.17]` — **El universo de la comision deja de ser una lista tecleada del Excel.**
 *
 * ── El defecto, por inspeccion ──────────────────────────────────────────────────────────────
 * `CommercialCommissionsService.computeRun()` itera sobre `commercial.commission_route_config`,
 * trece filas sembradas a mano desde `INDICADORES RD 2026.xlsx`. Todo lo que vende y no esta en
 * esa lista **no genera linea, no genera advertencia y no aparece en ningun lado**. Y el KPI de
 * la pantalla publica "13 de 13 rutas" porque su denominador es la lista, no el dato: una
 * cobertura que sale completa por construccion.
 *
 * Medido contra prod el 2026-10-07: **9 route_code venden en `analytics.v_rd_route_daily` y no
 * estan en la config** (1V001-1V004, 2V001, 2V003, 2V005, 3V001, VEC-PH-H), **$9,367,131 de
 * subtotal en 2026**. Y al reves: **321 dejo de tener fuente el 2026-06-02, 322 el 2026-07-01 y
 * 505 el 2026-09-10**, o sea que tres de las trece configuradas llevan meses sin dato.
 *
 * ── ⭐ No hace falta inventar nada: las dos respuestas ya estan derivadas en prod ────────────
 *
 *   `analytics.mv_rd_route_identity`  (RD.9/RD.15) — las **11 rutas con camion**, derivadas de
 *       `commercial.warehouses` por PK y de `analytics.transfer_dest_map` por FK, cero `VALUES`.
 *       Dice que una ruta EXISTE sin preguntarle a la venta, que es justo lo que hacia falta
 *       para no confundir "no vendio" con "no existe".
 *   `trade.catalogs.route_kind`       (VEC.1, 2026-10-06) — que TIPO es cada ruta
 *       (vecinal | camion | telemarketing | mayoreo | piso). Las nueve que se caian son
 *       **vecinales**: venden del almacen madre, no son camion con stock, y por eso no estan
 *       en el resolvedor. Legitimamente fuera de la comision de Ruta Directa -- pero eso hay
 *       que **decirlo**, no dejarlo pasar en silencio.
 *
 * Esta vista las junta y le pone nombre a cada caso. **Nadie se cae: todo route_code que exista
 * en cualquiera de las tres fuentes sale con su veredicto.**
 *
 * ── Por que la union de llaves NO toca `v_rd_route_daily` ────────────────────────────────────
 * Seria la fuente obvia para "quien vende", y cuesta **36.9 s** medidos (es una vista sobre otra
 * vista que se materializa entera en cada consulta; lo documenta la migracion de
 * `mv_rd_route_daily_200d`). El universo se arma con las dos TABLAS que estan debajo:
 * `analytics.route_push_lines` y `wincaja.branches`. Mismo conjunto, sin el escaneo.
 *
 * ── ⛔ `comisiona` NO cae a `true` por omision ───────────────────────────────────────────────
 * Una ruta nueva no entra a la nomina sola. `veredicto` tiene un valor para cada forma de quedar
 * fuera, y `tipo_sin_declarar` es la que le toca a lo que nadie clasifico todavia: se ve, se
 * puede contar, y no paga. Es la misma regla que VEC.1 fijo para `route_kind` (ADR-056).
 *
 * Vista, no tabla: derive-no-copy. `security_invoker` para que respete el RLS de quien consulta.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_rd_commission_universe';

const SQL = `
CREATE OR REPLACE VIEW ${VIEW} WITH (security_invoker = true) AS
WITH llaves AS (
  -- Las tres procedencias de "esta ruta existe". UNION (no ALL) = el conjunto.
  SELECT tenant_id, route_no AS route_code FROM analytics.mv_rd_route_identity
  UNION
  SELECT tenant_id, route_code FROM commercial.commission_route_config WHERE deleted_at IS NULL
  UNION
  -- ⛔ "Lo que vende" sale de la matvista de 200 dias, NO de route_push_lines ni de
  -- wincaja.branches. Medido el 2026-10-07: esas dos legs devuelven 18 de las 22 rutas y pierden
  -- las cuatro vecinales de Kepler (2V001, 2V003, 2V005, 3V001), que entran por una TERCERA
  -- fuente (kepler_vecinal, agregada por VEC.1 el 2026-10-06) y no viven en ninguna de las dos.
  -- Perderlas seria exactamente el defecto que esta vista existe para cerrar.
  -- ⚠️ La ventana son 200 dias: una ruta que dejo de vender antes entra por la config o por el
  -- resolvedor, que no caducan. Cuesta 11 ms contra los 36.9 s de la vista viva.
  SELECT tenant_id, route_code FROM analytics.mv_rd_route_daily_200d
), ident AS (
  SELECT tenant_id, route_no, plaza, almacen_erp, suc_emisor, carga_desde, warehouse_id
    FROM analytics.mv_rd_route_identity
), cfg AS (
  SELECT tenant_id, route_code, nomina_banco, chofer_nombre, supervisor_nombre, zona, activo
    FROM commercial.commission_route_config WHERE deleted_at IS NULL
), kind AS (
  -- El tipo de ruta vive en trade.catalogs (VEC.1). Se une por DOS vocabularios porque la
  -- misma tabla nombra a los camiones por numero ("RUTA 21" / "21") y a las vecinales por su
  -- codigo de vendedor del ERP ("1V001"). Unir por uno solo pierde la mitad del catalogo.
  -- ⚠️ Sin \\s y sin signo de interrogacion en el regex: los dos fallan MUDOS en esta base
  -- (VEC.1 lo midio: 0 de 29 contra 16).
  SELECT tc.tenant_id,
         coalesce(
           nullif(regexp_replace(btrim(tc.value), '^[Rr][Uu][Tt][Aa] *', ''), ''),
           btrim(tc.erp_vendor_code)
         )                                   AS route_code,
         btrim(tc.erp_vendor_code)           AS erp_vendor_code,
         max(tc.route_kind)                  AS route_kind
    FROM trade.catalogs tc
   WHERE tc.catalog_id = 'rutas' AND tc.deleted_at IS NULL
   GROUP BY 1, 2, 3
), kind_dos_llaves AS (
  -- Una ruta puede entrar por su numero ("21") y por su codigo ERP ("1V001"): se indexa por
  -- las dos.
  SELECT tenant_id, route_code, route_kind FROM kind WHERE route_code IS NOT NULL
  UNION ALL
  SELECT tenant_id, erp_vendor_code, route_kind FROM kind WHERE erp_vendor_code IS NOT NULL
), kind_por_codigo AS (
  -- ⚠️ El GROUP BY va DESPUES del UNION, no dentro de cada rama. Con un UNION de dos selects
  -- ya agrupados, un route_code que entra por las dos llaves con route_kind distinto deja DOS
  -- filas, y el LEFT JOIN de abajo multiplica la ruta -- que en esta vista significa cobrarla
  -- dos veces. Una llave, una fila.
  -- (sin acentos graves en este bloque: es un template literal de JS y lo terminarian)
  SELECT tenant_id, route_code, max(route_kind) AS route_kind
    FROM kind_dos_llaves GROUP BY 1, 2
)
SELECT
  l.tenant_id,
  l.route_code,

  -- De donde se sabe que existe. Las tres son hechos distintos y se publican los tres.
  (i.route_no    IS NOT NULL)                        AS en_identidad,
  (c.route_code  IS NOT NULL)                        AS en_config,
  coalesce(c.activo, false)                          AS config_activa,

  k.route_kind,
  i.plaza,
  coalesce(i.plaza, c.zona)                          AS plaza_o_zona,
  i.almacen_erp,
  i.suc_emisor,
  i.carga_desde,
  i.warehouse_id,
  c.nomina_banco,
  c.chofer_nombre,
  c.supervisor_nombre,

  -- ⭐ El veredicto: por que esta ruta paga comision, o por que no. Nunca un booleano pelado,
  -- porque "no paga" tiene cuatro causas distintas y se arreglan en lugares distintos.
  CASE
    WHEN c.route_code IS NOT NULL AND c.activo                 THEN 'comisiona'
    WHEN c.route_code IS NOT NULL AND NOT c.activo             THEN 'config_inactiva'
    WHEN k.route_kind IS NOT NULL AND k.route_kind <> 'camion' THEN 'fuera_no_es_camion'
    WHEN i.route_no   IS NOT NULL                              THEN 'camion_sin_config'
    WHEN k.route_kind = 'camion'                               THEN 'camion_sin_identidad'
    ELSE 'tipo_sin_declarar'
  END                                                AS veredicto,

  -- Lo que de verdad decide, derivado del veredicto. Falso por omision, siempre.
  (c.route_code IS NOT NULL AND c.activo)            AS comisiona

FROM llaves l
LEFT JOIN ident           i ON i.tenant_id = l.tenant_id AND i.route_no   = l.route_code
LEFT JOIN cfg             c ON c.tenant_id = l.tenant_id AND c.route_code = l.route_code
LEFT JOIN kind_por_codigo k ON k.tenant_id = l.tenant_id AND k.route_code = l.route_code
`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
  // ⚠️ `security_invoker` y el GRANT van EXPLICITOS despues de cada CREATE OR REPLACE: no se
  // heredan. ADR-057 los perdio una vez y solo lo vio la asercion de metadata del candado.
  await knex.raw(`ALTER VIEW ${VIEW} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VIEW} IS $$[RD.17] El universo de la comision de Ruta
Directa, DERIVADO -- no la lista de 13 filas tecleada del Excel. Junta las tres procedencias de
"esta ruta existe": el resolvedor mv_rd_route_identity (11 camiones, por PK y FK), la config de
nomina, y lo que de verdad vende (route_push_lines + wincaja.branches). Cada route_code sale con
su veredicto: comisiona / config_inactiva / fuera_no_es_camion / camion_sin_config /
camion_sin_identidad / tipo_sin_declarar. Existe porque el motor iteraba la config y las 9 rutas
vecinales que venden ($9.37M en 2026) se caian sin linea y sin aviso, mientras el KPI publicaba
"13 de 13 rutas" por tener a la lista de denominador. comisiona NUNCA cae a true por omision.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
