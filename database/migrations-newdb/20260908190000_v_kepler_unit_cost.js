/**
 * `analytics.v_kepler_unit_cost` — EL COSTO UNITARIO DE KEPLER, en UN solo lugar.
 *
 * Sale de `KE.1`: la existencia de Kepler tiene que valuarse con el costo del MISMO ERP y del
 * MISMO almacén que la cantidad (`kdik.c16`, grano sucursal × SKU). En KE.1 ese cálculo vivía
 * dentro de `analytics.v_erp_stock_truth`. Ahora lo van a leer DOS consumidores — esa vista y la
 * pantalla de existencia (`existencia.service.ts`) — y un primitivo con dos implementaciones es
 * un primitivo que va a divergir (ADR-056: un mecanismo no cierra hasta vivir en un solo lugar).
 * Así que se extrae acá y las dos lo LEEN.
 *
 * Lo que aporta sobre `kepler_ods.kdik`:
 *   · el filtro `sucursal = c1`, que cambia el resultado: **3,667 de 31,084 filas** quedan fuera.
 *     Probado en negativo: sin el filtro el valor arbitrado del inventario se mueve **$864,270** y
 *     592 filas se caen de `confirmado`.
 *     ⚠️ **La etiqueta "es el costo de OTRA sucursal" está REFUTADA** (revisión KX, 2026-09-09).
 *     Las 3,667 filas son TODAS de la sucursal 03, casi todas del almacén `02`, y contra
 *     suc02/alm02 sólo el **3.66%** tiene entradas acumuladas idénticas: **1,049 SKUs van por
 *     DELANTE** —una réplica no adelanta al original— y **645 sólo existen en la 03**. En `kdil`
 *     son **90,630 unidades de existencia que no publicamos**. Qué es ese almacén sigue **sin
 *     establecerse**: hace falta preguntarle a operaciones si 8ESQ opera bodega en Abastos. Se
 *     declara como hueco con monto en `docs/VERDAD_ABSOLUTA.md` §7, no se afirma como réplica.
 *   · el grano traducido a nuestras llaves (`warehouse_id`, `product_id`), para que nadie tenga
 *     que volver a acordarse de que en `kdik` el SKU es **`c2`** y el almacén es `c1`.
 *   · el guard de valor de `c16`.
 *
 * ⛔ EL GUARD DE `c16` NO PUEDE SER UN REGEX, y el motivo quedó medido en KE.1: un `?` dentro de un
 * `knex.raw` se toma como placeholder de binding. El primer intento guardó
 * `'^-$1[0-9]+(\.[0-9]+)$2([eE][+-]$3[0-9]+)$4$'` y **no falló** — no matcheó nada, y la vista
 * devolvió `sin_testigo` en las 16,453 filas, que se lee igual que "Kepler no tiene costo". En el
 * ODS `c16` ya es `double precision`, así que el guard correcto es de VALOR: `c16 = c16` es falso
 * sólo para NaN y las cotas descartan los infinitos (los tres revientan el cast a numeric).
 *
 * ⚠️ Verificado: cero pares duplicados por (sucursal, almacén, SKU), así que el `max()` no está
 * eligiendo entre valores rivales — es un agregado de una sola fila.
 *
 * ⚠️ Re-aplicar `security_invoker` y el `GRANT` después de cada `CREATE OR REPLACE` (lección U.7).
 *
 * @param { import("knex").Knex } knex
 */

// Guard de VALOR, sin regex y sin `?` (ver la nota de arriba).
const C16 = `CASE WHEN k.c16 = k.c16
                   AND k.c16 > '-Infinity'::float8
                   AND k.c16 < 'Infinity'::float8
              THEN k.c16::numeric END`;

const COST = `
CREATE OR REPLACE VIEW analytics.v_kepler_unit_cost AS
WITH kk AS (
  -- kdik: c1 = almacen, c2 = SKU, c16 = costo unitario PROMEDIO PONDERADO HISTORICO.
  -- Probado: c8/c5 = c16, y c5 == entradas acumuladas de kdil.c8 en 25,143 de 25,143 (100.00%).
  -- El filtro deja fuera 3,667 filas (todas de la suc 03, almacen 02). NO esta probado que sean
  -- replica: ver la nota de arriba y VERDAD_ABSOLUTA.md 7.
  SELECT k.sucursal        AS kepler_code,
         btrim(k.c2::text) AS sku,
         max(${C16})       AS costo_unitario
    FROM kepler_ods.kdik k
   WHERE k.sucursal = btrim(k.c1::text)
   GROUP BY 1, 2
)
SELECT w.tenant_id,
       w.id            AS warehouse_id,
       w.kepler_code,
       p.id            AS product_id,
       p.sku,
       kk.costo_unitario
  FROM kk
  JOIN commercial.warehouses w
    ON w.kepler_code = kk.kepler_code AND w.deleted_at IS NULL
  JOIN catalog.products p
    ON p.tenant_id = w.tenant_id AND p.sku::text = kk.sku AND p.deleted_at IS NULL
 WHERE kk.costo_unitario IS NOT NULL AND kk.costo_unitario > 0
`;

// `v_erp_stock_truth` deja de re-derivar el costo y lo LEE de la vista nueva. Mismo resultado,
// una sola implementacion. (Se re-crea completa porque CREATE OR REPLACE no admite cambiar de
// donde sale una columna sin re-escribir el cuerpo.)
const TRUTH = `
CREATE OR REPLACE VIEW analytics.v_erp_stock_truth AS
SELECT s.tenant_id,
       s.warehouse_id,
       s.warehouse_code,
       w.kepler_code,
       s.product_id,
       s.sku,
       p.nombre,
       s.qty_stock_units                                   AS qty,
       kc.costo_unitario                                   AS costo_kepler,
       p.cost_base                                         AS costo_catalogo,
       COALESCE(p.cost_with_tax, p.cost_base)              AS costo_publicado_hoy,
       CASE WHEN COALESCE(kc.costo_unitario, 0) > 0 AND COALESCE(p.cost_base, 0) > 0
            THEN round(p.cost_base / kc.costo_unitario, 4) END AS razon,
       CASE
         WHEN COALESCE(kc.costo_unitario, 0) <= 0                       THEN 'sin_testigo'
         WHEN COALESCE(p.cost_base, 0)       <= 0                       THEN 'sin_costo_catalogo'
         WHEN abs(p.cost_base / kc.costo_unitario - 1) <= 0.02          THEN 'confirmado'
         WHEN p.cost_base / kc.costo_unitario >= 1.5                    THEN 'contradicho_por_factor'
         WHEN p.cost_base / kc.costo_unitario <= 0.667                  THEN 'contradicho_por_factor'
         ELSE                                                                'precio_movido'
       END                                                 AS veredicto,
       CASE
         WHEN COALESCE(kc.costo_unitario, 0) > 0 AND COALESCE(p.cost_base, 0) > 0
          AND (p.cost_base / kc.costo_unitario >= 1.5 OR p.cost_base / kc.costo_unitario <= 0.667)
         THEN round(p.cost_base / kc.costo_unitario, 2)
       END                                                 AS factor_aparente,
       CASE WHEN COALESCE(kc.costo_unitario, 0) > 0
            THEN round(s.qty_stock_units * kc.costo_unitario, 2) END AS valor_arbitrado,
       round(s.qty_stock_units * COALESCE(p.cost_with_tax, p.cost_base, 0), 2) AS valor_publicado_hoy,
       CASE WHEN COALESCE(kc.costo_unitario, 0) > 0
            THEN round(s.qty_stock_units * COALESCE(p.cost_with_tax, p.cost_base, 0)
                     - s.qty_stock_units * kc.costo_unitario, 2) END AS brecha
  FROM analytics.v_erp_stock_on_hand s
  JOIN commercial.warehouses w
    ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
  JOIN catalog.products p
    ON p.tenant_id = s.tenant_id AND p.id = s.product_id
  LEFT JOIN analytics.v_kepler_unit_cost kc
    ON kc.tenant_id = s.tenant_id AND kc.warehouse_id = s.warehouse_id
   AND kc.product_id = s.product_id
 WHERE s.source = 'kepler_ods'
`;

exports.up = async function up(knex) {
  await knex.raw(COST);
  await knex.raw(`ALTER VIEW analytics.v_kepler_unit_cost SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_unit_cost TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_kepler_unit_cost IS
    'KE.2: el costo unitario propio de Kepler (kdik.c16) por almacen x producto, con el anti-replica aplicado. UNICA implementacion: la leen v_erp_stock_truth y la pantalla de existencia.'`);

  await knex.raw(TRUTH);
  await knex.raw(`ALTER VIEW analytics.v_erp_stock_truth SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_truth TO app_runtime`);

  // ── Auto-verificacion: la extraccion NO puede cambiar el resultado ──
  for (const v of ['v_kepler_unit_cost', 'v_erp_stock_truth']) {
    const m = await knex.raw(
      `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='analytics' AND c.relname=?`, [v]);
    const o = (m.rows[0] || {}).reloptions || [];
    if (!o.some((x) => String(x).includes('security_invoker'))) throw new Error(`${v} perdio security_invoker`);
  }
  const cost = (await knex.raw(`SELECT count(*)::int n FROM analytics.v_kepler_unit_cost`)).rows[0].n;
  if (cost < 10000) throw new Error(`v_kepler_unit_cost trae ${cost} filas: el join no esta resolviendo`);
  const r = (await knex.raw(
    `SELECT veredicto, count(*)::int filas FROM analytics.v_erp_stock_truth
      WHERE qty > 0 GROUP BY 1 ORDER BY 1`)).rows;
  const by = Object.fromEntries(r.map((x) => [x.veredicto, x.filas]));
  // Lo medido en KE.1 ANTES de extraer el primitivo: confirmado 11,917 · contradicho 273.
  //
  // ⚠️ CON TOLERANCIA, Y LA RAZON IMPORTA. El primer intento exigia `=== 11917` exacto y fallo
  // con 11,918. No era la extraccion: verificado con las DOS definiciones lado a lado, hay
  // **cero filas con veredicto distinto**. Lo que cambio fue el DATO — `kdil` y `kdik` los
  // refresca el shipper del ODS todo el tiempo, asi que entre la medicion de KE.1 y esta corrida
  // una fila mas paso a confirmado. Fijar una cifra VIVA al entero es una carrera, no un candado
  // (misma leccion que en la paridad de K.3). La banda del 1% detecta que la extraccion rompio
  // algo sin castigar el latido del ODS.
  const band = (got, ref, label) => {
    if (Math.abs(got - ref) > Math.max(ref * 0.01, 5)) {
      throw new Error(`${label}=${got}, KE.1 midio ${ref} (fuera de la banda del 1%): la extraccion cambio el resultado`);
    }
  };
  band(by.confirmado || 0, 11917, 'confirmado');
  band(by.contradicho_por_factor || 0, 273, 'contradicho_por_factor');
  console.log(`  [kepler-unit-cost] ${cost.toLocaleString('en-US')} filas de costo`
    + ` · confirmado ${(by.confirmado || 0).toLocaleString('en-US')} (KE.1: 11,917)`
    + ` · contradicho ${by.contradicho_por_factor || 0} (KE.1: 273)`);
};

exports.down = async function down(knex) {
  // No se revierte `v_erp_stock_truth` a su version con el CTE embebido: seria volver a tener
  // dos implementaciones del mismo costo.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_stock_truth`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_unit_cost`);
};
