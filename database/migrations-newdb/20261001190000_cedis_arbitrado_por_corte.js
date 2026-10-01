/* eslint-disable */
/**
 * `[IC.CEDIS.12]` — **El CEDIS vuelve a la existencia publicada, ahora ARBITRADO.**
 * Levanta el retiro de `20261001170000` (batch 653) con la evidencia que faltaba.
 *
 * ── EL ÁRBITRO, COMPLETO ───────────────────────────────────────────────────────────────────────
 * El *"Reporte de existencia por productos"* del propio Kepler (01/10/2026 09:53, Sucursal=CEDIS,
 * Almacén=ALMACÉN Cedis) corrido **sin filtro de línea y sin omitir los ceros**: 123 páginas,
 * **9,496 SKUs**, o sea el universo entero del almacén. No es una muestra — es el censo.
 *
 *     el CEDIS tiene existencia en ........   148 SKUs /    357,471 u base
 *     esta vista publicaba ................ 4,653 SKUs / 12,181,690 u
 *
 * ⭐ **Y la fórmula NO era el problema: `c4+c8−c9` reproduce los 148 EXACTO, 148 de 148.**
 * Lo que está sucio es la TABLA: 4,499 SKUs / 11.82 M u que `kdil` arrastra y el ERP da en cero.
 * Tiene nombre y ya estaba documentado — hasta el corte del 30-sep, `md_00` **era la base de
 * PRUEBA del CEDIS**, no el CEDIS vivo (Fase CA). Lo que publicábamos era el residuo de esa base.
 *
 * ── LA REGLA, Y POR QUÉ NO ES UNA FECHA CLAVADA ────────────────────────────────────────────────
 * Se publica sólo lo que tuvo **actividad posterior al corte de la rama**, con el resolvedor que
 * ya existe (`analytics.v_branch_erp_cutover`; para la 00 dice 2026-09-30). Medido contra el
 * árbitro: **127 marcadas, 127 confirmadas — precisión 100%**.
 *
 * ⭐ La regla es **auto-sanable**, y eso es lo que la hace sostenible: las filas de residuo tienen
 * las fechas muertas en el pasado y nunca vuelven a cruzar el umbral; las vivas se actualizan solas
 * con cada movimiento. El patrón en las nueve ramas lo confirma sin sobreajuste — cuanto más viejo
 * el corte, menos residuo, hasta desaparecer:
 *
 *     rama  corte         sobrevive        rama  corte         sobrevive
 *     02    2025-10-10      100.0 %        06    2026-08-15       92.0 %
 *     01    2026-06-27      100.0 %        08    2026-09-19       89.5 %
 *     03/04/05 -infinity    100.0 %        07    2026-09-08       85.5 %
 *     00    2026-09-30        2.7 %   ← un día de antigüedad
 *
 * ⛔ **Por eso la regla se aplica SÓLO a la 00: es la única rama con árbitro.** En 01–05 sería un
 * no-op literal (100 %), pero en 06/07/08 recortaría 8–14.5 % de los SKUs sin nada con qué juzgar
 * si ese recorte es residuo o existencia real parada — y el modo de falla sería **tirar mercancía
 * buena en silencio**. Eso ya se midió acá: en la 00, de los 148 que el ERP confirma, la regla
 * atrapa 127 y **deja fuera 21 que son reales** (ver el hueco declarado). Extenderla sin árbitro
 * repetiría el error de ayer con mejor corazonada. Lo que la extiende es una sola evidencia: el
 * mismo reporte, corrido por sucursal.
 *
 * ── DOS IMPLEMENTACIONES, EL MISMO NÚMERO ──────────────────────────────────────────────────────
 * Verificar una vista contra sí misma pasa bugs en verde, así que el número se cruzó contra una
 * reconstrucción independiente: la suma de los movimientos que afectan inventario (`kdmm.c8='S'`)
 * desde el corte. **127 renglones / 340,077 u** — idéntico al snapshot filtrado, e idéntico al
 * reporte. ⚠️ Ese cruce primero dio 9× por un JOIN a `kdmm` **sin `sucursal`**: el catálogo está
 * replicado en las nueve ramas y multiplica. Anti-réplica también al unir CATÁLOGOS, no sólo hechos.
 *
 * ── ⛔ HUECOS DECLARADOS, con número (ADR-056) ─────────────────────────────────────────────────
 *  1. **21 SKUs / 17,394 u (4.9 % de lo que el ERP confirma)** entraron el 22-sep, antes del corte,
 *     y no se han movido: la regla no los ve. **Vuelven solos** en cuanto registren un movimiento.
 *     Se prefiere perderlos a aflojar el umbral: con corte al 22-sep la precisión cae a 39.3 %.
 *  2. **SKU `99225` (10 u)** queda fuera por no estar en `catalog.products`. La vista publica 126.
 *  3. **Residuo latente: 4,526 SKUs / 11.84 M u**, de los cuales **2,890 / 10.36 M u traen el
 *     acumulador sucio** (`c9>0`). Hoy NINGUNA fila publicada está contaminada (0 de 127), pero si
 *     Kepler reactiva una de esas filas, entra con sus acumuladores viejos. El candado lo vigila.
 *     ⭐ El arreglo de fondo es del lado del ERP —purgar el residuo de la base de prueba— y NO lo
 *     hacemos nosotros (ADR-040: integrar, nunca escribir al ERP).
 *
 * ── LO QUE SE RETRACTA ─────────────────────────────────────────────────────────────────────────
 * · `kdik.c6` **no es una columna de existencia**: reproduce **0 de los 148**. Cae la nota de
 *   `20261001130000` que la trataba como un testigo que "contradice en las ocho ramas" — no
 *   contradice: mide otra cosa.
 * · La regla del centinela (`c7='1800-01-01'`) tiene recall 100 % pero **precisión 8.4 %** contra
 *   el censo completo (1,757 filas marcadas, 148 reales). Queda **refutada** como regla de publicar.
 *
 * ⚠️ Si el resolvedor de corte dejara de dar fecha para la 00, el predicado da NULL y la rama
 * publica **cero**: falla cerrado a propósito — ausente y declarado le gana a presente y falso.
 * ⚠️ `security_invoker` y los GRANT se re-aplican: CREATE OR REPLACE VIEW no los hereda (ADR-057).
 */
const SQL = `
CREATE OR REPLACE VIEW analytics.v_erp_stock_on_hand AS
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pr.id AS product_id,
    pr.sku,
    GREATEST(sum(k.c4 + k.c8 - k.c9), 0::double precision)::numeric AS qty_stock_units,
    GREATEST(COALESCE(max(bfx.box_factor), 1::numeric), 1::numeric) AS display_box_factor,
    'kepler'::text AS unit_source,
    'kepler_ods'::text AS source
   FROM kepler_ods.kdil k
     JOIN commercial.warehouses w
       ON w.kepler_code = k.sucursal
      AND w.deleted_at IS NULL
     JOIN catalog.products pr
       ON pr.tenant_id = w.tenant_id AND pr.sku::text = btrim(k.c3) AND pr.deleted_at IS NULL
     LEFT JOIN analytics.v_product_box_factor bfx
       ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
  WHERE k.sucursal = k.c1
    AND (btrim(k.c3) <> ALL (ARRAY['00001'::text, '00002'::text, '00022'::text]))
    -- Sólo la rama 00 lleva el filtro de corte, porque es la única ARBITRADA (reporte de
    -- existencia del ERP, 9,496 SKUs, 01-10-2026). Subconsulta NO correlacionada: se evalúa una
    -- vez y no puede multiplicar filas. Si devuelve NULL el predicado es NULL y la 00 no publica.
    AND (w.kepler_code <> '00'::text
         OR GREATEST(k.c6, k.c7)::date >= (SELECT min(c.cutover_date)
                                             FROM analytics.v_branch_erp_cutover c
                                            WHERE c.kepler_code = '00'::text))
  GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku
UNION ALL
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pr.id AS product_id,
    pr.sku,
    GREATEST(sum(v.existencia), 0::numeric) AS qty_stock_units,
    GREATEST(COALESCE(max(CASE WHEN a.factor_venta > 1::numeric THEN a.factor_venta
                               ELSE NULL::numeric END), max(bfx.box_factor), 1::numeric),
             1::numeric) AS display_box_factor,
    CASE WHEN max(CASE WHEN a.factor_venta > 1::numeric THEN 1 ELSE 0 END) = 1
         THEN 'wincaja_multipack'::text ELSE 'wincaja'::text END AS unit_source,
    'wincaja'::text AS source
   FROM wincaja.v_stock v
     JOIN commercial.warehouses w
       ON w.tenant_id = v.tenant_id AND w.wincaja_source_branch = v.source_branch
      AND w.kepler_code IS NULL AND w.deleted_at IS NULL
     JOIN catalog.products pr
       ON pr.tenant_id = v.tenant_id AND pr.sku::text = v.sku AND pr.deleted_at IS NULL
     LEFT JOIN wincaja.articulos a
       ON a.tenant_id = v.tenant_id AND a.articulo = v.sku
      AND a.source_branch = v.source_branch AND a.source_dataset = 'actual'::text
     LEFT JOIN analytics.v_product_box_factor bfx
       ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
  WHERE v.existencia IS NOT NULL AND v.warehouse_code NOT LIKE 'RUTA-%'
  GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku`;

// Estado previo (batch 653): la 00 fuera por completo de la pierna Kepler.
const SQL_PREV = SQL
  .replace(
    `    AND (w.kepler_code <> '00'::text
         OR GREATEST(k.c6, k.c7)::date >= (SELECT min(c.cutover_date)
                                             FROM analytics.v_branch_erp_cutover c
                                            WHERE c.kepler_code = '00'::text))
`,
    '')
  .replace(
    `       ON w.kepler_code = k.sucursal
      AND w.deleted_at IS NULL`,
    `       ON w.kepler_code = k.sucursal
      AND w.kepler_code <> '00'::text
      AND w.deleted_at IS NULL`);

async function aplicar(knex, sql) {
  await knex.raw(sql);
  await knex.raw(`ALTER VIEW analytics.v_erp_stock_on_hand SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO dev_ro`);
}

exports.up = async function up(knex) {
  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_branch_erp_cutover') IS NOT NULL AS hay`)).rows;
  if (!hay) {
    throw new Error(
      'falta analytics.v_branch_erp_cutover — sin el resolvedor de corte la 00 no se puede arbitrar');
  }
  await aplicar(knex, SQL);
};

exports.down = async function down(knex) {
  await aplicar(knex, SQL_PREV);
};
