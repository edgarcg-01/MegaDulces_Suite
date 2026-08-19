/**
 * FIX correctitud de `analytics.erp_goods_receipts` (vista derive-no-copy de 20260819120000):
 *
 * Bug: los LEFT JOIN de cadena a X-A-40 (oe) y X-A-37 (v) hacían **fan-out** — una recepción
 * (XA2001) aparecía N veces (folio 396/398 salían 4× c/u) y `proveedor_nombre` se tomaba del
 * vale `v.c32`, que trae **nombres de sucursal/almacén** ("SUCURSAL PADRE HIDALGO", "MORELIA
 * ABASTOS"), NO del proveedor. Inflaba el conteo ~13% (13,269 vs 11,780 XA2001 reales).
 *
 * Causa: el header XA2001 YA trae el proveedor correcto en `c32` (nombre) y `c22` (RFC) —
 * ej. folio 398 c32='SAN SEBASTIAN', folio 396 c32='CUERITOS LUPITA'. No hace falta el vale.
 *
 * Fix:
 *   - proveedor_nombre/proveedor_rfc ← directo del header `ap` (XA2001).
 *   - vale_folio/oc_folio ← LATERAL … LIMIT 1 (metadata de cadena sin fan-out).
 * Resultado: 1 fila por recepción. `CREATE OR REPLACE VIEW` (mismas columnas/tipos/orden).
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_goods_receipts AS
    -- ── KEPLER (00-06) desde el ODS vivo ──────────────────────────────────
    SELECT
      '${M}'::uuid                                        AS tenant_id,
      ap.sucursal::text                                  AS sucursal,
      btrim(ap.c6::text)                                 AS folio,
      'XA2001'::text                                     AS doc_prefix,
      ap.c9::date                                        AS receipt_date,
      NULLIF(btrim(ap.c10::text),'')                     AS proveedor_code,
      NULLIF(btrim(ap.c32::text),'')                     AS proveedor_nombre,
      NULLIF(btrim(ap.c22::text),'')                     AS proveedor_rfc,
      oe.vale_folio                                      AS vale_folio,
      oe.oc_folio                                        AS oc_folio,
      NULLIF(btrim(ap.c24::text),'')                     AS concepto,
      round(coalesce(nullif(regexp_replace(ap.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
      ('md_'||ap.sucursal)::text                         AS source_branch,
      now()                                              AS computed_at,
      NULL::text                                         AS dup_of_sucursal,
      NULL::text                                         AS dup_of_folio,
      wk.id                                              AS warehouse_id
    FROM kepler_ods.kdm1 ap
    LEFT JOIN LATERAL (
      SELECT NULLIF(btrim(oe.c39::text),'') AS vale_folio,
             (SELECT NULLIF(btrim(v.c39::text),'') FROM kepler_ods.kdm1 v
                WHERE v.sucursal=oe.sucursal AND v.c2='X' AND v.c3='A' AND btrim(v.c4::text)='37'
                  AND btrim(v.c6::text)=btrim(oe.c39::text)
                ORDER BY btrim(v.c6::text) LIMIT 1) AS oc_folio
        FROM kepler_ods.kdm1 oe
       WHERE oe.sucursal=ap.sucursal AND oe.c2='X' AND oe.c3='A' AND btrim(oe.c4::text)='40'
         AND btrim(oe.c6::text)=btrim(ap.c39::text)
       ORDER BY btrim(oe.c39::text) LIMIT 1
    ) oe ON true
    LEFT JOIN commercial.warehouses wk
      ON wk.tenant_id='${M}'::uuid AND wk.kepler_code=ap.sucursal::text AND wk.deleted_at IS NULL
    WHERE ap.c2='X' AND ap.c3='A' AND btrim(ap.c4::text)='20' AND btrim(ap.c1::text)=ap.sucursal::text

    UNION ALL
    -- ── WINCAJA (30/32/50) desde el bronce movimiento_proveedores ──────────
    SELECT
      '${M}'::uuid,
      mp.source_branch::text,
      btrim(mp.documento::text),
      ('WCJ-'||btrim(mp.tipo::text)),
      mp.fecha::date,
      NULLIF(btrim(mp.tercero::text),''),
      pr.nombre,
      pr.rfc,
      NULL::text,
      NULL::text,
      NULL::text,
      round(coalesce(mp.valor::numeric,0)+coalesce(mp.iva::numeric,0)+coalesce(mp.ieps::numeric,0),2),
      ('wincaja_'||mp.source_branch)::text,
      now(),
      NULL::text,
      NULL::text,
      ww.id
    FROM wincaja.movimiento_proveedores mp
    JOIN wincaja.branches b
      ON b.tenant_id=mp.tenant_id AND b.source_branch=mp.source_branch AND b.kepler_code IS NULL AND b.warehouse_code LIKE 'MD-%'
    LEFT JOIN (
      SELECT source_branch, proveedor, max(nombre) AS nombre, max(rfc) AS rfc
        FROM wincaja.proveedores WHERE tenant_id='${M}'::uuid GROUP BY source_branch, proveedor
    ) pr ON pr.source_branch=mp.source_branch AND pr.proveedor=mp.tercero
    LEFT JOIN commercial.warehouses ww
      ON ww.tenant_id='${M}'::uuid AND ww.wincaja_source_branch=mp.source_branch AND ww.deleted_at IS NULL
    WHERE mp.tenant_id='${M}'::uuid AND mp.source_dataset='actual' AND mp.tipo IN ('CR','CC')
  `);

  await knex.raw(`COMMENT ON VIEW analytics.erp_goods_receipts IS
    'Vista derive-no-copy: recepciones EN VIVO desde kepler_ods.kdm1 (XA2001, proveedor del propio header c32/c22, '
    'cadena vale/OC via LATERAL sin fan-out, anti-réplica c1=sucursal) UNION Wincaja movimiento_proveedores (CR/CC). '
    'Comprobantes/OCR en finance.goods_receipt_proofs (join por sucursal,folio). Backup: *_snapshot_bak.'`);
};

exports.down = function () {
  // No-op: revertir al fan-out sería un downgrade. La vista corregida es superset correcto.
  return Promise.resolve();
};
