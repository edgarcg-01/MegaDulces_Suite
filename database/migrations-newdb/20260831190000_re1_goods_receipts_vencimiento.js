/**
 * `[RE.1]` — **El ancla aprende cuándo se paga**: `fecha_vence`, `condicion_pago`, `dias_credito`.
 *
 * `analytics.erp_goods_receipts` sabía QUÉ llegó y por CUÁNTO, pero no CUÁNDO se debe. Sin eso no
 * hay aging ni cartera por pagar (RE.3), que es justo lo que el Excel de recepción hacía peor.
 *
 * **Decode verificado contra 12,200 documentos reales (2026-08-31), no supuesto:**
 *   · `c18` poblada en **12,200 / 12,200**; se comporta como fecha y es ≥ `c9` en 12,198.
 *   · `c30` poblada en 12,199, texto legible: "Pago de contado", "30 días fecha factura", …
 *   · `c18 − c9` casa con el plazo declarado en **99.92%** (3,873/3,876) dentro de ±3 días.
 *
 * **⚠️ "30 días" en Kepler es UN MES DE CALENDARIO, no 30 días exactos.** Medido: la condición
 * *"30 días fecha factura"* da **31** días en 711 documentos y **28** en 111 — el largo del mes de
 * origen. Sólo 3 documentos quedan fuera de ±3 (5, 21 y 30 días), que son calidad de dato.
 *
 * **Por eso `c18` se guarda TAL CUAL y no se recalcula desde `c30`.** El texto es la ETIQUETA del
 * plazo comercial; la fecha es la autoridad. Derivar `fecha + 30 días` habría inventado un
 * vencimiento distinto al que el ERP —y el proveedor— tienen, en 822 documentos.
 *
 * **`dias_credito` puede salir negativo** (2 documentos con −1). Se deja crudo a propósito: es
 * calidad de dato del ERP y clamparlo a 0 lo escondería. Quien consuma decide cómo mostrarlo.
 *
 * **Dato que dimensiona RE.3:** el **68%** (8,323/12,200) es *"Pago de contado"* → vence el mismo
 * día y no genera cuenta por pagar a plazo. El aging real corre sobre las ~3,874 restantes.
 *
 * **Wincaja (30/32/50): mapeado pero SIN VERIFICAR.** `movimiento_proveedores.fecha_vencimiento`
 * existe en el esquema, pero la tabla está **vacía en local** (0 filas), así que la cobertura y el
 * formato no se pudieron comprobar. `condicion_pago` va NULL: Wincaja no tiene equivalente, y
 * poner "contado" habría sido inventar. Revisar cuando el feed corra.
 *
 * **La póliza NO entra acá** (el plan la listaba). Tres razones: `analytics.gl_polizas` está vacía
 * en local → el join sería inverificable; `polizaForReceipt` ya la sirve bajo demanda para el
 * detalle; y una subconsulta correlacionada en esta vista correría **12,200 veces** en el listado
 * para un dato que sólo se mira al abrir un documento.
 *
 * `CREATE OR REPLACE` (no DROP): las columnas se **agregan al final** respetando nombre, tipo y
 * orden de las existentes, que es lo único que Postgres permite reemplazar en caliente. Verificado
 * que ninguna vista depende de ésta.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) return;   // entorno sin ODS: nada que derivar
  const esVista = await knex.raw(
    `SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_goods_receipts')`);
  if (esVista.rows[0]?.relkind !== 'v') return;  // aún es la tabla snapshot: no aplica

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_goods_receipts AS
    SELECT '${M}'::uuid AS tenant_id,
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
       -- RE.1 ── el vencimiento lo dice el ERP; no se deriva de la condición.
       ap.c18::date AS fecha_vence,
       NULLIF(btrim(ap.c30::text), ''::text) AS condicion_pago,
       (ap.c18::date - ap.c9::date) AS dias_credito
      FROM kepler_ods.kdm1 ap
        LEFT JOIN LATERAL ( SELECT NULLIF(btrim(oe_1.c39), ''::text) AS vale_folio,
               ( SELECT NULLIF(btrim(v.c39), ''::text) AS "nullif"
                      FROM kepler_ods.kdm1 v
                     WHERE v.sucursal = oe_1.sucursal AND v.c2 = 'X'::text AND v.c3 = 'A'::text AND btrim(v.c4::text) = '37'::text AND btrim(v.c6) = btrim(oe_1.c39)
                     ORDER BY (btrim(v.c6))
                    LIMIT 1) AS oc_folio
              FROM kepler_ods.kdm1 oe_1
             WHERE oe_1.sucursal = ap.sucursal AND oe_1.c2 = 'X'::text AND oe_1.c3 = 'A'::text AND btrim(oe_1.c4::text) = '40'::text AND btrim(oe_1.c6) = btrim(ap.c39)
             ORDER BY (btrim(oe_1.c39))
            LIMIT 1) oe ON true
        LEFT JOIN warehouses wk ON wk.tenant_id = '${M}'::uuid AND wk.code::text = ap.sucursal AND wk.deleted_at IS NULL
        LEFT JOIN analytics.erp_goods_receipt_dedup dd ON dd.tenant_id = '${M}'::uuid AND ap.sucursal = '00'::text AND dd.cedis_folio = btrim(ap.c6) AND (dd.status = ANY (ARRAY['auto'::text, 'confirmado'::text]))
     WHERE ap.c2 = 'X'::text AND ap.c3 = 'A'::text AND btrim(ap.c4::text) = '20'::text AND btrim(ap.c1) = ap.sucursal
    UNION ALL
    SELECT '${M}'::uuid AS tenant_id,
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
       -- RE.1 ── Wincaja trae su propio vencimiento. SIN VERIFICAR: la tabla está vacía en local.
       mp.fecha_vencimiento::date AS fecha_vence,
       -- Wincaja no tiene condición de pago; poner 'contado' sería inventarla.
       NULL::text AS condicion_pago,
       (mp.fecha_vencimiento::date - mp.fecha::date) AS dias_credito
      FROM wincaja.movimiento_proveedores mp
        JOIN wincaja.branches b ON b.tenant_id = mp.tenant_id AND b.source_branch = mp.source_branch AND b.kepler_code IS NULL AND b.warehouse_code ~~ 'MD-%'::text
        LEFT JOIN ( SELECT proveedores.source_branch,
               proveedores.proveedor,
               max(proveedores.nombre) AS nombre,
               max(proveedores.rfc) AS rfc
              FROM wincaja.proveedores
             WHERE proveedores.tenant_id = '${M}'::uuid
             GROUP BY proveedores.source_branch, proveedores.proveedor) pr ON pr.source_branch = mp.source_branch AND pr.proveedor = mp.tercero
        LEFT JOIN warehouses ww ON ww.tenant_id = '${M}'::uuid AND ww.wincaja_source_branch = mp.source_branch AND ww.deleted_at IS NULL
     WHERE mp.tenant_id = '${M}'::uuid AND mp.source_dataset = 'actual'::text AND (mp.tipo = ANY (ARRAY['CR'::text, 'CC'::text]))
  `);

  await knex.raw(`GRANT SELECT ON analytics.erp_goods_receipts TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW analytics.erp_goods_receipts IS
    'Vista derive-no-copy: recepciones EN VIVO desde kepler_ods.kdm1 (XA2001+cadena, anti-replica c1=sucursal) '
    'UNION Wincaja movimiento_proveedores (CR/CC). RE.1 agrega fecha_vence (c18, autoritativa: NO se '
    'deriva de la condicion porque el ERP la ajusta a mano), condicion_pago (c30, texto) y dias_credito '
    '(c18-c9, puede ser negativo en 2 docs: es calidad de dato del ERP, no se clampa). El 68% es '
    'Pago de contado -> vence el mismo dia. Wincaja: vencimiento mapeado pero SIN VERIFICAR (tabla vacia '
    'en local). La poliza NO vive aca: la sirve polizaForReceipt bajo demanda.'`);
};

/**
 * No-op deliberado. El cambio es **aditivo**: tres columnas al final de una vista, que ningún
 * consumidor previo lee. Revertir exigiría `DROP VIEW` (Postgres no permite quitar columnas con
 * `CREATE OR REPLACE`) y recrear la definición anterior desde otra migración — o sea, dejar la
 * app sin su vista principal a mitad del rollback para deshacer algo que no molesta a nadie.
 * Si de verdad hay que quitarlas, se re-corre `20260827160000_goods_receipt_twins`, que es la
 * dueña previa de la definición.
 */
exports.down = async function () {
  /* aditivo: no se revierte */
};
