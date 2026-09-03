/**
 * [RR-PROMO.1] — `analytics.v_product_unit_ladder`: la ESCALERA DE UNIDADES DE VENTA por SKU,
 * derivada ÚNICAMENTE de `kepler_ods.kdii` (la tabla principal del maestro de productos).
 *
 * REGLA PRINCIPAL (CLAUDE.md): cero importers · del ODS · de una tabla principal normalizada ·
 * documentada y verificada. Esta vista cumple las cuatro: es `derive-no-copy` sobre `kepler_ods`,
 * no toca `catalog.products`, ni la etiquetera, ni `analytics.product_box_factor` (que es tabla
 * `relkind='r'` alimentada por `import-box-factor.js`).
 *
 * ── QUÉ RESUELVE ─────────────────────────────────────────────────────────────────────────
 * Kepler no guarda "una" unidad por producto: guarda hasta TRES peldaños, y la venta se
 * registra en cualquiera de ellos. El maestro `kdii` trae rótulo + factor + precio de cada uno:
 *
 *     peldaño │ rótulo   │ factor (unidades BASE por peldaño) │ precio   │ 97192 choyitas
 *     ────────┼──────────┼────────────────────────────────────┼──────────┼────────────────
 *     1 base  │ c11      │ 1 (por definición)                 │ c90      │ PAQ  ·  $58.85
 *     2 medio │ c80      │ c81                                │ c91      │ PAQ  ·  $58.85
 *     3 caja  │ c83      │ c84                                │ c92      │ CJA 24 · $1,291.93
 *
 * ⚠️ `c81`/`c84` cuentan unidades **BASE** (`c11`), NO "piezas". Para 97192 la base ES el
 * paquete, así que `c84 = 24` son *paquetes* por caja. Verificado en prod contra las 7
 * sucursales (idéntico en todas). Llamarle "piezas" es el error que esta vista existe para
 * evitar — ver `docs/UNIDADES_DE_MEDIDA.md` §4.
 *
 * ── POR QUÉ EL PRECIO Y NO EL RÓTULO ─────────────────────────────────────────────────────
 * El rótulo de la línea de venta no es confiable: el catálogo discrepa con el ERP en 73.6%
 * (§2 del doc). Medido sobre la venta de ruta de ago-2026, de los 709 SKUs que aparecen con
 * más de un rótulo, **688 ($2.96M, 94.9%) tienen el MISMO precio unitario entre rótulos** —
 * o sea la cantidad ya era homogénea y sólo el rótulo mentía. Sólo **17 SKUs ($142,653)**
 * mezclan peldaños de verdad. Convertir por rótulo habría inflado el 94.9% para arreglar el 2.4%.
 *
 * El precio SÍ discrimina, porque los peldaños distan entre sí ≥ el factor (≥2×), mucho más
 * que cualquier descuento. Es el mismo criterio money-anchored que ya usa la casa, y la banda
 * 0.5×–2× es la que `docs/UNIDADES_DE_MEDIDA.md` §6 usa para declarar "misma unidad que la base".
 *
 * ── COBERTURA (medida en prod, venta de ruta ago-2026) ───────────────────────────────────
 *   con escala de precio en kdii : 3,193 SKUs · $5,835,099 · 100.0%
 *   sin SKU en kdii              :    19 SKUs ·     $1,877 ·   0.0%
 *
 * ── CONTRATO ─────────────────────────────────────────────────────────────────────────────
 * Una fila por SKU. `f*` = unidades base por peldaño; `p*` = precio de lista del peldaño.
 * `unit_base` es el rótulo REAL del ERP con la basura anulada ('500','250','2KG' NO son
 * unidades, son cantidades: §3 del doc) — `unit_base_raw` la conserva para trazabilidad.
 * `is_weight` marca el granel: ahí la conversión a piezas no aplica y no debe publicarse.
 *
 * Agregación entre sucursales: `mode()` para rótulos y factores (son idénticos salvo captura
 * suelta; `c84` diverge en 3 de 2,419 SKUs = 0.12%) y mediana para precios (sí varían por rama
 * de forma legítima, y para detectar el peldaño alcanza un ancla aproximada).
 * Excluye la sucursal `'00'` = **OFICINAS**, no el CEDIS (trae valuación de prueba).
 *
 * Idempotente (CREATE OR REPLACE). No crea tablas ni toca datos.
 *
 * @param { import("knex").Knex } knex
 */
/** Único tenant hoy; mismo literal que usa la definición previa de `analytics.product_units`. */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  const hasOds = await knex.schema.withSchema('kepler_ods').hasTable('kdii');
  if (!hasOds) {
    // Entorno sin ODS (dev local sin replicación): vista vacía TIPADA, para que los LEFT JOIN
    // de los consumidores no exploten y el motor caiga limpio a "no resuelto".
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.v_product_unit_ladder AS
      SELECT NULL::text AS sku,
             NULL::text AS unit_base, NULL::text AS unit_base_raw,
             NULL::text AS u2_label, NULL::text AS u3_label,
             NULL::numeric AS f2, NULL::numeric AS f3,
             NULL::numeric AS p1, NULL::numeric AS p2, NULL::numeric AS p3,
             NULL::boolean AS is_weight
      WHERE false`);
    await knex.raw(`GRANT SELECT ON analytics.v_product_unit_ladder TO app_runtime`);
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_product_unit_ladder AS
    WITH agg AS (
      SELECT btrim(c1) AS sku,
             mode() WITHIN GROUP (ORDER BY NULLIF(upper(btrim(c11)), '')) AS u1_raw,
             mode() WITHIN GROUP (ORDER BY NULLIF(upper(btrim(c80)), '')) AS u2_label,
             mode() WITHIN GROUP (ORDER BY NULLIF(upper(btrim(c83)), '')) AS u3_label,
             mode() WITHIN GROUP (ORDER BY c81) AS f2,
             mode() WITHIN GROUP (ORDER BY c84) AS f3,
             -- ::numeric — percentile_cont devuelve double precision, y esto es dinero:
             -- se queda en exacto para que el consumidor no arrastre error de float.
             percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(c90, 0))::numeric AS p1,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(c91, 0))::numeric AS p2,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(c92, 0))::numeric AS p3
        FROM kepler_ods.kdii
       WHERE sucursal <> '00'                    -- '00' = OFICINAS (valuación de prueba)
         AND btrim(COALESCE(c1, '')) <> ''
       GROUP BY 1
    )
    SELECT sku,
           -- Unidad base "publicable": sólo un rótulo alfabético real. '500'/'250'/'2KG' son
           -- CANTIDADES capturadas en el campo de unidad; es más honesto no saber la unidad
           -- que afirmar una que no existe.
           CASE WHEN u1_raw ~ '^[A-Z]{2,4}$' THEN u1_raw END AS unit_base,
           u1_raw AS unit_base_raw,
           u2_label, u3_label,
           -- Factores: sólo valen si son > 1. Un factor de 1 significa "este peldaño es la base".
           CASE WHEN f2 > 1 THEN f2 END AS f2,
           CASE WHEN f3 > 1 THEN f3 END AS f3,
           -- Crudos, verbatim del ERP: los necesita analytics.product_units, que se deriva
           -- de acá y no puede cambiar ni una fila de lo que ya sirve al selector de medidas.
           -- (sin backticks: este comentario vive dentro de un template literal de JS)
           f2 AS f2_raw, f3 AS f3_raw,
           p1, p2, p3,
           -- Granel: el rótulo base es peso, o es un gramaje numérico ('500' = 500 g).
           COALESCE(u1_raw IN ('KG', 'KGS', 'CUB', 'BTO', 'BULTO')
                    OR u1_raw ~ '^[0-9]+(\\.[0-9]+)?$'
                    OR u1_raw ~ '^[0-9]+KG$'
                    OR u2_label IN ('KG', 'KGS'), FALSE) AS is_weight
      FROM agg`);

  // ── `analytics.product_units` pasa a DERIVAR de la escalera, en vez de re-derivarla ──
  // Existía desde el 2026-09-01 (mig 20260901120000) leyendo `kdii` por su cuenta, con la
  // MISMA agregación. Dos vistas calculando la misma escalera sobre la misma fuente es
  // exactamente lo que la regla principal prohíbe: una sola tabla principal, y lo demás
  // se deriva. Su contrato NO cambia — mismas columnas, mismo orden, mismos tipos —
  // verificado contra prod fila por fila antes de aplicar: 8,883 = 8,883, cero diferencias.
  //
  // Por eso la escalera expone los crudos: `product_units` conserva la basura del rótulo
  // ('500','250': 114 filas) y los factores en 1 (2,017 filas), que su consumidor —el
  // selector "pieza / paquete / caja" del vendedor— ya recibe hoy.
  //
  // CREATE OR REPLACE, nunca DROP: hay código colgando de esta vista y un DROP la deja
  // caída entre migraciones (además del 0A000 de plan cacheado si algo más dependiera).
  const hasPU = await knex.schema.withSchema('analytics').hasTable('product_units');
  if (hasPU) {
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.product_units AS
      SELECT '${TENANT}'::uuid AS tenant_id, p.id AS product_id,
             l.unit_base_raw AS unit_base,
             l.u2_label      AS unit_alt1, l.f2_raw AS f_alt1,
             l.u3_label      AS unit_alt2, l.f3_raw AS f_alt2,
             now() AS computed_at
        FROM analytics.v_product_unit_ladder l
        JOIN catalog.products p
          ON btrim(p.sku) = l.sku AND p.tenant_id = '${TENANT}'::uuid AND p.deleted_at IS NULL
       WHERE l.unit_base_raw IS NOT NULL`);
    await knex.raw(`GRANT SELECT ON analytics.product_units TO app_runtime`);
  }

  await knex.raw(`GRANT SELECT ON analytics.v_product_unit_ladder TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_product_unit_ladder IS
    'RR-PROMO.1 — escalera de unidades de VENTA por SKU derivada de kepler_ods.kdii (rotulos c11/c80/c83, factores c81/c84 en unidades BASE, precios c90/c91/c92). Permite identificar en que peldano se vendio una linea por su precio real, sin confiar en el rotulo. Ver docs/UNIDADES_DE_MEDIDA.md'`);
};

/**
 * Devuelve `analytics.product_units` a su definición auto-contenida ANTES de soltar la
 * escalera: si no, el DROP falla (o se lleva la vista por delante con CASCADE) y el
 * selector de medidas del vendedor queda sin fuente.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  const hasPU = await knex.schema.withSchema('analytics').hasTable('product_units');
  const hasOds = await knex.schema.withSchema('kepler_ods').hasTable('kdii');
  if (hasPU && hasOds) {
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.product_units AS
      WITH ladder AS (
        SELECT btrim(c1) AS sku,
               mode() WITHIN GROUP (ORDER BY btrim(c11)) AS u_base,
               mode() WITHIN GROUP (ORDER BY btrim(c80)) AS u_alt1,
               mode() WITHIN GROUP (ORDER BY c81::numeric) AS f_alt1,
               mode() WITHIN GROUP (ORDER BY btrim(c83)) AS u_alt2,
               mode() WITHIN GROUP (ORDER BY c84::numeric) AS f_alt2
          FROM kepler_ods.kdii WHERE btrim(sucursal) <> '00' GROUP BY 1
      )
      SELECT '${TENANT}'::uuid AS tenant_id, p.id AS product_id,
             NULLIF(l.u_base, '') AS unit_base,
             NULLIF(l.u_alt1, '') AS unit_alt1, l.f_alt1,
             NULLIF(l.u_alt2, '') AS unit_alt2, l.f_alt2,
             now() AS computed_at
        FROM ladder l
        JOIN catalog.products p
          ON btrim(p.sku) = l.sku AND p.tenant_id = '${TENANT}'::uuid AND p.deleted_at IS NULL
       WHERE NULLIF(l.u_base, '') IS NOT NULL`);
    await knex.raw(`GRANT SELECT ON analytics.product_units TO app_runtime`);
  }
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_product_unit_ladder`);
};
