'use strict';
/**
 * `[IC.20]` — EL DESGLOSE DEL ABC: POR QUÉ ESTE SKU ES A Y NO B.
 *
 * La pantalla `/almacen/inventory/abc` puede decir hoy **«es C»**, y con `clase_motivo` puede
 * decir **«es C por su lugar en el Pareto»**. Lo que no puede decir es **cuán cerca estuvo de ser
 * B**, ni **qué lugar ocupa**, ni **cuánto aporta**. Y no por falta de fuente: `v_abc_class` ya
 * calcula las piezas dentro de sus ventanas y **las tira**.
 *
 * Esta migración deja de tirarlas. No inventa un dato nuevo: **publica el que ya existe**.
 *
 * ── Lo que se agrega (las cuatro al FINAL, ver el candado de orden) ─────────────────────────
 *
 *  · `rango_almacen`      — el lugar dentro del almacén (`#12 de 4,494`)
 *  · `skus_en_almacen`    — el denominador de ese lugar, para que el número signifique algo
 *  · `aporte_individual`  — qué fracción del valor del almacén aporta ESTA fila
 *                           (`value_share` ya existe pero es el **acumulado**, otra pregunta)
 *  · `distancia_al_corte` — pesos de `annual_value` que la separan del **piso de su propia
 *                           clase**. Una sola pregunta para todas las filas: *¿está al borde o
 *                           está holgada?* Cerca de 0 = un cambio chico la mueve de clase.
 *
 * ⚠️ **Por qué `distancia_al_corte` es «al piso de su clase» y no «lo que le falta para subir»:**
 * serían **dos preguntas distintas según la clase** (una A sólo puede caer, una C sólo subir), y
 * meterlas en una columna es el `CASE` que le miente a una de las dos. Con esta definición la
 * columna significa lo mismo en las tres clases.
 *
 * ⚠️ Es una **aproximación declarada**: el Pareto es acumulativo, así que mover una fila re-ordena
 * a las demás. Dice *qué tan cerca del borde está hoy*, no *qué pasaría si cambiara*.
 *
 * ── Lo que NO se toca, y por qué ────────────────────────────────────────────────────────────
 *
 * ⛔ **La definición del Pareto no se mueve**: los cortes 0.80/0.95, el orden y el desempate por
 * `product_id` quedan idénticos. Esa clase **fija el nivel de servicio de todo el reabasto**
 * (`import-computed-reorder.js`: A=0.98 · B=0.95 · C=0.90); cambiarla acá movería la compra de
 * la red entera sin que nadie lo pidiera. El candado compara clase por clase contra la foto.
 *
 * ⛔ **Tampoco se cambia la fuente del costo.** `v_abc_class` lee `analytics.v_erp_unit_cost`
 * (la vista, 1,419 ms). Se midió que existe `mv_erp_unit_cost` y que en `v_abc_capital` el cambio
 * valió 5×, **pero acá sería otra cosa**: la matvista tiene su propia frescura, y una clase
 * calculada sobre un costo de ayer cambia **cuánto se compra**. Eso es una decisión de negocio
 * con su propia medición, no un efecto colateral de publicar cuatro columnas. **Declarado, no
 * hecho.**
 *
 * ── La foto también las recibe ──────────────────────────────────────────────────────────────
 *
 * `commercial.abc_classification` es la FOTO que consumen la cadencia de conteo cíclico y los
 * importers de reorden. Gana las cuatro columnas **más `tiene_testigo`**, que la vista ya calcula
 * y la tabla nunca guardó.
 *
 * ⚠️ Medido antes de afirmar nada: `tiene_testigo` y la lista de nombres a mano que hoy usa el
 * servicio (`costo_source IN ('kepler_kdik','wincaja_costo_promedio')`) **coinciden en las 30,059
 * filas — 0 discrepancias**. O sea que **no hay un bug vivo**: hay una fragilidad: un
 * `costo_source` nuevo con testigo quedaría fuera de la lista y la cobertura se subdeclararía en
 * silencio. Se migra a la columna por eso, no por un error medido.
 *
 * ⚠️ `security_invoker` + `GRANT` se re-aplican: un `CREATE OR REPLACE VIEW` **no los hereda**
 * (lección U.7), y acá se verifica en metadata.
 *
 * ⚠️ La guarda es **barata a propósito** — acotada a un almacén. La lección es de hoy mismo:
 * `[IC.21]` barrió la población entera dentro de su transacción y sostuvo el candado global de
 * migraciones **8 minutos**. Las aserciones sobre la población completa viven en el candado.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const SQL_VIEW = `
CREATE OR REPLACE VIEW analytics.v_abc_class AS
WITH base AS (
  SELECT ih.tenant_id,
         ih.warehouse_id,
         ih.product_id,
         ih.avg_daily_units,
         (ih.avg_daily_units * 365::numeric
            * COALESCE(uc.costo_unitario, 0::numeric))::numeric(16,2) AS annual_value,
         COALESCE(uc.costo_source, 'sin_costo'::text)                 AS costo_source,
         uc.tiene_testigo IS TRUE                                     AS tiene_testigo
    FROM analytics.inventory_health ih
    LEFT JOIN analytics.v_erp_unit_cost uc
           ON uc.tenant_id    = ih.tenant_id
          AND uc.warehouse_id = ih.warehouse_id
          AND uc.product_id   = ih.product_id
), ranked AS (
  SELECT base.*,
         sum(base.annual_value) OVER (
           PARTITION BY base.tenant_id, base.warehouse_id
           ORDER BY base.annual_value DESC, base.product_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)            AS cum_value,
         NULLIF(sum(base.annual_value) OVER (
           PARTITION BY base.tenant_id, base.warehouse_id), 0::numeric) AS total_value,
         sum(base.avg_daily_units) OVER (
           PARTITION BY base.tenant_id, base.warehouse_id)              AS adu_almacen,
         row_number() OVER (
           PARTITION BY base.tenant_id, base.warehouse_id
           ORDER BY base.annual_value DESC, base.product_id)            AS rango_almacen,
         count(*) OVER (
           PARTITION BY base.tenant_id, base.warehouse_id)              AS skus_en_almacen
    FROM base
), clasificado AS (
  SELECT ranked.*,
         CASE
           WHEN total_value IS NULL THEN 'C'::text
           WHEN ((cum_value - annual_value) / total_value) < 0.80 THEN 'A'::text
           WHEN ((cum_value - annual_value) / total_value) < 0.95 THEN 'B'::text
           ELSE 'C'::text
         END AS abc_class_calc
    FROM ranked
)
SELECT tenant_id,
       warehouse_id,
       product_id,
       abc_class_calc AS abc_class,
       CASE
         WHEN COALESCE(adu_almacen, 0::numeric) <= 0::numeric THEN 'sin_demanda'::text
         WHEN avg_daily_units > 0::numeric
              AND COALESCE(annual_value, 0::numeric) = 0::numeric     THEN 'sin_costo'::text
         ELSE 'pareto'::text
       END AS clase_motivo,
       annual_value,
       avg_daily_units,
       CASE
         WHEN total_value IS NULL THEN 1.0
         ELSE round(cum_value / total_value, 4)
       END AS value_share,
       costo_source,
       tiene_testigo,
       rango_almacen,
       skus_en_almacen,
       CASE WHEN total_value IS NOT NULL
            THEN round(annual_value / total_value, 6) END AS aporte_individual,
       (annual_value - min(annual_value) OVER (
          PARTITION BY tenant_id, warehouse_id, abc_class_calc))::numeric(16,2)
         AS distancia_al_corte
  FROM clasificado`;

const COLS_NUEVAS = [
  ['rango_almacen', (t) => t.integer('rango_almacen')],
  ['skus_en_almacen', (t) => t.integer('skus_en_almacen')],
  ['aporte_individual', (t) => t.decimal('aporte_individual', 12, 6)],
  ['distancia_al_corte', (t) => t.decimal('distancia_al_corte', 16, 2)],
  ['tiene_testigo', (t) => t.boolean('tiene_testigo')],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La vista: las cuatro columnas nuevas van al FINAL (CREATE OR REPLACE lo exige) ──
  const antes = (await knex.raw(
    `SELECT attname FROM pg_attribute
      WHERE attrelid = 'analytics.v_abc_class'::regclass AND attnum > 0 AND NOT attisdropped
      ORDER BY attnum`)).rows.map((r) => r.attname);

  await knex.raw(SQL_VIEW);
  await knex.raw(`ALTER VIEW analytics.v_abc_class SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_abc_class TO app_runtime`);

  const despues = (await knex.raw(
    `SELECT attname FROM pg_attribute
      WHERE attrelid = 'analytics.v_abc_class'::regclass AND attnum > 0 AND NOT attisdropped
      ORDER BY attnum`)).rows.map((r) => r.attname);

  // Las 10 de siempre, en su mismo lugar: cualquier consumidor por posicion sigue intacto.
  for (let i = 0; i < antes.length; i++) {
    if (antes[i] !== despues[i]) {
      throw new Error(`la columna ${i + 1} cambio de ${antes[i]} a ${despues[i]}: se rompe a los consumidores`);
    }
  }
  const agregadas = despues.slice(antes.length);
  const esperadas = ['rango_almacen', 'skus_en_almacen', 'aporte_individual', 'distancia_al_corte'];
  if (agregadas.join(',') !== esperadas.join(',')) {
    throw new Error(`se esperaban ${esperadas} al final y llegaron ${agregadas}`);
  }

  const opts = (await knex.raw(
    `SELECT unnest(c.reloptions) AS o
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_abc_class'`)).rows.map((r) => r.o);
  if (!opts.some((x) => String(x).includes('security_invoker'))) {
    throw new Error('v_abc_class perdio security_invoker');
  }

  // ── 2. La foto recibe las mismas, mas `tiene_testigo` que la vista ya calculaba ──
  for (const [nombre, agregar] of COLS_NUEVAS) {
    if (!(await knex.schema.withSchema('commercial').hasColumn('abc_classification', nombre))) {
      await knex.schema.withSchema('commercial').alterTable('abc_classification', agregar);
    }
  }

  // ── 3. Guarda ACOTADA a un almacen. La poblacion completa la prueba el candado, fuera
  //       de la transaccion: `[IC.21]` sostuvo el candado global 8 minutos por no hacer esto.
  //
  // ⛔ El primer intento de esta migracion FALLO aca, y la guarda tenia razon a medias: elegia
  //    el almacen con MENOS filas para que fuera barata, y el mas chico es el CEDIS (`00`), cuyas
  //    366 filas son todas `sin_demanda` -> todas clase C -> «clase B = 0».
  //    ⭐ «Un Pareto siempre produce B» vale **solo donde hay valor que repartir**. En un almacen
  //    sin demanda, todo-C es la respuesta CORRECTA y la propia vista lo dice en `clase_motivo`.
  //
  // El almacen de prueba se elige de la FOTO (`abc_classification`, tabla indexada: instantanea)
  // y entre los que YA producen clase B. Asi la guarda sigue siendo barata y ademas significa algo.
  const candidatos = (await knex.raw(
    `SELECT w.code, count(*)::int AS filas
       FROM commercial.abc_classification a
       JOIN commercial.warehouses w ON w.id = a.warehouse_id
      GROUP BY w.code
     HAVING count(*) FILTER (WHERE a.abc_class = 'B') > 0
      ORDER BY count(*) LIMIT 1`)).rows;

  if (!candidatos.length) {
    // ADR-056: lo que no se puede medir se DECLARA. Las guardas estructurales (orden de
    // columnas, security_invoker, GRANT) ya corrieron y son las que protegen a los consumidores.
    console.log('  [abc-desglose] vista +4 columnas · foto +5'
      + ' · ⓘ guarda de datos NO MEDIDA: ningun almacen de la foto produce clase B');
    return;
  }

  const { code } = candidatos[0];
  const d = (await knex.raw(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE v.abc_class = 'A')::int                  AS a,
            count(*) FILTER (WHERE v.abc_class = 'B')::int                  AS b,
            max(v.rango_almacen)::int                                       AS rango_max,
            max(v.skus_en_almacen)::int                                     AS skus,
            round(sum(v.aporte_individual), 4)::float8                      AS suma_aportes,
            count(*) FILTER (WHERE v.distancia_al_corte < 0)::int           AS distancias_negativas
       FROM analytics.v_abc_class v
       JOIN commercial.warehouses w ON w.id = v.warehouse_id
      WHERE w.code = ?`, [code])).rows[0];

  if (d.b < 1) throw new Error(`almacen ${code}: clase B = 0 — un Pareto siempre produce B`);
  if (d.rango_max !== d.skus) {
    throw new Error(`almacen ${code}: rango maximo ${d.rango_max} != ${d.skus} SKUs`);
  }
  if (Math.abs(Number(d.suma_aportes) - 1) > 0.001) {
    throw new Error(`almacen ${code}: los aportes suman ${d.suma_aportes}, no 1.0`);
  }
  // La distancia al piso de la propia clase no puede ser negativa: si lo es, la particion
  // del `min()` esta mal escrita y la columna significa otra cosa.
  if (d.distancias_negativas > 0) {
    throw new Error(`almacen ${code}: ${d.distancias_negativas} distancias negativas`);
  }

  console.log(`  [abc-desglose] vista +4 columnas · foto +5 · guarda en ${code}:`
    + ` ${d.total} filas · A ${d.a} · B ${d.b} · rango ${d.rango_max}/${d.skus}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista vuelve a sus 10 columnas. */
exports.down = async function down(knex) {
  for (const [nombre] of COLS_NUEVAS) {
    if (await knex.schema.withSchema('commercial').hasColumn('abc_classification', nombre)) {
      await knex.schema.withSchema('commercial').alterTable('abc_classification', (t) => t.dropColumn(nombre));
    }
  }
  // `CREATE OR REPLACE` no puede QUITAR columnas: hay que tirar la vista y rehacerla.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_abc_class`);
  await knex.raw(`
    CREATE VIEW analytics.v_abc_class AS
    WITH base AS (
      SELECT ih.tenant_id, ih.warehouse_id, ih.product_id, ih.avg_daily_units,
             (ih.avg_daily_units * 365::numeric
                * COALESCE(uc.costo_unitario, 0::numeric))::numeric(16,2) AS annual_value,
             COALESCE(uc.costo_source, 'sin_costo'::text) AS costo_source,
             uc.tiene_testigo IS TRUE AS tiene_testigo
        FROM analytics.inventory_health ih
        LEFT JOIN analytics.v_erp_unit_cost uc
               ON uc.tenant_id = ih.tenant_id AND uc.warehouse_id = ih.warehouse_id
              AND uc.product_id = ih.product_id
    ), ranked AS (
      SELECT base.*,
             sum(base.annual_value) OVER (
               PARTITION BY base.tenant_id, base.warehouse_id
               ORDER BY base.annual_value DESC, base.product_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_value,
             NULLIF(sum(base.annual_value) OVER (
               PARTITION BY base.tenant_id, base.warehouse_id), 0::numeric) AS total_value,
             sum(base.avg_daily_units) OVER (
               PARTITION BY base.tenant_id, base.warehouse_id) AS adu_almacen
        FROM base
    )
    SELECT tenant_id, warehouse_id, product_id,
           CASE
             WHEN total_value IS NULL THEN 'C'::text
             WHEN ((cum_value - annual_value) / total_value) < 0.80 THEN 'A'::text
             WHEN ((cum_value - annual_value) / total_value) < 0.95 THEN 'B'::text
             ELSE 'C'::text
           END AS abc_class,
           CASE
             WHEN COALESCE(adu_almacen, 0::numeric) <= 0::numeric THEN 'sin_demanda'::text
             WHEN avg_daily_units > 0::numeric
                  AND COALESCE(annual_value, 0::numeric) = 0::numeric THEN 'sin_costo'::text
             ELSE 'pareto'::text
           END AS clase_motivo,
           annual_value, avg_daily_units,
           CASE WHEN total_value IS NULL THEN 1.0
                ELSE round(cum_value / total_value, 4) END AS value_share,
           costo_source, tiene_testigo
      FROM ranked`);
  await knex.raw(`ALTER VIEW analytics.v_abc_class SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_abc_class TO app_runtime`);
};
