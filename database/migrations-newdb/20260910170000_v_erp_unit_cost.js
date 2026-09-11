/**
 * KE.3 — EL COSTO UNITARIO, UNA SOLA VEZ, CON EL TESTIGO DEL MISMO ERP.
 *
 * Pedido de Edgar (2026-09-10), tras medir que la verdad se había aplicado en un solo eje:
 * *"ya aplicamos esto en sell-out, pedido, existencias. en todas las tablas que necesitan de la
 * misma verdad?"* — y la respuesta medida fue **no**.
 *
 * ── El hallazgo que abre esta migración ─────────────────────────────────────────────────────
 *
 * El eje de la UNIDAD ya estaba resuelto (ADR-055/057: `v_warehouse_box_factor`, `v_unit_truth`).
 * El eje del COSTO **no**: KE.1 arbitró la existencia y nadie más. Medido contra prod, **el mismo
 * inventario de 18,969 filas de Kepler**:
 *
 *     arbitro del ERP ........................ $39,456,434
 *     cost_base    (Rentabilidad/ABC/Conteo) .. $44,943,938   +$5,487,504  (13.91%)
 *     cost_with_tax (Compras/scanner) ......... $45,841,085   +$6,384,651  (16.18%)
 *
 * ⭐ Y la prueba de que no era teórico: `v_erp_stock_truth.valor_publicado_hoy` da **$45,841,211**,
 * o sea coincide con `cost_with_tax` **dentro de $126**. Las seis pantallas de abajo publicaban
 * exactamente el número pre-KE que la existencia ya había dejado de publicar:
 *
 *     inventory-abc.service.ts:48          la CLASE ABC (y la clase fija el nivel de servicio)
 *     inventory-count.service.ts:723       la varianza del conteo ciclico (y desde public.products)
 *     commercial-inventory.service.ts:121  available_value y value_at_cost
 *     commercial-profitability.service.ts  el inventario del GMROI (deuda declarada en ADR-051)
 *     commercial-replenishment.service.ts  el costo del sugerido
 *     commercial-analytics.service.ts:1153 el capital parado del sell-out
 *
 * ── Lo que esta vista agrega, y por qué es UNA sola ─────────────────────────────────────────
 *
 * `analytics.v_kepler_unit_cost` (KE.2) ya resolvía Kepler, pero **sólo Kepler**: hace JOIN por
 * `kepler_code`, así que los 10 almacenes de Wincaja no tenían dónde ir. Seis consumidores no
 * pueden cada uno inventarse su propia mezcla — eso es exactamente el primitivo duplicado que
 * ADR-056 prohíbe. Acá se resuelve una vez, al grano **almacén × producto**, para los dos ERPs.
 *
 * ⭐ **Y Wincaja SÍ tiene testigo propio**, que nadie había buscado: `existencias.costo_promedio`
 * (vía `wincaja.v_stock`). Medido antes de usarlo, como manda la regla de no adivinar una fuente:
 *
 *     identidad interna  costo_existencia / existencia == costo_promedio ... 33,974 de 34,123 (99.56%)
 *     mediana  cost_base / costo_promedio ........................... 0.9994  (casi 1.0000 exacto,
 *                                                                     igual que del lado de Kepler)
 *     cobertura sobre la existencia de Wincaja ..................... 6,370 de 6,370 (100.00%)
 *
 * O sea el costo del catálogo está en la MISMA unidad que el de los dos ERPs, y la discrepancia
 * no es de unidad sino de concentración (ADR-059).
 *
 * ── ⛔ EL GUARD: cada ERP con SU evidencia, y acá muerde de verdad ──────────────────────────
 *
 * **3,164 filas de Kepler también empatan contra un testigo de Wincaja** (mismo SKU, otra plaza).
 * Un `COALESCE(kepler, wincaja, catalogo)` ingenuo les daría un costo del ERP equivocado sin que
 * nadie lo note. Por eso la elección NO es un COALESCE sino un `CASE` sobre `erp`: la rama de
 * Kepler ni siquiera puede ver la columna de Wincaja. La auto-verificación lo prueba en cero.
 *
 * ── El fallback se DECLARA, no se esconde (ADR-056) ─────────────────────────────────────────
 *
 * Sin testigo del ERP, `costo_unitario` cae al catálogo **cegado** — la misma regla que KE.1 aplicó
 * a la existencia: si `cost_with_tax < cost_base` las dos columnas están invertidas respecto de sus
 * nombres (62 SKUs medidos), así que se toma la menor. Y `costo_source` siempre dice de dónde
 * salió, `tiene_testigo` permite calcular cobertura, y **`costo_unitario` es NULL cuando no hay
 * nada** — nunca 0, que se leería como "gratis".
 *
 * La vista **enumera los 191,012 pares completos** (el mismo grano exacto que `v_unit_truth`), no
 * sólo los que tienen costo: una fila ausente llega NULL a un LEFT JOIN y se lee como sana. Esa es
 * la lección de `v_unit_truth_coverage`, aplicada acá por construcción en vez de con una vista
 * aparte.
 *
 * ── Lo que esta migración NO hace, dicho ────────────────────────────────────────────────────
 *
 * ⚠️ **No toca la CANTIDAD.** Los seis consumidores leen `commercial.stock`, que KE.1 midió al
 * **91.0%** contra el POS mientras `analytics.v_erp_stock_on_hand` acierta al **100%**. Cambiar la
 * cantidad es otro commit, con su propio antes/después. Acá sólo se cambia el costo, al mismo grano,
 * para que el diff sea legible y atribuible.
 *
 * ── Medido (prod, 2026-09-10) ───────────────────────────────────────────────────────────────
 *
 *     filas .................. 191,012 pares almacen x producto
 *     con testigo del ERP .... 123,344 (64.57%) del total · 25,324 de 25,573 (99.03%) CON EXISTENCIA
 *     cruces entre ERPs ...... 0
 *     capital hoy ............ $71,744,359  ->  con el resolvedor $69,493,270  (-$2,251,089)
 *     costo ................... 608 ms  contra los 2,580 ms que cuesta HOY la misma consulta
 *
 * ⚠️ Re-aplicar `security_invoker` y el `GRANT` después de cada `CREATE OR REPLACE` (lección U.7).
 *
 * @param { import("knex").Knex } knex
 */

const SQL = `
CREATE OR REPLACE VIEW analytics.v_erp_unit_cost AS
SELECT w.tenant_id,
       w.id                          AS warehouse_id,
       w.code                        AS warehouse_code,
       CASE WHEN w.kepler_code IS NOT NULL THEN 'kepler' ELSE 'wincaja' END AS erp,
       p.id                          AS product_id,
       p.sku,
       -- ⛔ CASE, no COALESCE. 3,164 filas de Kepler empatan tambien contra un testigo de
       -- Wincaja: un COALESCE les daria el costo del ERP equivocado en silencio.
       CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
            ELSE wv.costo_promedio END                     AS costo_erp,
       p.cost_base                                          AS costo_catalogo,
       -- Catalogo CEGADO: cost_with_tax menor que cost_base significa que las dos columnas estan
       -- invertidas respecto de sus nombres (62 SKUs medidos en KE.1), asi que se toma la menor.
       NULLIF(CASE WHEN COALESCE(p.cost_with_tax, 0) > 0 AND p.cost_with_tax < p.cost_base
                   THEN p.cost_with_tax ELSE p.cost_base END, 0) AS costo_catalogo_ciego,
       -- ⭐ EL QUE SE PUBLICA. NULL cuando no hay nada: un 0 se leeria como "gratis".
       COALESCE(CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
                     ELSE wv.costo_promedio END,
                NULLIF(CASE WHEN COALESCE(p.cost_with_tax, 0) > 0 AND p.cost_with_tax < p.cost_base
                            THEN p.cost_with_tax ELSE p.cost_base END, 0)) AS costo_unitario,
       CASE WHEN w.kepler_code IS NOT NULL AND kc.costo_unitario > 0 THEN 'kepler_kdik'
            WHEN w.kepler_code IS NULL     AND wv.costo_promedio > 0 THEN 'wincaja_costo_promedio'
            WHEN COALESCE(p.cost_with_tax, 0) > 0 AND p.cost_with_tax < p.cost_base
                                                                     THEN 'catalogo_columnas_invertidas'
            WHEN COALESCE(p.cost_base, 0) > 0                        THEN 'catalogo_neto'
            ELSE 'sin_costo' END                            AS costo_source,
       (CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
             ELSE wv.costo_promedio END > 0)                AS tiene_testigo,
       CASE WHEN COALESCE(p.cost_base, 0) > 0
             AND COALESCE(CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
                               ELSE wv.costo_promedio END, 0) > 0
            THEN round((p.cost_base / CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
                                           ELSE wv.costo_promedio END)::numeric, 4) END AS razon,
       CASE
         WHEN COALESCE(CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
                            ELSE wv.costo_promedio END, 0) <= 0 THEN 'sin_testigo'
         WHEN COALESCE(p.cost_base, 0) <= 0                     THEN 'sin_costo_catalogo'
         WHEN abs(p.cost_base / CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
                                     ELSE wv.costo_promedio END - 1) <= 0.02 THEN 'confirmado'
         WHEN p.cost_base / CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
                                 ELSE wv.costo_promedio END >= 1.5   THEN 'contradicho_por_factor'
         WHEN p.cost_base / CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario
                                 ELSE wv.costo_promedio END <= 0.667 THEN 'contradicho_por_factor'
         ELSE 'precio_movido' END                           AS veredicto
  FROM commercial.warehouses w
  JOIN catalog.products p
    ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
  LEFT JOIN analytics.v_kepler_unit_cost kc
         ON w.kepler_code IS NOT NULL AND kc.tenant_id = w.tenant_id
        AND kc.warehouse_id = w.id AND kc.product_id = p.id
  -- Join directo, sin agregar: verificado que wincaja.v_stock trae UN renglon por
  -- (tenant, source_branch, articulo) -- 321,994 filas = 321,994 pares unicos.
  LEFT JOIN wincaja.v_stock wv
         ON w.kepler_code IS NULL AND wv.tenant_id = w.tenant_id
        AND wv.source_branch = w.wincaja_source_branch AND wv.sku = p.sku::text
        AND wv.costo_promedio > 0
 WHERE w.deleted_at IS NULL
   AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
  await knex.raw(`ALTER VIEW analytics.v_erp_unit_cost SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_unit_cost TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_erp_unit_cost IS
    'KE.3: el costo unitario por almacen x producto con el testigo del MISMO ERP (Kepler kdik.c16 / Wincaja costo_promedio), fallback al catalogo CEGADO y NULL declarado cuando no hay ninguno. Enumera los 191k pares completos a proposito: una fila ausente llega NULL a un LEFT JOIN y se lee como sana. UNICO resolvedor de costo: lo leen existencia, rentabilidad, ABC, conteo ciclico, inventario, compras y capital parado.'`);

  // ── Auto-verificación ──
  const meta = await knex.raw(
    `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_erp_unit_cost'`);
  const opts = (meta.rows[0] || {}).reloptions || [];
  if (!opts.some((x) => String(x).includes('security_invoker'))) {
    throw new Error('v_erp_unit_cost perdió security_invoker');
  }

  const d = (await knex.raw(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE tiene_testigo)::int con_testigo,
           count(*) FILTER (WHERE erp = 'kepler'  AND costo_source LIKE 'wincaja%')::int cruce_k,
           count(*) FILTER (WHERE erp = 'wincaja' AND costo_source LIKE 'kepler%')::int cruce_w,
           count(*) FILTER (WHERE costo_source = 'sin_costo' AND costo_unitario IS NOT NULL)::int miente,
           count(*) FILTER (WHERE costo_unitario IS NOT NULL AND costo_unitario <= 0)::int cero
      FROM analytics.v_erp_unit_cost`)).rows[0];

  // ⛔ Lo que esta vista existe para impedir: que un ERP tome el costo del otro.
  if (d.cruce_k > 0 || d.cruce_w > 0) {
    throw new Error(`cruce entre ERPs: ${d.cruce_k} filas de Kepler con costo de Wincaja y ${d.cruce_w} al revés`);
  }
  // Un `sin_costo` con número sería un relleno disfrazado (ADR-056).
  if (d.miente > 0) throw new Error(`${d.miente} filas dicen sin_costo y traen costo_unitario`);
  if (d.cero > 0) throw new Error(`${d.cero} filas publican un costo <= 0: tiene que ser NULL`);
  // Enumeración completa: si se cae a los pares con costo, los huecos dejan de verse.
  if (d.total < 150000) {
    throw new Error(`v_erp_unit_cost trae ${d.total} filas: dejó de enumerar los 191k pares`);
  }

  // Cobertura donde de verdad importa: las filas CON existencia.
  const s = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE v.tiene_testigo)::int con_testigo,
           round(sum(s.quantity * COALESCE(p.cost_base, 0)))::numeric AS hoy,
           round(sum(s.quantity * v.costo_unitario))::numeric         AS nuevo
      FROM commercial.stock s
      JOIN catalog.products p
        ON p.tenant_id = s.tenant_id AND p.id = s.product_id AND p.deleted_at IS NULL
      JOIN analytics.v_erp_unit_cost v
        ON v.tenant_id = s.tenant_id AND v.warehouse_id = s.warehouse_id
       AND v.product_id = s.product_id
     WHERE s.quantity > 0`)).rows[0];
  const pct = (100 * s.con_testigo) / s.filas;
  if (pct < 98) {
    throw new Error(`cobertura del testigo ${pct.toFixed(2)}% sobre las filas con existencia (medido 99.03%)`);
  }
  const delta = Number(s.nuevo) - Number(s.hoy);
  // Banda, no cifra exacta: `kdik` lo refresca el shipper del ODS todo el tiempo y clavar un
  // entero vivo es una carrera, no un candado (misma lección que KE.2 y que la paridad de K.3).
  if (delta > 0 || delta < -6000000) {
    throw new Error(`el delta contra cost_base es ${delta}: se midió -2,251,089 y tiene que ser negativo y del mismo orden`);
  }
  console.log(`  [erp-unit-cost] ${d.total.toLocaleString('en-US')} pares`
    + ` · testigo propio ${pct.toFixed(2)}% de las ${s.filas.toLocaleString('en-US')} filas con existencia`
    + ` · capital ${Number(s.hoy).toLocaleString('en-US')} -> ${Number(s.nuevo).toLocaleString('en-US')}`
    + ` (${delta.toLocaleString('en-US')})`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_unit_cost`);
};
