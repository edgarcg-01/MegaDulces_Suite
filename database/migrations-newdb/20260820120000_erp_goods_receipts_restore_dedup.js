/**
 * FIX P0 — Doble conteo CEDIS en `analytics.erp_goods_receipts` (regresión de 20260819140000).
 *
 * Al pasar la tabla → VISTA, la vista fijó `dup_of_sucursal/dup_of_folio = NULL` en TODAS las
 * filas. Pero 5 consumidores filtran `WHERE dup_of_folio IS NULL` (mecanismo RE.12 que oculta la
 * copia espejo del CEDIS '00'). Con la columna siempre NULL el filtro es no-op → las gemelas del
 * CEDIS dejaron de ocultarse → **1,240 recepciones / $9.87M doble-contadas** (verificado en prod
 * 2026-08-20) en listReceipts, KPIs, watcher @Cron, purchase-adjustments y el link de comprobantes.
 * Además `detect-goods-receipt-duplicates.js` hacía UPDATE contra la vista → truena/no-op.
 *
 * Fix (patrón expense_doc_accounting): tabla chica de marcas `analytics.erp_goods_receipt_dedup`
 * (cedis_folio → sucursal/folio canónica) que la vista lee por LEFT JOIN. La mantiene el importer
 * detect-goods-receipt-duplicates.js (reescrito a UPSERT). También corrige el 2º hallazgo de vista:
 * el join de almacén pasa de `wk.kepler_code=sucursal` (NULL para '00') a `wk.code=sucursal`
 * (cubre '00'..'06', canónico como las 4 vistas hermanas) → recupera warehouse_id del CEDIS.
 *
 * Contrato de 17 columnas intacto (CREATE OR REPLACE: solo cambian 3 expresiones + 1 LEFT JOIN).
 * Backfill inline vía temp (evalúa la vista una sola vez). Idempotente. Reversible (down = estado
 * previo: NULL hardcodeado + kepler_code).
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

// Predicado de gemela CEDIS↔sucursal (idéntico a detect-goods-receipt-duplicates.js).
const MATCH = `
  s.sucursal <> '00' AND s.monto > 0
  AND s.receipt_date = c.receipt_date AND s.monto = c.monto
  AND ( (c.proveedor_rfc IS NOT NULL AND s.proveedor_rfc IS NOT NULL AND c.proveedor_rfc = s.proveedor_rfc)
     OR ((c.proveedor_rfc IS NULL OR s.proveedor_rfc IS NULL) AND c.proveedor_nombre = s.proveedor_nombre) )`;

const VIEW_WITH_DEDUP = `
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
    dd.dup_of_sucursal                                 AS dup_of_sucursal,
    dd.dup_of_folio                                    AS dup_of_folio,
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
    ON wk.tenant_id='${M}'::uuid AND wk.code=ap.sucursal::text AND wk.deleted_at IS NULL
  LEFT JOIN analytics.erp_goods_receipt_dedup dd
    ON dd.tenant_id='${M}'::uuid AND ap.sucursal::text='00' AND dd.cedis_folio=btrim(ap.c6::text)
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
`;

exports.up = async function (knex) {
  // 1) tabla de marcas de dedup (patrón expense_doc_accounting)
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.erp_goods_receipt_dedup (
      tenant_id       uuid NOT NULL,
      cedis_folio     text NOT NULL,
      dup_of_sucursal text,
      dup_of_folio    text,
      computed_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, cedis_folio)
    )`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.erp_goods_receipt_dedup TO app_runtime');
  await knex.raw(`COMMENT ON TABLE analytics.erp_goods_receipt_dedup IS
    'Marcas de dedup CEDIS (RE.12): cedis_folio del CEDIS 00 -> (dup_of_sucursal,dup_of_folio) canónica. La vista erp_goods_receipts la lee por LEFT JOIN para poblar dup_of_*. La mantiene detect-goods-receipt-duplicates.js (UPSERT). Reemplaza el UPDATE directo a la ex-tabla.'`);

  // 2) redefinir la vista: dup_of_* via JOIN al agregado + warehouse por code (no kepler_code)
  await knex.raw(VIEW_WITH_DEDUP);

  // 3) backfill de marcas: evalúa la vista UNA vez a temp, self-join por el predicado de gemela
  await knex.raw(`CREATE TEMP TABLE _gr ON COMMIT DROP AS
    SELECT sucursal, folio, receipt_date, monto, proveedor_rfc, proveedor_nombre
      FROM analytics.erp_goods_receipts WHERE tenant_id='${M}'::uuid AND monto > 0`);
  await knex.raw(`CREATE INDEX ON _gr (receipt_date, monto)`);
  await knex.raw(`
    INSERT INTO analytics.erp_goods_receipt_dedup (tenant_id, cedis_folio, dup_of_sucursal, dup_of_folio, computed_at)
    SELECT DISTINCT ON (c.folio) '${M}'::uuid, c.folio, s.sucursal, s.folio, now()
      FROM _gr c JOIN _gr s ON ${MATCH}
     WHERE c.sucursal='00'
     ORDER BY c.folio, s.sucursal, s.folio
    ON CONFLICT (tenant_id, cedis_folio) DO UPDATE
      SET dup_of_sucursal=EXCLUDED.dup_of_sucursal, dup_of_folio=EXCLUDED.dup_of_folio, computed_at=now()`);

  await knex.raw(`COMMENT ON VIEW analytics.erp_goods_receipts IS
    'Vista derive-no-copy: recepciones EN VIVO desde kepler_ods.kdm1 (XA2001, proveedor del header c32/c22, '
    'cadena vale/OC via LATERAL sin fan-out, anti-réplica c1=sucursal) UNION Wincaja movimiento_proveedores (CR/CC). '
    'dup_of_* via LEFT JOIN erp_goods_receipt_dedup (RE.12, oculta copia CEDIS 00). warehouse_id por warehouses.code. '
    'Comprobantes/OCR en finance.goods_receipt_proofs. Backup: *_snapshot_bak.'`);
};

exports.down = async function (knex) {
  // restaura el estado previo (20260819140000): dup_of_* = NULL hardcodeado, warehouse por kepler_code,
  // sin el LEFT JOIN al agregado. La tabla erp_goods_receipt_dedup queda (inofensiva, sin lectores).
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_goods_receipts AS
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
    SELECT
      '${M}'::uuid, mp.source_branch::text, btrim(mp.documento::text), ('WCJ-'||btrim(mp.tipo::text)),
      mp.fecha::date, NULLIF(btrim(mp.tercero::text),''), pr.nombre, pr.rfc, NULL::text, NULL::text, NULL::text,
      round(coalesce(mp.valor::numeric,0)+coalesce(mp.iva::numeric,0)+coalesce(mp.ieps::numeric,0),2),
      ('wincaja_'||mp.source_branch)::text, now(), NULL::text, NULL::text, ww.id
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
};
