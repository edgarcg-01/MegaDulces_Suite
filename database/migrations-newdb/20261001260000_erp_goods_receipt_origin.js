/**
 * `[DM.19]` — **De qué plaza es una orden de entrada que Kepler registró en el CEDIS.**
 *
 * ── QUÉ PASÓ ────────────────────────────────────────────────────────────────────────────────
 * Reporte de Edgar (2026-10-01): *"antes Morelia Abastos y CEDIS (no sé si más sucursales)
 * subían sus órdenes de entrada a Kepler, y necesitamos tener diferenciadas cuáles eran de cada
 * una, para que no se le cargue información a CEDIS que no le corresponde"*.
 *
 * Es cierto, y **son siete plazas, no dos**. Medido sobre los 9,839 documentos `X-A-20`
 * ("Aplica Orden Entrada") que Kepler tiene en la sucursal `00`:
 *
 *     COMPRA PROVEEDOR CEDIS           2,311 docs · $206,804,400   ← lo único que es del CEDIS
 *     COMPRA PROVEEDOR MORELIA ABAST   2,510 docs · $ 95,367,762
 *     COMPRA PROVEEDOR PADRE HIDALGO   1,246 docs · $ 57,131,761
 *     COMPRA PROVEEDOR ZAMORA CANIND     768 docs · $ 56,732,747
 *     COMPRA PROVEEDOR MORELIA MADER     644 docs · $  3,585,314
 *     COMPRA PROVEEDOR 8ESQUINAS         474 docs · $  4,270,560
 *     COMPRA PROVEEDOR LA PIEDAD ABS     304 docs · $  1,138,505
 *     COMPRA PROVEEDOR YURECUARO          84 docs · $    128,376
 *     COMPRA PORVEEDOR ZAMORA CENTRO      48 docs · $  1,025,784   (sic, el typo es del ERP)
 *
 * ── ⭐ EL CATÁLOGO LO TIENE EL ERP, OTRA VEZ ────────────────────────────────────────────────
 * Igual que `pv_suc_ip` en `[DM.18]`: no hay que inferir nada. **`kdm1.c12` es el centro de
 * compra y `kepler_ods.kdxv` es su catálogo** (`c2` = código, `c3` = descripción). El ERP
 * escribe la plaza con todas sus letras.
 *
 * ⛔ **Pero el catálogo colisiona ENTRE RAMAS**: `C-010` es "COMPRA PROVEEDOR MORELIA ABAST" en
 * la rama `00` y "COMPRA PROVEEDOR PADRE HIDALGO" en la rama `01`, que lo reusó para lo suyo.
 * Por eso el join es **`kdxv.sucursal = kdm1.sucursal`**, nunca por código solo. Mismo modo de
 * falla que los dos vocabularios de `kepler_doc_tipo`.
 *
 * ── CÓMO SE VERIFICÓ (dos testigos independientes, con placebo) ─────────────────────────────
 * 1. **Dentro del documento:** `c11` trae `<plaza>-<remisión del proveedor>`. No es la serie del
 *    proveedor — el prefijo `30` abarca **108 proveedores distintos**. Concuerda con `c12` en
 *    **98.7% a 99.8%** en los 6 centros con volumen.
 * 2. **Fuera de Kepler:** los documentos se cruzaron contra `wincaja.movimiento_proveedores`
 *    (otro ERP) por importe y fecha. La diagonal se enciende sola y el placebo es plano:
 *
 *        prefijo 30 → rama 30: 62.5%   · contra las otras ramas: 0.0-1.7%
 *        prefijo 50 → rama 50: 51.9%   · contra las otras ramas: 0.0-2.7%
 *        prefijo 10 → rama 10: 46.9%   · contra las otras ramas: 0.3-3.9%
 *        prefijo  0 (CEDIS)  : 0.2% contra su propia rama — el CEDIS ya estaba en Kepler
 *
 * ── CÓMO SE NOMBRA LA PLAZA (y por qué NO se hace por texto) ────────────────────────────────
 * La descripción del catálogo viene cortada a 30 caracteres ("MORELIA ABAST", "ZAMORA CANIND")
 * y con acentos y typos. Parear ese texto contra `commercial.warehouses.name` sería adivinar.
 * En vez de eso, la plaza se **deriva de la evidencia** (`c11` dominante por centro) y se
 * resuelve con el resolvedor que ya existe, `analytics.v_branch_erp_cutover`.
 *
 * ⭐ **Y para saber si es del CEDIS no hace falta nombrar la plaza.** Dentro del catálogo de UNA
 * sucursal, dos códigos `COMPRA PROVEEDOR` distintos son dos plazas distintas. Así que basta
 * identificar cuál es el centro propio de la sucursal —el único cuya evidencia apunta a ella
 * misma— y todo otro centro de plaza es, por construcción, de otra. Eso cubre a `C-004`,
 * `C-005` y `C-021`, que el ERP nombra pero tienen poca evidencia para resolverse solos.
 *
 * ── ⛔ EL HUECO, DECLARADO (ADR-056) ────────────────────────────────────────────────────────
 * El campo `c12` se empezó a usar de verdad en **feb-2026**. Antes casi nadie lo llenaba:
 *
 *     2025-11   11% de los docs declaran centro   · $12,750,986 sin centro
 *     2025-12    9%                               · $56,073,788 sin centro
 *     2026-01   65%                               · $12,555,435 sin centro
 *     2026-02+  98-100%                           · residual
 *
 * O sea **985 documentos por $81.4M en una ventana de tres meses no se pueden atribuir**. Se
 * intentó rescatarlos contra Wincaja (`maestro_mov_almacen` tipo `C`, el único testigo con
 * historia profunda): el método tiene precisión altísima —placebo de **0.3%** contra los
 * documentos que sí sabemos que son del CEDIS— pero recall de 25%, y sólo recuperó 107
 * documentos por $850k. **No se dibuja: se declara `sin_centro`.**
 *
 * ⚠️ Y no se puede dar por CEDIS lo que sobra: el hueco promedia **$66,760** por documento,
 * entre los **$88,948** del CEDIS y los **$36,260** de las otras plazas. Es mezcla.
 *
 * ⛔ `001` "CEDIS" de la serie vieja **NO sirve** como centro propio aunque se llame así: de los
 * 137 documentos que traen el segundo testigo, **72 lo contradicen** (pureza 47%). Por eso la
 * regla exige `COMPRA P%VEEDOR%`, que esa fila no cumple.
 *
 * ── HALLAZGO COLATERAL, DECLARADO SIN RESOLVER ──────────────────────────────────────────────
 * La rama `03` (8 Esquinas) tiene el mismo patrón: **452 documentos por $9.94M en 2025** bajo el
 * centro "COMPRA MERCANCIAS LA PIEDAD AB", que se apagan en 2026 (18 docs) justo después de que
 * La Piedad estrena su propio Kepler. No se afirma la causa: no hay segundo testigo para esa
 * rama (`wincaja.movimiento_proveedores` no tiene la rama 42). La vista lo clasifica con la
 * misma regla y queda a la vista.
 *
 * ── LO QUE ESTA MIGRACIÓN NO HACE ───────────────────────────────────────────────────────────
 * **No corrige nada en Kepler** (ADR-040: el ERP es el SoR, se lee y se declara). Tampoco crea
 * tablas ni importers: son dos VISTAS `derive-no-copy` sobre `kepler_ods`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── 1. El catálogo de centros de compra, con la plaza que la evidencia le atribuye ────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_purchase_center
      WITH (security_invoker = true) AS
    WITH cat AS (
      SELECT x.sucursal, x.c2 AS centro_code, x.c3 AS centro_desc,
             (x.c3 ILIKE 'COMPRA P%VEEDOR%') AS es_centro_de_plaza
        FROM kepler_ods.kdxv x
       WHERE COALESCE(x.c2, '') <> ''
    ), ev AS (
      -- Segundo testigo: c11 trae <plaza>-<remision>. Se cuenta, no se asume.
      SELECT m.sucursal, m.c12 AS centro_code,
             substring(m.c11 from '^([0-9]+)-') AS plaza, count(*)::int AS n
        FROM kepler_ods.kdm1 m
       WHERE m.c2 = 'X' AND m.c3 = 'A' AND m.c4 = 20 AND m.c11 ~ '^[0-9]+-'
       GROUP BY 1, 2, 3
    ), dom AS (
      SELECT sucursal, centro_code, plaza, n,
             sum(n)       OVER (PARTITION BY sucursal, centro_code) AS n_total,
             row_number() OVER (PARTITION BY sucursal, centro_code ORDER BY n DESC) AS rk
        FROM ev
    ), res AS (
      SELECT c.sucursal, c.centro_code, c.centro_desc, c.es_centro_de_plaza,
             d.plaza AS plaza_dominante, d.n AS evidencia_n, d.n_total AS evidencia_total,
             CASE WHEN d.n_total > 0 THEN round(100.0 * d.n / d.n_total, 1) END AS evidencia_pct,
             -- Se nombra la plaza solo con evidencia suficiente. Por debajo se DECLARA, no se
             -- elige: es exactamente como nacio el bug de [DM.11e] (13% de evidencia).
             (d.n_total >= 20 AND 100.0 * d.n / d.n_total >= 90) AS evidencia_alcanza
        FROM cat c
        LEFT JOIN dom d
          ON d.sucursal = c.sucursal AND d.centro_code = c.centro_code AND d.rk = 1
    )
    SELECT w.tenant_id,
           r.sucursal, r.centro_code, r.centro_desc, r.es_centro_de_plaza,
           r.plaza_dominante, r.evidencia_n, r.evidencia_total, r.evidencia_pct,
           CASE WHEN r.evidencia_alcanza THEN wp.id   END AS plaza_warehouse_id,
           CASE WHEN r.evidencia_alcanza THEN wp.code END AS plaza_warehouse_code,
           CASE WHEN r.evidencia_alcanza THEN wp.name END AS plaza_warehouse_name,
           -- El centro PROPIO de la sucursal: el unico de plaza cuya evidencia apunta a ella
           -- misma. De el cuelga toda la clasificacion, sin parear texto con nombres.
           COALESCE(r.es_centro_de_plaza AND r.evidencia_alcanza
                    AND wp.kepler_code = w.kepler_code, false) AS es_centro_propio
      FROM res r
      JOIN commercial.warehouses w
        ON w.kepler_code = r.sucursal AND w.deleted_at IS NULL
      LEFT JOIN analytics.v_branch_erp_cutover cut
        ON cut.tenant_id = w.tenant_id
       AND cut.wincaja_source_branch = lpad(r.plaza_dominante, 2, '0')
      LEFT JOIN commercial.warehouses wp
        ON wp.tenant_id = w.tenant_id AND wp.kepler_code = cut.kepler_code
       AND wp.deleted_at IS NULL`);

  await knex.raw(`GRANT SELECT ON analytics.v_erp_purchase_center TO app_runtime`);

  // ── 2. El veredicto por documento ─────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_goods_receipt_origin
      WITH (security_invoker = true) AS
    WITH doc AS (
      SELECT m.sucursal, m.c6 AS folio, m.c5 AS doc_serie,
             NULLIF(btrim(m.c63, '-'), '') AS doc_prefix,
             m.c9::date AS receipt_date, m.c16::numeric AS importe,
             m.c10 AS proveedor_code, m.c32 AS proveedor_nombre,
             m.c11 AS referencia, NULLIF(m.c12, '') AS centro_code,
             substring(m.c11 from '^([0-9]+)-') AS plaza_c11
        FROM kepler_ods.kdm1 m
       WHERE m.c2 = 'X' AND m.c3 = 'A' AND m.c4 = 20
    ), propio AS (
      -- Una sucursal solo puede clasificar "de otra plaza" si primero reconocio la suya.
      SELECT sucursal, bool_or(es_centro_propio) AS tiene_centro_propio
        FROM analytics.v_erp_purchase_center GROUP BY 1
    )
    SELECT ws.tenant_id,
           d.sucursal, d.folio, d.doc_serie, d.doc_prefix, d.receipt_date, d.importe,
           d.proveedor_code, d.proveedor_nombre, d.referencia,
           d.centro_code, pc.centro_desc, pc.es_centro_de_plaza, d.plaza_c11,
           pc.evidencia_pct   AS centro_evidencia_pct,
           pc.evidencia_total AS centro_evidencia_n,
           ws.id   AS sucursal_warehouse_id,
           ws.code AS sucursal_warehouse_code,
           -- ⚠️ El camino AUTORITATIVO solo se llena cuando el centro es de plaza. Un centro
           -- como "COMISIONES VENTAS" tiene evidencia (139 de 140 traen referencia '30-') pero
           -- NO es un centro de compra: si se publicara aqui, un consumidor que lea el id sin
           -- mirar el veredicto le cargaria comisiones a Morelia Abastos como si fueran compras.
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_id   END AS origen_warehouse_id,
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_code END AS origen_warehouse_code,
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_name END AS origen_warehouse_name,
           -- El SEGUNDO testigo, por fila y crudo: la plaza que declara la referencia del
           -- proveedor. Se publica aparte para que nadie lo confunda con lo que dice el ERP.
           wt.id   AS testigo_warehouse_id,
           wt.name AS testigo_warehouse_name,
           CASE WHEN pc.plaza_warehouse_id IS NULL OR wt.id IS NULL THEN NULL
                ELSE pc.plaza_warehouse_id = wt.id END AS testigos_concuerdan,
           CASE
             WHEN d.centro_code IS NULL             THEN 'sin_centro'
             WHEN pc.centro_code IS NULL            THEN 'centro_fuera_de_catalogo'
             WHEN NOT pc.es_centro_de_plaza         THEN 'centro_no_dice_plaza'
             WHEN NOT p.tiene_centro_propio         THEN 'sucursal_sin_centro_propio'
             WHEN pc.es_centro_propio               THEN 'propio'
             WHEN pc.plaza_warehouse_id IS NOT NULL THEN 'otra_plaza'
             ELSE 'otra_plaza_sin_nombre'
           END AS origen_veredicto
      FROM doc d
      JOIN commercial.warehouses ws
        ON ws.kepler_code = d.sucursal AND ws.deleted_at IS NULL
      JOIN propio p ON p.sucursal = d.sucursal
      LEFT JOIN analytics.v_erp_purchase_center pc
        ON pc.sucursal = d.sucursal AND pc.centro_code = d.centro_code
      LEFT JOIN analytics.v_branch_erp_cutover ct
        ON ct.tenant_id = ws.tenant_id
       AND ct.wincaja_source_branch = lpad(d.plaza_c11, 2, '0')
      LEFT JOIN commercial.warehouses wt
        ON wt.tenant_id = ws.tenant_id AND wt.kepler_code = ct.kepler_code
       AND wt.deleted_at IS NULL`);

  await knex.raw(`GRANT SELECT ON analytics.v_erp_goods_receipt_origin TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_goods_receipt_origin`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_purchase_center`);
};
