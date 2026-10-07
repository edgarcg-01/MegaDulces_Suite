/**
 * `[DM.19.1]` — **El resolvedor de origen tiene que mirar el MISMO universo que la pantalla.**
 *
 * ── POR QUÉ ESTA MIGRACIÓN EXISTE ───────────────────────────────────────────────────────────
 * `[DM.19]` publicó el veredicto de origen sobre **todo** `kdm1`, y la vista que la pantalla lee
 * (`analytics.erp_goods_receipts`) recorta su universo con dos filtros que yo no había copiado:
 *
 *     btrim(ap.c1) = ap.sucursal            -- sólo el almacén propio de la sucursal
 *     btrim(COALESCE(ap.c43,'')) <> 'C'     -- fuera los cancelados
 *
 * Sin el primero, **la vista no es única por `(sucursal, folio, doc_prefix)`** —14,059 filas
 * contra 13,554 llaves— y engancharla a la pantalla con un `LEFT JOIN` **inflaba** el listado:
 * la sucursal `03` pasaba de 1,007 a 1,510 renglones. Es exactamente el modo de falla que ya
 * tuvo su propia migración (`20260819140000_fix_erp_goods_receipts_fanout`).
 *
 * ⚠️ **Y el 1,510 que medí primero no era un dato: era la inflación de mi propio join.** Un
 * `count(*)` del lado izquierdo de un `LEFT JOIN` cuenta el fan-out, no las filas de la tabla.
 *
 * ── ⛔ LA CORRECCIÓN DE FONDO: EL "HALLAZGO COLATERAL" DE LA RAMA 03 ESTABA MAL PLANTEADO ───
 * `[DM.19]` declaró que la rama `03` repetía el patrón del CEDIS: *"452 documentos por $9.94M en
 * 2025 bajo COMPRA MERCANCIAS LA PIEDAD AB"*. **Medido con el almacén a la vista, es falso:**
 *
 *     almacén propio (03)      → "LA PIEDAD"   **1 documento · $1**
 *     RÉPLICA del almacén 02   → "LA PIEDAD"   467 documentos · $10,332,920
 *     RÉPLICA del almacén 01   → "LA PIEDAD"     2 documentos · $4,800
 *
 * O sea: **469 de 470 son filas de réplica**, el caso ya conocido y documentado en
 * `VERDAD_ABSOLUTA.md` §9.9 (la `03` arrastra el almacén `02`, congelado el 2026-01-07, con
 * identidad documental probada: 501 de 501 idénticos en folio, serie, fecha e importe). Esos
 * documentos **dicen "LA PIEDAD" porque SON de La Piedad**, y la pantalla nunca los mostró
 * porque el publicador ya los filtraba. No hay segundo caso del problema del CEDIS.
 *
 * ⭐ La lección: *agrupar sin la columna de identidad convierte una réplica en un hallazgo.*
 * Misma familia que `[IC.0]`, donde la sucursal `03` arrastraba 220 cabeceras del almacén `02`
 * y el candado sólo lo vio al cruzar dos implementaciones.
 *
 * ── QUÉ CAMBIA ──────────────────────────────────────────────────────────────────────────────
 * Las dos vistas pasan a mirar el universo del publicador. La evidencia de
 * `v_erp_purchase_center` también se recalcula sin las filas de réplica — si no, los centros de
 * una sucursal se miden con documentos de otra.
 *
 * ⚠️ `security_invoker` y el `GRANT` se vuelven a aplicar: un `CREATE OR REPLACE VIEW` **no los
 * hereda**, y la omisión no se nota hasta que alguien abre la pantalla con el rol de la app.
 *
 * @param { import("knex").Knex } knex
 */

// El universo del publicador, en un solo lugar para que no vuelva a divergir.
// Copiado de `analytics.erp_goods_receipts` (mig 20260819120000), no inventado.
const UNIVERSO = (a) => `${a}.c2 = 'X' AND ${a}.c3 = 'A' AND btrim(${a}.c4::text) = '20'
         AND btrim(${a}.c1) = ${a}.sucursal
         AND btrim(COALESCE(${a}.c43, '')) <> 'C'`;

exports.up = async function (knex) {
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
      -- ⚠️ Sin el filtro de almacen, los centros de una sucursal se medirian con documentos
      -- replicados de OTRA: la rama 03 aportaba 467 docs del almacen 02 rotulados "LA PIEDAD".
      SELECT m.sucursal, m.c12 AS centro_code,
             substring(m.c11 from '^([0-9]+)-') AS plaza, count(*)::int AS n
        FROM kepler_ods.kdm1 m
       WHERE ${UNIVERSO('m')} AND m.c11 ~ '^[0-9]+-'
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

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_goods_receipt_origin
      WITH (security_invoker = true) AS
    WITH doc AS (
      SELECT m.sucursal, btrim(m.c6) AS folio, m.c5 AS doc_serie,
             'XA2001'::text AS doc_prefix,
             m.c9::date AS receipt_date, m.c16::numeric AS importe,
             m.c10 AS proveedor_code, m.c32 AS proveedor_nombre,
             m.c11 AS referencia, NULLIF(btrim(m.c12), '') AS centro_code,
             substring(m.c11 from '^([0-9]+)-') AS plaza_c11
        FROM kepler_ods.kdm1 m
       WHERE ${UNIVERSO('m')}
    ), propio AS (
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
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_id   END AS origen_warehouse_id,
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_code END AS origen_warehouse_code,
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_name END AS origen_warehouse_name,
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

exports.down = async function () {
  // Sin vuelta atras: revertir dejaria las vistas mirando un universo distinto al de la
  // pantalla, que es justo el defecto que esta migracion corrige.
};
