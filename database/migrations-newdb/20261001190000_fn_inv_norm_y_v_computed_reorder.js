'use strict';
/**
 * `[RA-DYN.P4.2]` — **RETIRAR EL IMPORTER: la inversa normal y el reorden, en SQL.**
 *
 * ── Por qué este archivo existe ─────────────────────────────────────────────────────────────
 * La regla principal del proyecto es CERO importers, y TODO el camino del factor de pedido está
 * del lado equivocado: `reorder_policy`, `inventory_health`, `replenishment_plan`,
 * `product_demand` y `demand_acceleration` son tablas escritas por script.
 *
 * Pero medido, `import-computed-reorder.js` casi no es un importer: son **177 líneas que ejecutan
 * UNA sola sentencia** (un `INSERT ... SELECT`, línea 74). La fórmula —`ceil(Z × σ × √lead)`, el
 * piso por clase, la cesión de pares al DRP— **ya es SQL**. El envoltorio de JS existía por
 * exactamente dos razones:
 *
 *   1. **Leer variables de entorno** (`RA_SERVICE_A/B/C`, `REORDER_LEAD_DEFAULT`, …). Un `.env`
 *      sólo lo puede leer un proceso. → **Lo resolvió `commercial.replenishment_params`**
 *      (mig 20261001170000): una tabla sí la puede leer SQL.
 *   2. **Calcular la inversa normal en JavaScript** — 13 líneas, y duplicadas palabra por palabra
 *      en `import-computed-reorder.js:48-60` e `import-network-reorder.js:33-43`. → **Lo resuelve
 *      `analytics.fn_inv_norm` de acá**, que de paso mata una de las cinco familias de constantes
 *      duplicadas a mano que ADR-056 lleva anotadas como deuda.
 *
 * ── ⛔ ESTE COMMIT NO CAMBIA NINGÚN NÚMERO PUBLICADO ────────────────────────────────────────
 * Sólo **agrega** una función y una vista. Nadie las consume todavía: `commercial.reorder_policy`
 * la siguen escribiendo los mismos importers, con los mismos valores. El switch es un commit
 * aparte, y antes tiene que pasar el cruce de las DOS implementaciones (ver abajo).
 *
 * ── Cómo se prueba que la vista dice lo mismo que el importer ───────────────────────────────
 * No se verifica la vista contra sí misma —eso pasa bugs en verde— sino contra la salida del
 * importer que ya corrió: `commercial.reorder_policy` donde `source = 'computed'`. Son dos
 * implementaciones independientes del mismo cálculo (una en JS+SQL, otra en SQL puro) y tienen
 * que coincidir fila por fila. El candado vive en
 * `database/tests/test-newdb-computed-reorder-paridad.js`.
 *
 * ── ⚠️ UNA DIVERGENCIA DELIBERADA CON EL JS, Y ES UNA MEJORA ────────────────────────────────
 * `invNorm` de JavaScript abre con `if (p <= 0 || p >= 1) return 0;`. O sea que un nivel de
 * servicio de 1.0 —el que se lee como «servicio perfecto»— devuelve **Z = 0**, y
 * `ceil(0 × σ × √lead)` es **colchón CERO**, sin error ni aviso: el valor hace exactamente lo
 * contrario de lo que aparenta.
 *
 * `fn_inv_norm` **LANZA** en ese caso en vez de devolver 0. Es una función matemática pura cuyo
 * dominio es (0,1); devolver un número fuera de él es dibujar un cero donde no hay medición
 * (ADR-056). El `CHECK rp_service_rango` de `replenishment_params` ya impide que esos valores
 * lleguen, así que la excepción es defensa en profundidad, no un camino esperado.
 */

exports.up = async function up(knex) {
  /*
   * Inversa de la normal estándar — algoritmo de Acklam, |error relativo| < 1.15e-9.
   * Transcripción literal de `import-computed-reorder.js:48-60`, mismos coeficientes.
   * IMMUTABLE: para los mismos insumos devuelve siempre lo mismo, así el planificador puede
   * evaluarla una vez y no por fila.
   */
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.fn_inv_norm(p double precision)
    RETURNS double precision
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $fn$
    DECLARE
      a double precision[] := ARRAY[-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
                                     1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
      b double precision[] := ARRAY[-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
                                     6.680131188771972e+01, -1.328068155288572e+01];
      c double precision[] := ARRAY[-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
                                    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
      d double precision[] := ARRAY[7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
                                    3.754408661907416e+00];
      plow  double precision := 0.02425;
      phigh double precision := 1 - 0.02425;
      q double precision; r double precision;
    BEGIN
      -- ⛔ El JS devolvia 0 aca, y 0 es el colchon mas bajo posible: el valor que se lee como
      -- "servicio perfecto" apagaba el inventario de seguridad en silencio. Se declara, no se dibuja.
      IF p <= 0 OR p >= 1 THEN
        RAISE EXCEPTION 'analytics.fn_inv_norm: p debe estar en (0,1), recibido %', p
          USING HINT = 'un nivel de servicio de 1.0 daria Z=0, o sea colchon CERO';
      END IF;
      IF p < plow THEN
        q := sqrt(-2 * ln(p));
        RETURN (((((c[1]*q+c[2])*q+c[3])*q+c[4])*q+c[5])*q+c[6])
             / ((((d[1]*q+d[2])*q+d[3])*q+d[4])*q+1);
      END IF;
      IF p <= phigh THEN
        q := p - 0.5; r := q*q;
        RETURN (((((a[1]*r+a[2])*r+a[3])*r+a[4])*r+a[5])*r+a[6])*q
             / (((((b[1]*r+b[2])*r+b[3])*r+b[4])*r+b[5])*r+1);
      END IF;
      q := sqrt(-2 * ln(1 - p));
      RETURN -(((((c[1]*q+c[2])*q+c[3])*q+c[4])*q+c[5])*q+c[6])
            / ((((d[1]*q+d[2])*q+d[3])*q+d[4])*q+1);
    END $fn$`);
  console.log('  [RA-DYN.P4.2] analytics.fn_inv_norm creada');

  // Control de exactitud DENTRO de la migración: si los coeficientes se transcribieron mal, la
  // migración falla acá y no seis semanas después en un colchón silenciosamente distinto.
  const esperados = [[0.975, 1.959964], [0.98, 2.053749], [0.95, 1.644854], [0.90, 1.281552]];
  for (const [p, z] of esperados) {
    const got = Number((await knex.raw(`SELECT analytics.fn_inv_norm(?) AS z`, [p])).rows[0].z);
    if (Math.abs(got - z) > 1e-5) {
      throw new Error(`[RA-DYN.P4.2] fn_inv_norm(${p}) = ${got}, se esperaba ≈ ${z}`);
    }
  }
  console.log('  [RA-DYN.P4.2] fn_inv_norm verificada contra 4 valores conocidos');

  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.fn_inv_norm(double precision) TO app_runtime`);

  /*
   * La política computada, DERIVADA. Reproduce exactamente el `INSERT ... SELECT` de
   * `import-computed-reorder.js:74-158`, con dos cambios y ninguno es de cálculo:
   *   · los 10 parámetros enlazados salen de `commercial.replenishment_params` (la versión vigente)
   *   · Z sale de `analytics.fn_inv_norm`, no de JavaScript
   *
   * El filtro de topología (NOT EXISTS) se conserva palabra por palabra: excluye el PAR
   * (almacén, producto) que planea import-network-reorder, no el almacén entero — la diferencia
   * medida en prod son 2,801 filas que si no quedarían sin dueño.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_computed_reorder AS
    WITH par AS (
      SELECT DISTINCT ON (rp.tenant_id)
             rp.tenant_id, rp.id AS params_version,
             rp.service_a, rp.service_b, rp.service_c,
             rp.lead_default_days, rp.cycle_days, rp.safety_floor_days,
             analytics.fn_inv_norm(rp.service_a::double precision) AS z_a,
             analytics.fn_inv_norm(rp.service_b::double precision) AS z_b,
             analytics.fn_inv_norm(rp.service_c::double precision) AS z_c
        FROM commercial.replenishment_params rp
       WHERE rp.valid_from <= now()
       ORDER BY rp.tenant_id, rp.valid_from DESC
    ), base AS (
      SELECT ih.tenant_id, ih.warehouse_id, ih.product_id, ih.avg_daily_units AS adu,
             COALESCE(ih.stddev_daily_units,0) AS sigma, ih.demand_cv, ih.xyz_class,
             COALESCE(s.lead_time_days, par.lead_default_days) AS lead,
             COALESCE(abc.abc_class, 'C') AS abc_class,
             par.service_a, par.service_b, par.service_c,
             par.z_a, par.z_b, par.z_c,
             par.safety_floor_days, par.cycle_days, par.params_version
        FROM analytics.inventory_health ih
        JOIN par ON par.tenant_id = ih.tenant_id
        JOIN catalog.products p ON p.tenant_id = ih.tenant_id AND p.id = ih.product_id
        LEFT JOIN catalog.suppliers s ON s.tenant_id = ih.tenant_id AND s.id = p.supplier_id
        LEFT JOIN analytics.v_abc_class abc
               ON abc.tenant_id = ih.tenant_id AND abc.warehouse_id = ih.warehouse_id
              AND abc.product_id = ih.product_id
       WHERE ih.avg_daily_units > 0
         AND NOT EXISTS (
           SELECT 1
             FROM commercial.warehouses n
             JOIN analytics.inventory_health ihc
               ON ihc.tenant_id = ih.tenant_id AND ihc.warehouse_id = n.id
              AND ihc.product_id = ih.product_id AND ihc.avg_daily_units > 0
            WHERE n.tenant_id = ih.tenant_id AND n.source_warehouse_id = ih.warehouse_id
              AND n.deleted_at IS NULL)
    ), calc AS (
      SELECT tenant_id, warehouse_id, product_id, lead, abc_class, demand_cv, xyz_class, adu,
             params_version,
             CASE abc_class WHEN 'A' THEN service_a WHEN 'B' THEN service_b ELSE service_c END AS service_level,
             GREATEST(
               ceil( (CASE abc_class WHEN 'A' THEN z_a WHEN 'B' THEN z_b ELSE z_c END) * sigma * sqrt(lead) ),
               CASE WHEN abc_class IN ('A','B') THEN ceil(adu * safety_floor_days) ELSE 0 END
             )::numeric AS safety,
             ceil(adu * lead)::numeric       AS lead_demand,
             ceil(adu * cycle_days)::numeric AS cycle_demand
        FROM base
    )
    SELECT tenant_id, warehouse_id, product_id,
           safety                                   AS min_stock,
           lead_demand + safety                     AS reorder_point,
           lead_demand + safety + cycle_demand      AS max_stock,
           lead                                     AS lead_time_days,
           safety                                   AS safety_stock,
           service_level, abc_class, xyz_class, demand_cv,
           'service_level'::text                    AS policy_method,
           params_version
      FROM calc`);
  console.log('  [RA-DYN.P4.2] analytics.v_computed_reorder creada');

  // ⚠️ security_invoker + GRANT van EXPLÍCITOS y no se heredan (lección U.7): un
  // CREATE OR REPLACE sobre una vista con RLS detrás los pierde en silencio.
  await knex.raw(`ALTER VIEW analytics.v_computed_reorder SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_computed_reorder TO app_runtime`);

  const opts = (await knex.raw(
    `SELECT unnest(reloptions)::text o FROM pg_class WHERE oid='analytics.v_computed_reorder'::regclass`)).rows;
  if (!opts.some((x) => String(x.o).includes('security_invoker'))) {
    throw new Error('[RA-DYN.P4.2] v_computed_reorder perdió security_invoker');
  }

  await knex.raw(`
    COMMENT ON VIEW analytics.v_computed_reorder IS
    '[RA-DYN.P4.2] La politica de reorden COMPUTADA, derivada en vez de importada. Reproduce el '
    'INSERT...SELECT de import-computed-reorder.js leyendo los parametros de '
    'commercial.replenishment_params (version vigente) y la Z de analytics.fn_inv_norm, en vez de '
    'variables de entorno y JavaScript. NADIE LA CONSUME TODAVIA: el switch es un commit aparte y '
    'antes tiene que pasar el cruce fila por fila contra commercial.reorder_policy source=computed, '
    'que es la salida de la OTRA implementacion -- una vista verificada contra si misma pasa bugs '
    'en verde. params_version viaja en cada fila para que una politica se pueda explicar con los '
    'parametros que la produjeron.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_computed_reorder`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.fn_inv_norm(double precision)`);
  console.log('  [RA-DYN.P4.2] vista y función eliminadas');
};
