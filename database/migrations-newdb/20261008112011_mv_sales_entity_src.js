/**
 * [PU.V5] `analytics.mv_sales_entity_src` — las tuplas crudas del catálogo de entidades de venta.
 *
 * ── Por qué, con la cifra que lo obliga ────────────────────────────────────────────────────
 *
 * Después de [PU.V1]–[PU.V3], `/sales-comparison` seguía **sobre el gate**. Medido contra prod el
 * 2026-10-08, consulta por consulta del código ya desplegado:
 *
 *     1. budget.budgets                        3 ms
 *     2. analytics.v_sales_entity            659 ms   <-- 97 % del total
 *     3. budget.sales_plan_lines              12 ms
 *     4. mv_sellout_budget_rollup (el real)    3 ms
 *     5. frescura                              2 ms
 *                                           ------
 *                                            679 ms   contra un gate de 500 ms
 *
 * ⭐ O sea: el sell-out ya no es el problema —son 3 ms—, y el cuello pasó a ser el **catálogo**.
 * Su CTE `crudo` hace `SELECT DISTINCT tenant_id, source, channel, warehouse_code, branch_name`
 * sobre `mv_sellout_monthly`, que son **444 MB al grano producto × mes**, para devolver **63
 * filas**. Un índice no sirve: es un `DISTINCT` global, no un filtro.
 *
 * Esta MV son esas 63 filas. **No es una definición nueva**: es ese mismo `DISTINCT`,
 * materializado, y `v_sales_entity` sigue siendo la única definición de qué es una entidad.
 *
 * ── Lo que esto cambia, dicho ──────────────────────────────────────────────────────────────
 *
 * ⚠️ El catálogo pasa a ser un snapshot nocturno: una sucursal o un canal que aparezca HOY en el
 *    sell-out no sale en la pantalla hasta mañana. Para un catálogo de plazas —que cambia dos o
 *    tres veces al año— es el precio correcto, pero es un cambio de frescura y va declarado.
 *
 * ⛔ **ORDEN, y no es cosmético:** `mv_sellout_budget_rollup` **lee `v_sales_entity`** (verificado:
 *    es la única vista de `analytics` que la consume). Si esta MV se refrescara DESPUÉS del
 *    rollup, el rollup de hoy se armaría con el catálogo de ayer. En el lote nocturno va
 *    declarada **entre** `mv_sellout_monthly` (su fuente) y `mv_sellout_budget_rollup` (su
 *    consumidor), con `deps` en la primera.
 *
 * ⚠️ `v_sales_entity` **sí tiene `security_invoker=true`** (verificado en `pg_class.reloptions`,
 *    a diferencia de `v_sellout_vs_facturacion`). Un `CREATE OR REPLACE VIEW` **no lo conserva**,
 *    ni conserva los GRANT: los dos se vuelven a aplicar acá. Es una trampa ya vivida en ADR-057.
 *
 * ⚠️ Alcance medido antes de tocar: `v_sales_entity` la leen **3 servicios**, los tres de
 *    Presupuestos (`budget-sales-comparison`, `budget-sales-indicators`, `budget-sales-plan`),
 *    más `mv_sellout_budget_rollup`. No es un objeto de uso general.
 *
 * @param { import("knex").Knex } knex
 */

const MV = `
CREATE MATERIALIZED VIEW analytics.mv_sales_entity_src AS
SELECT DISTINCT m0.tenant_id, m0.source, m0.channel, m0.warehouse_code, m0.branch_name,
       now() AS refreshed_at
  FROM analytics.mv_sellout_monthly m0`;

/** `v_sales_entity`, idéntica salvo de dónde sale `crudo`. */
const VISTA = `
CREATE OR REPLACE VIEW analytics.v_sales_entity AS
WITH crudo AS (
  SELECT tenant_id, source, channel, warehouse_code, branch_name
    FROM analytics.mv_sales_entity_src
), ent AS (
  SELECT DISTINCT c.tenant_id,
         COALESCE(cm.canonical_channel, c.channel) AS channel,
         COALESCE(cm.label, initcap(c.channel))    AS channel_label,
         c.warehouse_code,
         c.branch_name
    FROM crudo c
    LEFT JOIN analytics.sellout_channel_map cm
      ON cm.tenant_id = c.tenant_id AND cm.source = c.source AND cm.raw_channel = c.channel
)
SELECT e.tenant_id,
       (e.channel || ':') || e.warehouse_code::text AS entity_key,
       e.channel,
       e.channel_label,
       CASE WHEN e.channel = 'ruta' THEN 'ruta' ELSE 'sucursal_canal' END AS entity_type,
       e.warehouse_code,
       e.branch_name,
       CASE WHEN e.warehouse_code::text LIKE 'RUTA-%' THEN SUBSTRING(e.warehouse_code FROM 6) END AS route_code,
       crc.zona AS route_zona,
       w.zone_id
  FROM ent e
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id = e.tenant_id AND w.code::text = e.warehouse_code::text AND w.deleted_at IS NULL
  LEFT JOIN commercial.commission_route_config crc
    ON crc.tenant_id = e.tenant_id AND e.warehouse_code::text LIKE 'RUTA-%'
   AND crc.route_code::text = SUBSTRING(e.warehouse_code FROM 6) AND crc.deleted_at IS NULL`;

/** La versión anterior, leyendo el espejo mensual directo. Sólo para `down`. */
const VISTA_VIEJA = VISTA.replace(
  `  SELECT tenant_id, source, channel, warehouse_code, branch_name
    FROM analytics.mv_sales_entity_src`,
  `  SELECT DISTINCT tenant_id, source, channel, warehouse_code, branch_name
    FROM analytics.mv_sellout_monthly`);

/** Fotografía comparable de la vista: todas sus columnas, ordenadas. */
const FOTO = `SELECT * FROM analytics.v_sales_entity ORDER BY tenant_id, entity_key`;

exports.up = async function up(knex) {
  // ── ANTES: la vista entera, para exigir paridad EXACTA después ───────────────────────────
  const t0 = Date.now();
  const antes = (await knex.raw(FOTO)).rows;
  const msAntes = Date.now() - t0;

  const ya = (await knex.raw(`SELECT to_regclass('analytics.mv_sales_entity_src') t`)).rows[0].t;
  if (!ya) {
    await knex.raw(MV);
    // UNIQUE: requisito de `REFRESH ... CONCURRENTLY`. La llave es la tupla entera porque eso ES
    // el DISTINCT; `branch_name` entra porque un almacén puede venir con nombre distinto por rama.
    await knex.raw(`CREATE UNIQUE INDEX mv_sales_entity_src_pk
                      ON analytics.mv_sales_entity_src (tenant_id, source, channel, warehouse_code, branch_name)`);
    await knex.raw(`ANALYZE analytics.mv_sales_entity_src`);
  }
  await knex.raw(`GRANT SELECT ON analytics.mv_sales_entity_src TO app_runtime`);

  await knex.raw(VISTA);
  // ⚠️ Las dos líneas que `CREATE OR REPLACE VIEW` NO conserva, y que si se olvidan no fallan:
  //    la vista sigue funcionando para `postgres` y deja de funcionar para `app_runtime`, o peor,
  //    deja de aplicar RLS en las tablas que lee. Lección de ADR-057.
  await knex.raw(`ALTER VIEW analytics.v_sales_entity SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_sales_entity TO app_runtime`);

  // ── Candados ─────────────────────────────────────────────────────────────────────────────
  // (a) ⭐ PARIDAD EXACTA. Cambiar de dónde sale `crudo` no puede mover una sola fila ni un solo
  //     valor: es el MISMO DISTINCT. Si cambia algo, cambié otra cosa sin querer.
  const t1 = Date.now();
  const despues = (await knex.raw(FOTO)).rows;
  const msDespues = Date.now() - t1;
  if (antes.length !== despues.length) {
    throw new Error(`v_sales_entity pasó de ${antes.length} a ${despues.length} filas: no es el mismo catálogo`);
  }
  const norm = (rs) => JSON.stringify(rs.map((r) => Object.keys(r).sort().map((k) => `${k}=${r[k]}`).join('|')));
  if (norm(antes) !== norm(despues)) {
    throw new Error('v_sales_entity devuelve filas DISTINTAS tras el cambio: la paridad no se cumple');
  }

  // (b) Metadata que el REPLACE se come en silencio.
  const meta = (await knex.raw(`
    SELECT (SELECT array_to_string(reloptions, ',') FROM pg_class
             WHERE oid = 'analytics.v_sales_entity'::regclass) AS opts,
           has_table_privilege('app_runtime', 'analytics.v_sales_entity', 'SELECT') AS puede_vista,
           has_table_privilege('app_runtime', 'analytics.mv_sales_entity_src', 'SELECT') AS puede_mv`)).rows[0];
  if (!/security_invoker=true/.test(meta.opts || '')) {
    throw new Error(`v_sales_entity perdió security_invoker (reloptions = ${meta.opts})`);
  }
  if (meta.puede_vista !== true || meta.puede_mv !== true) {
    throw new Error('app_runtime no puede leer la vista y/o la matvista');
  }

  // (c) ⭐ PRUEBA NEGATIVA DEL GATE: si no bajó del gate real, esta migración no sirve de nada.
  if (msDespues >= 500) {
    throw new Error(
      `v_sales_entity tardó ${msDespues} ms: sigue sobre el gate de 500 ms, o sea que no está `
      + `leyendo mv_sales_entity_src`);
  }

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sales_entity_src IS '${(
    `[PU.V5] Las tuplas crudas (tenant, source, channel, warehouse_code, branch_name) del catalogo `
    + `de entidades. Es el CTE "crudo" de v_sales_entity materializado tal cual -- misma fuente, `
    + `cero definiciones nuevas. Existe porque ese DISTINCT barria los 444 MB de mv_sellout_monthly `
    + `para devolver 63 filas, y dejaba /sales-comparison en 679 ms (659 de ellos aqui) contra un `
    + `gate de 500. ORDEN: se refresca DESPUES de mv_sellout_monthly y ANTES de `
    + `mv_sellout_budget_rollup, que lee v_sales_entity. Job analytics_refresh_sales_entity.`
  ).replace(/'/g, "''")}'`);

  console.log(
    `  [mv_sales_entity_src] ${despues.length} entidades · v_sales_entity ${msAntes} ms → ${msDespues} ms `
    + `· paridad exacta fila por fila`);
};

exports.down = async function down(knex) {
  await knex.raw(VISTA_VIEJA);
  await knex.raw(`ALTER VIEW analytics.v_sales_entity SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_sales_entity TO app_runtime`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_entity_src CASCADE`);
};
