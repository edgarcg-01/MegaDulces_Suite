/**
 * `[RE.32.2]` — **La «Referencia» de la orden de entrada viaja en la vista que todos leen.**
 *
 * Pedido de los usuarios de Compras en prod (2026-10-07): ver en *Obligaciones a proveedor* el dato
 * que Kepler muestra junto a «Referencia» en el documento «Aplica Orden Entrada» (XA2001).
 *
 * ── DECODE, MEDIDO CONTRA LA PANTALLA DE KEPLER ─────────────────────────────────────────────
 * Es `kdm1.c11` de la cabecera XA2001. Testigo: Morelia Abastos (`08`) · XA2001-0000165 ·
 * proveedor CF006 · «Docto previo» XA4001-0000158 (= `c39`) · importe $139,876.62 (= `c16`) →
 * la pantalla dice **Referencia 30-0822** y `c11` trae `30-0822`. Coinciden los cuatro campos.
 * Es texto CAPTURADO A MANO (`LPA`, `S/N`, `40-S/N`…): se publica tal cual, sin normalizar.
 * Cobertura medida: 1,198 de 1,232 XA2001 desde el 1-sep-2026 (97 %) traen algo.
 *
 * Hasta hoy la vista sólo publicaba su PREFIJO (`plaza_c11`, DM.19), que se queda igual.
 *
 * ── POR QUÉ NO ROMPE A NADIE ────────────────────────────────────────────────────────────────
 * La columna va **al final** y ninguna existente cambia de nombre, orden ni tipo: los tres objetos
 * que dependen de esta vista en prod (`mv_erp_count_line_signals`, `v_erp_goods_receipt_origin`,
 * `mv_supplier_fill_rate`) no se tocan. La definición es la de `20261001290000` igual, salvo las
 * dos líneas de `referencia` (prod verificado: 34 columnas = esa migración).
 * La pierna Wincaja emite 0 filas hoy; su `referencia` es NULL (no tiene ese campo).
 *
 * ⚠️ `security_invoker = false` (corre como `postgres`), GRANT a `app_runtime` y `dev_ro`: se
 * re-aplican aunque `CREATE OR REPLACE` los preserve (ya se perdieron una vez en este repo).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);

  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_goods_receipts AS
WITH pc AS MATERIALIZED (
  SELECT * FROM analytics.v_erp_purchase_center
), pp AS (
  SELECT sucursal, bool_or(es_centro_propio) AS tiene_centro_propio FROM pc GROUP BY 1
)
 SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    ap.sucursal,
    btrim(ap.c6) AS folio,
    'XA2001'::text AS doc_prefix,
    ap.c9::date AS receipt_date,
    NULLIF(btrim(ap.c10), ''::text) AS proveedor_code,
    NULLIF(btrim(ap.c32), ''::text) AS proveedor_nombre,
    NULLIF(btrim(ap.c22), ''::text) AS proveedor_rfc,
    oe.vale_folio,
    oe.oc_folio,
    NULLIF(btrim(ap.c24), ''::text) AS concepto,
    round(COALESCE(NULLIF(regexp_replace(ap.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
    'md_'::text || ap.sucursal AS source_branch,
    now() AS computed_at,
    dd.dup_of_sucursal,
    dd.dup_of_folio,
    wk.id AS warehouse_id,
    ap.c18::date AS fecha_vence,
    NULLIF(btrim(ap.c30), ''::text) AS condicion_pago,
    ap.c18::date - ap.c9::date AS dias_credito,
    COALESCE(oe.vale_cap_fecha, ap.c68::date) AS fecha_recepcion,
        CASE
            WHEN oe.vale_cap_fecha IS NOT NULL THEN oe.vale_cap_hora
            ELSE NULLIF(btrim(ap.c69), ''::text)
        END AS fecha_recepcion_hora,
        CASE
            WHEN oe.vale_cap_fecha IS NOT NULL THEN oe.vale_cap_usuario
            ELSE NULLIF(btrim(ap.c67), ''::text)
        END AS fecha_recepcion_usuario,
        CASE
            WHEN oe.vale_cap_fecha IS NOT NULL THEN 'vale'::text
            WHEN ap.c68 IS NOT NULL THEN 'aplicacion'::text
            ELSE NULL::text
        END AS fecha_recepcion_fuente,
    NULLIF(btrim(ap.c12), '') AS centro_code,
    pc.centro_desc,
    pc.evidencia_pct AS centro_evidencia_pct,
    substring(ap.c11 from '^([0-9]+)-') AS plaza_c11,
    CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_id   END AS origen_warehouse_id,
    CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_code END AS origen_warehouse_code,
    CASE WHEN pc.es_centro_de_plaza THEN pc.plaza_warehouse_name END AS origen_warehouse_name,
    wt.name AS testigo_warehouse_name,
    CASE WHEN pc.plaza_warehouse_id IS NULL OR wt.id IS NULL THEN NULL
         ELSE pc.plaza_warehouse_id = wt.id END AS testigos_concuerdan,
    CASE
      WHEN NULLIF(btrim(ap.c12), '') IS NULL THEN 'sin_centro'
      WHEN pc.centro_code IS NULL            THEN 'centro_fuera_de_catalogo'
      WHEN NOT pc.es_centro_de_plaza         THEN 'centro_no_dice_plaza'
      WHEN NOT pp.tiene_centro_propio        THEN 'sucursal_sin_centro_propio'
      WHEN pc.es_centro_propio               THEN 'propio'
      WHEN pc.plaza_warehouse_id IS NOT NULL THEN 'otra_plaza'
      ELSE 'otra_plaza_sin_nombre'
    END AS origen_veredicto,
    NULLIF(btrim(ap.c11), ''::text) AS referencia
   FROM kepler_ods.kdm1 ap
     LEFT JOIN LATERAL ( SELECT NULLIF(btrim(oe_1.c39), ''::text) AS vale_folio,
            v.oc_folio,
            v.cap_fecha AS vale_cap_fecha,
            v.cap_hora AS vale_cap_hora,
            v.cap_usuario AS vale_cap_usuario
           FROM kepler_ods.kdm1 oe_1
             LEFT JOIN LATERAL ( SELECT NULLIF(btrim(v_1.c39), ''::text) AS oc_folio,
                    v_1.c68::date AS cap_fecha,
                    NULLIF(btrim(v_1.c69), ''::text) AS cap_hora,
                    NULLIF(btrim(v_1.c67), ''::text) AS cap_usuario
                   FROM kepler_ods.kdm1 v_1
                  WHERE v_1.sucursal = oe_1.sucursal AND btrim(v_1.c1) = v_1.sucursal AND v_1.c2 = 'X'::text AND v_1.c3 = 'A'::text AND btrim(v_1.c4::text) = '37'::text AND btrim(v_1.c6) = btrim(oe_1.c39)
                  ORDER BY (btrim(v_1.c6))
                 LIMIT 1) v ON true
          WHERE oe_1.sucursal = ap.sucursal AND btrim(oe_1.c1) = oe_1.sucursal AND oe_1.c2 = 'X'::text AND oe_1.c3 = 'A'::text AND btrim(oe_1.c4::text) = '40'::text AND btrim(oe_1.c6) = btrim(ap.c39)
          ORDER BY (btrim(oe_1.c39))
         LIMIT 1) oe ON true
     LEFT JOIN commercial.warehouses wk ON wk.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND wk.code::text = ap.sucursal AND wk.deleted_at IS NULL
     LEFT JOIN analytics.erp_goods_receipt_dedup dd ON dd.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND ap.sucursal = '00'::text AND dd.cedis_folio = btrim(ap.c6) AND (dd.status = ANY (ARRAY['auto'::text, 'confirmado'::text]))

     LEFT JOIN pc ON pc.sucursal = ap.sucursal AND pc.centro_code = btrim(ap.c12)
     LEFT JOIN pp ON pp.sucursal = ap.sucursal
     LEFT JOIN analytics.v_branch_erp_cutover ct
       ON ct.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
      AND ct.wincaja_source_branch = lpad(substring(ap.c11 from '^([0-9]+)-'), 2, '0')
     LEFT JOIN commercial.warehouses wt
       ON wt.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
      AND wt.kepler_code = ct.kepler_code AND wt.deleted_at IS NULL
  WHERE ap.c2 = 'X'::text AND ap.c3 = 'A'::text AND btrim(ap.c4::text) = '20'::text AND btrim(ap.c1) = ap.sucursal AND btrim(COALESCE(ap.c43, ''::text)) <> 'C'::text
UNION ALL
 SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    mp.source_branch AS sucursal,
    btrim(mp.documento) AS folio,
    'WCJ-'::text || btrim(mp.tipo) AS doc_prefix,
    mp.fecha::date AS receipt_date,
    NULLIF(btrim(mp.tercero), ''::text) AS proveedor_code,
    pr.nombre AS proveedor_nombre,
    pr.rfc AS proveedor_rfc,
    NULL::text AS vale_folio,
    NULL::text AS oc_folio,
    NULL::text AS concepto,
    round(COALESCE(mp.valor, 0::numeric) + COALESCE(mp.iva, 0::numeric) + COALESCE(mp.ieps, 0::numeric), 2) AS monto,
    'wincaja_'::text || mp.source_branch AS source_branch,
    now() AS computed_at,
    NULL::text AS dup_of_sucursal,
    NULL::text AS dup_of_folio,
    ww.id AS warehouse_id,
    mp.fecha_vencimiento::date AS fecha_vence,
    NULL::text AS condicion_pago,
    mp.fecha_vencimiento::date - mp.fecha::date AS dias_credito,
    NULL::date AS fecha_recepcion,
    NULL::text AS fecha_recepcion_hora,
    NULL::text AS fecha_recepcion_usuario,
    NULL::text AS fecha_recepcion_fuente,
    NULL::text AS centro_code,
    NULL::text AS centro_desc,
    NULL::numeric AS centro_evidencia_pct,
    NULL::text AS plaza_c11,
    NULL::uuid AS origen_warehouse_id,
    NULL::text AS origen_warehouse_code,
    NULL::text AS origen_warehouse_name,
    NULL::text AS testigo_warehouse_name,
    NULL::boolean AS testigos_concuerdan,
    'sin_dato_kepler'::text AS origen_veredicto,
    NULL::text AS referencia
   FROM wincaja.movimiento_proveedores mp
     JOIN wincaja.branches b ON b.tenant_id = mp.tenant_id AND b.source_branch = mp.source_branch AND b.kepler_code IS NULL AND b.warehouse_code ~~ 'MD-%'::text
     LEFT JOIN ( SELECT proveedores.source_branch,
            proveedores.proveedor,
            max(proveedores.nombre) AS nombre,
            max(proveedores.rfc) AS rfc
           FROM wincaja.proveedores
          WHERE proveedores.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
          GROUP BY proveedores.source_branch, proveedores.proveedor) pr ON pr.source_branch = mp.source_branch AND pr.proveedor = mp.tercero
     LEFT JOIN commercial.warehouses ww ON ww.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND ww.wincaja_source_branch = mp.source_branch AND ww.deleted_at IS NULL
  WHERE mp.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND mp.source_dataset = 'actual'::text AND (mp.tipo = ANY (ARRAY['CR'::text, 'CC'::text]))`);

  await knex.raw(`GRANT SELECT ON analytics.erp_goods_receipts TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.erp_goods_receipts TO dev_ro`);
};

exports.down = async function () {
  // Sin vuelta atrás: quitar una columna de una vista con dependientes exige DROP en cascada.
  // La columna es aditiva y nadie la necesita ausente.
};
