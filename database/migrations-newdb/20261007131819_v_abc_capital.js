'use strict';
/**
 * `[IC.21]` — EL SEGUNDO EJE DEL ABC: EL CAPITAL PARADO.
 *
 * Edgar (2026-10-07), al cerrar el plan de los tres ritmos: el ritmo mensual necesita saber
 * **dónde está el dinero quieto**, y el ABC de consumo no puede responder esa pregunta.
 *
 * ── Por qué un segundo eje, y por qué ÉSTE ──────────────────────────────────────────────────
 *
 * El ABC de hoy (`analytics.v_abc_class`) ordena por MOVIMIENTO:
 * `avg_daily_units × 365 × costo`. Hace bien su trabajo. Pero su punto ciego tiene monto
 * (medido en prod, 2026-10-06):
 *
 *   clase C = 17,953 SKUs = 5% del flujo = **$20,853,794 de capital = 32.6% del dinero**,
 *   con cadencia de conteo de 365 días.
 *
 * Las botas navideñas en octubre son el caso de manual: cero consumo en la ventana de 90 días
 * → `annual_value = 0` → clase C → se cuentan una vez al año, justo antes de su temporada.
 *
 * ⛔ Lo que se DESCARTÓ, con medición: «uno por ventas y otro por costo» es un placebo. Pareto
 * por ingreso contra Pareto por COGS coinciden en **4,040 de 4,087 SKUs (98.85%)**, porque en la
 * mitad Kepler del fact el costo se deriva como `revenue/(1+markup)` — álgebra sobre el propio
 * ingreso (ADR-051). Serían dos pantallas iguales. El eje que SÍ difiere es éste: coincide con el
 * de consumo sólo el **56.7%**.
 *
 * ── Lo medido antes (sólo lectura, prod 2026-10-07) ─────────────────────────────────────────
 *  · 21,562 filas con existencia, **todas con costo** — no hay hueco `sin_costo` hoy.
 *  · Capital total **$64,503,081** en 9 almacenes. Árbitro: la Fase MR midió $59.1M → razón
 *    1.09. Mismo universo, no idéntico; se declara, no se afirma coincidencia exacta.
 *  · Veredicto del costo: `confirmado` 16,461 ($48.6M) · `precio_movido` 4,617 ($13.2M) ·
 *    `contradicho_por_factor` 453 ($2.7M) · `sin_testigo` 31 ($28,888).
 *
 * ── ⭐ Lo que vuelve a este eje MÁS confiable que el de flujo ────────────────────────────────
 *
 * El origen de la existencia y el del costo son **el mismo**: `unit_source = 'kepler'` y
 * `erp = 'kepler'` en **21,562 de 21,562** filas. Los dos factores salen de la misma ficha y del
 * mismo peldaño, así que el producto es **conmensurable**.
 *
 * Eso NO pasa en el eje de flujo, donde `avg_daily_units` viene del hecho de venta (en el peldaño
 * vendido) y el costo de la ficha: ahí el SKU `57009` (COBERTURA 20K LUSSEL — existencia en
 * cubetas, venta en kilos) se publicaba en $42,536/día cuando lo real son $4,594. **9.3×.**
 *
 * ⚠️ Pero conmensurable no es exacto: **453 filas ($2,725,042)** traen
 * `costo_veredicto = 'contradicho_por_factor'`. Se **publican con su veredicto al lado**, no se
 * esconden ni se corrigen — el costo se arregla en Kepler (ADR-040).
 *
 * ── La regla que esta vista NO hereda de su hermana ─────────────────────────────────────────
 *
 * ⛔ `v_abc_class` hace `COALESCE(costo_unitario, 0)`: un costo desconocido se vuelve valor 0 y el
 * SKU cae a C **en silencio**. Para el capital eso sería peor — una tarima con 5,000 piezas y
 * costo desconocido se publicaría como $0 y clase C, que es exactamente «dibujar un cero»
 * (ADR-056).
 *
 * Acá el capital sin costo es **NULL**, la clase es **NULL**, y `clase_motivo` dice `sin_costo`.
 * Hoy no hay ninguna fila así — **por eso la prueba negativa del candado inyecta una a propósito**:
 * un camino que nunca se ejerce no está probado.
 *
 * ── Lo que publica de más que su hermana ────────────────────────────────────────────────────
 *
 * `rango_almacen`, `skus_en_almacen` y `aporte_individual`: las tres piezas que `[IC.20]` pide
 * para explicar «por qué es A y no B» y que `v_abc_class` calcula y tira. Acá nacen publicadas.
 *
 * ── ⛔ EL COSTO: lee la MATVISTA, no la vista (medido en prod antes de aplicar, 2026-10-07) ──
 *
 * Esta migración se escribió contra `analytics.v_erp_unit_cost` y **nunca llegó a aplicarse así**.
 * Medido contra prod con la vista:
 * ```
 *   v_erp_stock_on_hand (filtrada)        440 ms  ·  21,630 filas
 *   v_erp_unit_cost                     1,900 ms  · 248,578 filas
 *   las dos unidas, UN almacén (03)    54,479 ms  ·   2,924 filas   ⛔
 *   las dos unidas, los 9 almacenes      >180 s (abortada)
 * ```
 * El plan lo explica: `Nested Loop Left Join` contra una UNION con `Seq Scan` sobre `products`,
 * `product_unit_overrides`, `branches` y `warehouses`. El almacén 03 es el 13.5 % del universo,
 * así que los 9 proyectan **6–8 min** — y eso corre DENTRO de la transacción de esta migración,
 * o sea **6–8 min con `knex_migrations_lock` tomado**, que es el mecanismo del incidente de los
 * 22 minutos que `CLAUDE.md` documenta: mientras dura, ningún despliegue de nadie entra.
 *
 * ⭐ **El arreglo ya existía desde el 2026-09-29 y esta migración no lo usaba:** `[MR.8.5]`
 * (mig `20260929130000`) creó `analytics.mv_erp_unit_cost` como `SELECT * FROM v_erp_unit_cost`
 * literal, **exactamente para este camino caliente**. Mismas 14 columnas, mismas 248,578 filas;
 * las cuatro que esta vista usa (`costo_unitario`, `costo_source`, `tiene_testigo`, `veredicto`)
 * están todas. Es reemplazo directo. Medido con la matvista:
 * ```
 *   UN almacén (03)        54,479 ms →     98 ms   (554×)
 *   los 9 almacenes          >180 s  →    666 ms   (bajo el tope de 1 s)
 * ```
 * Con eso la verificación de abajo deja de ser un problema de candado: 666 ms, no 8 minutos.
 *
 * ⚠️ **Lo que se paga, declarado:** la matvista se refresca cada 15 min (`AnalyticsRefreshService`,
 * latido agregado `analytics_refresh`, verificado `ok` al momento de medir). El capital total sale
 * **$64,971,035** contra **$64,503,081** que la vista daba al escribir esta cabecera: **0.7 %**, que
 * es costo unitario moviéndose dentro de la ventana (recepciones). Para un ABC de capital —ritmo
 * mensual— 15 minutos de rezago no cambian ninguna clase; para algo que necesite el dato al
 * segundo, la vista sigue viva y sin tocar.
 *
 * ⚠️ `security_invoker` + `GRANT` van explícitos (lección U.7): un `CREATE OR REPLACE VIEW` no
 * los hereda, y el candado lo verifica en metadata.
 *
 * ⚠️ El `ORDER BY` del Pareto lleva `product_id` como desempate. Sin él, dos filas con el mismo
 * capital producen clases distintas entre corridas.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const SQL_VIEW = `
CREATE OR REPLACE VIEW analytics.v_abc_capital AS
WITH base AS (
  SELECT s.tenant_id,
         s.warehouse_id,
         s.warehouse_code,
         s.product_id,
         s.sku,
         s.qty_stock_units                        AS on_hand,
         uc.costo_unitario,
         CASE WHEN uc.costo_unitario > 0
              THEN (s.qty_stock_units * uc.costo_unitario)::numeric(16,2)
         END                                      AS capital,
         uc.costo_source,
         uc.tiene_testigo,
         uc.veredicto                             AS costo_veredicto
    FROM analytics.v_erp_stock_on_hand s
    LEFT JOIN analytics.mv_erp_unit_cost uc
           ON uc.tenant_id    = s.tenant_id
          AND uc.warehouse_id = s.warehouse_id
          AND uc.product_id   = s.product_id
   WHERE s.qty_stock_units > 0
), ranked AS (
  SELECT b.*,
         sum(b.capital) OVER (
           PARTITION BY b.tenant_id, b.warehouse_id
           ORDER BY b.capital DESC NULLS LAST, b.product_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)       AS cum_capital,
         NULLIF(sum(b.capital) OVER (
           PARTITION BY b.tenant_id, b.warehouse_id), 0)           AS total_capital,
         row_number() OVER (
           PARTITION BY b.tenant_id, b.warehouse_id
           ORDER BY b.capital DESC NULLS LAST, b.product_id)       AS rango_almacen,
         count(*) OVER (PARTITION BY b.tenant_id, b.warehouse_id)  AS skus_en_almacen
    FROM base b
)
SELECT tenant_id,
       warehouse_id,
       warehouse_code,
       product_id,
       sku,
       on_hand,
       costo_unitario,
       capital,
       CASE
         WHEN capital IS NULL       THEN NULL
         WHEN total_capital IS NULL THEN 'C'
         WHEN ((cum_capital - capital) / total_capital) < 0.80 THEN 'A'
         WHEN ((cum_capital - capital) / total_capital) < 0.95 THEN 'B'
         ELSE 'C'
       END AS capital_class,
       CASE
         WHEN costo_unitario IS NULL OR costo_unitario <= 0 THEN 'sin_costo'
         WHEN total_capital IS NULL                         THEN 'almacen_sin_capital'
         ELSE 'pareto'
       END AS clase_motivo,
       CASE WHEN total_capital IS NOT NULL AND capital IS NOT NULL
            THEN round(cum_capital / total_capital, 4) END AS value_share,
       CASE WHEN total_capital IS NOT NULL AND capital IS NOT NULL
            THEN round(capital / total_capital, 6) END     AS aporte_individual,
       rango_almacen,
       skus_en_almacen,
       costo_source,
       tiene_testigo,
       costo_veredicto
  FROM ranked`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(SQL_VIEW);
  await knex.raw(`ALTER VIEW analytics.v_abc_capital SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_abc_capital TO app_runtime`);

  const opts = (await knex.raw(
    `SELECT unnest(c.reloptions) AS o
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_abc_capital'`)).rows.map((r) => r.o);
  if (!opts.some((x) => String(x).includes('security_invoker'))) {
    throw new Error('v_abc_capital perdio security_invoker');
  }

  const d = (await knex.raw(`
    SELECT count(*)::int                                          AS total,
           count(*) FILTER (WHERE capital_class = 'A')::int        AS a,
           count(*) FILTER (WHERE capital_class = 'B')::int        AS b,
           count(*) FILTER (WHERE capital_class = 'C')::int        AS c,
           count(*) FILTER (WHERE capital_class IS NULL)::int      AS sin_clase,
           count(*) FILTER (WHERE clase_motivo = 'sin_costo')::int AS sin_costo,
           round(sum(capital))::numeric                            AS cap
      FROM analytics.v_abc_capital`)).rows[0];

  // Mismo delator que KE.4: un Pareto SIEMPRE produce clase B. Que B fuera 0 delataria
  // que la fuente esta vacia -- y eso estuvo dos meses a la vista en el eje de consumo.
  if (d.b < 1) throw new Error('capital_class B = 0: un Pareto siempre produce B — la fuente esta vacia');
  if (d.a < 1) throw new Error('capital_class A = 0: la fuente de existencia esta vacia');
  if (d.a > d.total * 0.4) {
    throw new Error(`capital_class A = ${d.a} de ${d.total} (>40%): el Pareto no esta ordenando`);
  }
  if (d.total < 5000) throw new Error(`v_abc_capital trae ${d.total} filas: la existencia esta vacia`);
  // La coherencia que esta vista promete: sin costo => sin clase. Nunca una sin la otra.
  if (d.sin_clase !== d.sin_costo) {
    throw new Error(`incoherencia: ${d.sin_clase} sin clase contra ${d.sin_costo} sin costo`);
  }

  console.log(`  [abc-capital] ${d.total.toLocaleString('en-US')} filas`
    + ` · A ${d.a.toLocaleString('en-US')} · B ${d.b.toLocaleString('en-US')}`
    + ` · C ${d.c.toLocaleString('en-US')}`
    + ` · capital $${Number(d.cap).toLocaleString('en-US')}`
    + ` · sin costo ${d.sin_costo}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_abc_capital`);
};
