/**
 * `[DM.19.2]` — **La vista de origen tardaba 20.5 s. Ahora 0.6 s.**
 *
 * ── QUÉ PASABA ──────────────────────────────────────────────────────────────────────────────
 * `v_erp_goods_receipt_origin` referencia a `v_erp_purchase_center` **dos veces** (una para el
 * `LEFT JOIN` por centro y otra para saber si la sucursal reconoce un centro propio). El planner
 * no la materializaba: la re-evaluaba dentro de un nested loop, una vez por documento.
 *
 *     la vista de centros, sola          →   0.244 s  (138 filas)
 *     la vista de documentos, sucursal 00 →  20.467 s  ⛔ el gate es < 1 s
 *
 * ⭐ La causa NO era el filtro nuevo de `[DM.19.1]`: el índice `idx_kdm1_xa_doc` cubre
 * `(sucursal, btrim(c4::text), btrim(c6)) WHERE c2='X' AND c3='A'`, que es exactamente la forma
 * en que se escribió. *Una vista barata referenciada dos veces puede costar 80× — el problema no
 * siempre está en la tabla grande.*
 *
 * ── EL ARREGLO ──────────────────────────────────────────────────────────────────────────────
 * Un `WITH pc AS MATERIALIZED (SELECT * FROM analytics.v_erp_purchase_center)` fuerza a
 * calcularla **una sola vez**, y de ahí cuelgan tanto el join como el `propio`.
 *
 * ⚠️ **No se duplica la lógica**: `v_erp_purchase_center` sigue siendo la única definición de
 * cómo se resuelve un centro de compra. Materializarla en un CTE es reusarla, no re-derivarla —
 * la alternativa (copiar sus CTEs acá) sería el primitivo con dos implementaciones.
 *
 * Tampoco se convierte en matvista: cuesta 244 ms, y una matvista pediría refresco agendado para
 * un dato que hoy está fresco sin mantenimiento.
 *
 * Medido tras el cambio, sucursal `00` (universo ya alineado al publicador por `[DM.19.1]`):
 *
 *     otra_plaza              5,414 docs · $217,088,146
 *     propio (CEDIS)          2,265 docs · $206,804,400
 *     centro_no_dice_plaza    1,194 docs · $ 88,823,147
 *     otra_plaza_sin_nombre     406 docs · $  2,292,666
 *     sin_centro                 45 docs · $  2,670,520
 *
 * ⚠️ Contra `[DM.19]`, bajan los documentos (salen cancelados y réplica) y **el dinero ajeno no
 * se mueve**: $219,380,812 antes y después. Lo que salió no tenía importe.
 *
 * ⚠️ `security_invoker` y el `GRANT` se vuelven a aplicar: un `CREATE OR REPLACE VIEW` no los
 * hereda.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_goods_receipt_origin
      WITH (security_invoker = true) AS
    WITH pc AS MATERIALIZED (
      -- Una sola evaluacion. Sin esto el planner la mete en un nested loop por documento.
      SELECT * FROM analytics.v_erp_purchase_center
    ), propio AS (
      -- Una sucursal solo puede clasificar "de otra plaza" si primero reconocio la suya.
      SELECT sucursal, bool_or(es_centro_propio) AS tiene_centro_propio FROM pc GROUP BY 1
    ), doc AS (
      -- El universo del publicador (analytics.erp_goods_receipts), copiado no inventado:
      -- solo el almacen propio de la sucursal (si no, entra la replica) y sin cancelados.
      SELECT m.sucursal, btrim(m.c6) AS folio, m.c5 AS doc_serie,
             'XA2001'::text AS doc_prefix,
             m.c9::date AS receipt_date, m.c16::numeric AS importe,
             m.c10 AS proveedor_code, m.c32 AS proveedor_nombre,
             m.c11 AS referencia, NULLIF(btrim(m.c12), '') AS centro_code,
             substring(m.c11 from '^([0-9]+)-') AS plaza_c11
        FROM kepler_ods.kdm1 m
       WHERE m.c2 = 'X' AND m.c3 = 'A' AND btrim(m.c4::text) = '20'
         AND btrim(m.c1) = m.sucursal
         AND btrim(COALESCE(m.c43, '')) <> 'C'
    )
    SELECT ws.tenant_id,
           d.sucursal, d.folio, d.doc_serie, d.doc_prefix, d.receipt_date, d.importe,
           d.proveedor_code, d.proveedor_nombre, d.referencia,
           d.centro_code, pc.centro_desc, pc.es_centro_de_plaza, d.plaza_c11,
           pc.evidencia_pct   AS centro_evidencia_pct,
           pc.evidencia_total AS centro_evidencia_n,
           ws.id   AS sucursal_warehouse_id,
           ws.code AS sucursal_warehouse_code,
           -- ⚠️ El camino AUTORITATIVO solo se llena cuando el centro es de compra. Un centro
           -- como "COMISIONES VENTAS" tiene evidencia alta pero publicarla aqui le cargaria
           -- comisiones a esa plaza como si fueran compras.
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_id   END AS origen_warehouse_id,
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_code END AS origen_warehouse_code,
           CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_name END AS origen_warehouse_name,
           -- El SEGUNDO testigo, por fila y crudo: la plaza que declara la referencia del
           -- proveedor. Aparte, para que nadie lo confunda con lo que dice el ERP.
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
      LEFT JOIN pc
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
  // Sin vuelta atras: revertir devolveria la vista a 20.5 s.
};
