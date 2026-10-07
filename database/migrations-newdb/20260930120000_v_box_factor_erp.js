/* eslint-disable */
/**
 * `[SOU.1]` — **El factor de caja, tal como lo DECLARA el ERP que manda en esa plaza.**
 *
 * Regla de negocio (Edgar, 2026-09-29): *"la única regla que debe existir es la que usa Kepler,
 * y para pasados la de Wincaja. No debemos inventarnos ninguna unidad de medida o fórmula."*
 *
 * ── QUÉ RESUELVE, MEDIDO EN PROD (2026-09-29 · 3 meses · 147.1 MDP de venta en pieza) ───────
 * El sell-out convertía a cajas con `analytics.v_product_box_factor`, unido SÓLO por
 * `product_id`: un factor por producto para todas las plazas.
 *   · 17.51 MDP salían SIN factor porque las plazas discrepaban, aunque cada plaza tenía su
 *     propia respuesta.
 *   · 7.34 MDP publicaban un factor PRESTADO de otras plazas. El 100% son las seis rutas de
 *     Padre Hidalgo (RUTA-21/22/23/26/27/28).
 *   · 47.57 MDP son venta de época Wincaja que recibía el factor de Kepler, porque el
 *     resolvedor por almacén guarda UN erp por plaza y no sabe de fechas.
 *
 * ── LO QUE ESTA VISTA HACE, Y LO QUE NO ─────────────────────────────────────────────────────
 * Expone, por (plaza, producto), **las dos declaraciones** —la de Kepler y la de Wincaja— más
 * la fecha de corte. **No elige**: elegir depende de la fecha del renglón, y esa la tiene el
 * consumidor. Un `CASE` visible en el punto de uso le gana a una precedencia escondida acá.
 *
 * ⛔ Sólo DECLARACIONES del ERP, no derivaciones. Entra `kdii.c84` (Kepler) y
 * `wincaja.articulos.factor_venta` (Wincaja). NO entran `kepler_escalera`,
 * `kepler_peldano_vendido` ni `kepler_unidad_unica`: son fórmulas sobre datos de Kepler, y la
 * regla dice que no inventemos fórmulas. Tampoco la etiquetera ni los overrides.
 * ⚠️ Eso tiene precio y está medido: Kepler declara `c84` en ~2,690 de ~9,630 productos por
 * sucursal (28%). Donde calla, esta vista devuelve NULL — y NULL acá significa "el ERP no lo
 * declara", nunca 1. Publicar 1 sería rotular piezas como cajas.
 * ⭐ Donde Kepler sí habla ya le hacíamos caso: 76.44 MDP coinciden con el `c84` crudo contra
 * 21,100.23 que lo contradicen (99.97%). Esta vista no viene a corregir eso; viene a que la
 * PLAZA y la FECHA dejen de ser las equivocadas.
 *
 * ── EL MAPEO A WINCAJA NO SE INVENTA: SE LEE, EN TRES ESCALONES ─────────────────────────────
 *  1. `commercial.warehouses.wincaja_source_branch`, cuando está.
 *  2. `analytics.v_branch_erp_cutover`, que es el lugar canónico del par Wincaja↔Kepler y sí lo
 *     trae para las plazas migradas (01→10, 02→42, 07→32). Sin esto esas tres quedaban con CERO
 *     declaración de Wincaja y su época Wincaja se convertía con el factor de Kepler.
 *  3. El patrón que las siete rutas ya mapeadas siguen sin excepción (`RUTA-321→321`,
 *     `RUTA-501→501`, `RUTA-505→505`…). Leerlo para las seis que faltan REPRODUCE el mapeo
 *     existente, no propone uno nuevo. Medido: recupera 9.45 de 9.65 MDP (97.9%).
 *
 * ⛔ **NO se escribe `commercial.warehouses.wincaja_source_branch`**, a propósito. Esa columna la
 * leen 25 archivos —entre ellos `v_branch_erp_cutover`, la compuerta del CEDIS, el candado de
 * paridad del sell-out y el módulo de zonas—, así que poblarla metería seis plazas nuevas en el
 * resolvedor de corte y movería el dedup del sell-out. El mapeo que necesita ESTA vista vive
 * acá, sin radio.
 *
 * ⚠️ El CEDIS (`00`) queda sin `cutover_date`: no está registrado en el resolvedor de corte. Se
 * DECLARA como NULL en vez de asumirle una fecha. No afecta al sell-out (el CEDIS no aparece
 * ahí: cero filas en `mv_sellout_monthly`), pero sí a inventario y compras, que leen el factor.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_box_factor_erp AS
    WITH plaza AS (
      SELECT w.tenant_id,
             w.id   AS warehouse_id,
             w.code AS warehouse_code,
             w.kepler_code,
             COALESCE(w.wincaja_source_branch,
                      x.wincaja_source_branch,
                      CASE WHEN w.code ~ '^RUTA-[0-9]+$' THEN substring(w.code FROM 6) END)
                    AS wincaja_branch,
             x.cutover_date
        FROM commercial.warehouses w
        LEFT JOIN analytics.v_branch_erp_cutover x
               ON x.tenant_id = w.tenant_id
              AND (x.warehouse_code = w.code OR x.kepler_code = w.kepler_code)
       WHERE w.deleted_at IS NULL
    ),
    kep AS (
      SELECT pl.tenant_id, pl.warehouse_id, p.id AS product_id,
             max(i.c84::numeric) AS box_factor
        FROM plaza pl
        JOIN kepler_ods.kdii i ON btrim(i.sucursal) = pl.kepler_code
        JOIN catalog.products p ON p.tenant_id = pl.tenant_id
                               AND btrim(p.sku::text) = btrim(i.c1::text)
                               AND p.deleted_at IS NULL
       WHERE pl.kepler_code IS NOT NULL
         AND i.c84 IS NOT NULL AND i.c84::numeric > 0
       GROUP BY 1,2,3
    ),
    win AS (
      SELECT pl.tenant_id, pl.warehouse_id, p.id AS product_id,
             max(a.factor_venta) AS box_factor
        FROM plaza pl
        JOIN wincaja.articulos a ON a.tenant_id = pl.tenant_id
                                AND a.source_branch = pl.wincaja_branch
                                AND a.source_dataset = 'actual'
        JOIN catalog.products p ON p.tenant_id = pl.tenant_id
                               AND btrim(p.sku::text) = btrim(a.articulo)
                               AND p.deleted_at IS NULL
       WHERE pl.wincaja_branch IS NOT NULL
         AND a.factor_venta IS NOT NULL AND a.factor_venta > 0
       GROUP BY 1,2,3
    ),
    llaves AS (
      SELECT tenant_id, warehouse_id, product_id FROM kep
      UNION
      SELECT tenant_id, warehouse_id, product_id FROM win
    )
    SELECT pl.tenant_id,
           pl.warehouse_id,
           pl.warehouse_code,
           l.product_id,
           pl.kepler_code,
           pl.wincaja_branch,
           pl.cutover_date,
           k.box_factor AS kepler_box_factor,
           v.box_factor AS wincaja_box_factor,
           CASE WHEN k.box_factor IS NULL AND v.box_factor IS NULL THEN 'ningun_erp_declara'
                WHEN k.box_factor IS NULL                          THEN 'solo_wincaja_declara'
                WHEN v.box_factor IS NULL                          THEN 'solo_kepler_declara'
                WHEN k.box_factor = v.box_factor                   THEN 'ambos_declaran_igual'
                ELSE 'ambos_declaran_distinto'
           END AS declaracion
      FROM llaves l
      JOIN plaza pl ON pl.tenant_id = l.tenant_id AND pl.warehouse_id = l.warehouse_id
      LEFT JOIN kep k ON k.tenant_id = l.tenant_id AND k.warehouse_id = l.warehouse_id
                     AND k.product_id = l.product_id
      LEFT JOIN win v ON v.tenant_id = l.tenant_id AND v.warehouse_id = l.warehouse_id
                     AND v.product_id = l.product_id
  `);
  // ⚠️ `security_invoker` y el GRANT NO se heredan al recrear una vista sobre relaciones con RLS
  // (ADR-057 perdió esto una vez y sólo lo vio la aserción de metadata del candado).
  await knex.raw(`ALTER VIEW analytics.v_box_factor_erp SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_box_factor_erp TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_box_factor_erp IS
    '[SOU.1] Factor de caja tal como lo DECLARA cada ERP por plaza. No elige: expone las dos declaraciones mas la fecha de corte para que el consumidor elija por la fecha del renglon. Solo declaraciones (kdii.c84, wincaja.articulos.factor_venta); nunca derivaciones, etiquetera ni override.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_box_factor_erp`);
};
