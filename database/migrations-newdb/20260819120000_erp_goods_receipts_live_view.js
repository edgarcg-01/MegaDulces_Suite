/**
 * `analytics.erp_goods_receipts` (+ `_lines`): TABLA copiada por importer batch → **VISTA derivada
 * EN VIVO** del ODS (derive-no-copy). Motivo: el importer `import-goods-receipts.js` se atoraba
 * (folios nuevos no aparecían en /compras/entradas — ej. PH folio 0000397 del 18-ago), mientras
 * los datos YA estaban vivos en `kepler_ods.kdm1` (replicación lógica al segundo). La vista los
 * muestra al instante y nunca se desactualiza.
 *
 * Fuentes:
 *   - Kepler (00-06): `kepler_ods.kdm1` XA2001 (X-A-20) + cadena X-A-40 (orden entrada)/X-A-37 (vale).
 *     Anti-réplica: `c1 = sucursal` (cada rama arrastra réplicas de otras). Joins scoped por sucursal.
 *   - Wincaja (30/32/50): `wincaja.movimiento_proveedores` tipo CR/CC (dataset 'actual'), como el
 *     importer `import-wincaja-receipts.js`. Sin líneas (header-only).
 *
 * La tabla vieja se renombra a `*_snapshot_bak` (respaldo/rollback). Los comprobantes/OCR viven en
 * `finance.goods_receipt_proofs` (tabla persistente, se une por (sucursal, folio)) → intactos.
 * Los 7 consumidores solo LEEN (0 escrituras verificadas) → la vista es drop-in.
 *
 * Nota RLS: la vista (owner del migration) corre security-definer → los consumidores (app_runtime)
 * leen vía GRANT SELECT sin tocar kepler_ods directo. tenant_id = mega_dulces (single-tenant beta).
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  // Idempotencia: si ya es vista, no re-hacer.
  const isView = await knex.raw(
    `SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_goods_receipts')`,
  );
  if (isView.rows[0] && isView.rows[0].relkind === 'v') return;

  // Índices parciales para los self-joins XA2001 sobre kepler_ods.kdm1 (evita full-scan por query).
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kdm1_xa_doc
    ON kepler_ods.kdm1 (sucursal, btrim(c4::text), btrim(c6::text)) WHERE c2='X' AND c3='A'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kdm1_xa_chain
    ON kepler_ods.kdm1 (sucursal, btrim(c39::text)) WHERE c2='X' AND c3='A'`);

  // Respaldo reversible de las tablas snapshot.
  await knex.raw(`ALTER TABLE analytics.erp_goods_receipts RENAME TO erp_goods_receipts_snapshot_bak`);
  await knex.raw(`ALTER TABLE IF EXISTS analytics.erp_goods_receipt_lines RENAME TO erp_goods_receipt_lines_snapshot_bak`);

  await knex.raw(`
    CREATE VIEW analytics.erp_goods_receipts AS
    -- ── KEPLER (00-06) desde el ODS vivo ──────────────────────────────────
    SELECT
      '${M}'::uuid                                        AS tenant_id,
      ap.sucursal::text                                  AS sucursal,
      btrim(ap.c6::text)                                 AS folio,
      'XA2001'::text                                     AS doc_prefix,
      ap.c9::date                                        AS receipt_date,
      NULLIF(btrim(ap.c10::text),'')                     AS proveedor_code,
      COALESCE(NULLIF(btrim(v.c32::text),''), NULLIF(btrim(ap.c32::text),'')) AS proveedor_nombre,
      COALESCE(NULLIF(btrim(ap.c22::text),''), NULLIF(btrim(v.c22::text),'')) AS proveedor_rfc,
      NULLIF(btrim(oe.c39::text),'')                     AS vale_folio,
      NULLIF(btrim(v.c39::text),'')                      AS oc_folio,
      NULLIF(btrim(ap.c24::text),'')                     AS concepto,
      round(coalesce(nullif(regexp_replace(ap.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
      ('md_'||ap.sucursal)::text                         AS source_branch,
      now()                                              AS computed_at,
      NULL::text                                         AS dup_of_sucursal,
      NULL::text                                         AS dup_of_folio,
      wk.id                                              AS warehouse_id
    FROM kepler_ods.kdm1 ap
    LEFT JOIN kepler_ods.kdm1 oe
      ON oe.sucursal=ap.sucursal AND oe.c2='X' AND oe.c3='A' AND btrim(oe.c4::text)='40' AND btrim(oe.c6::text)=btrim(ap.c39::text)
    LEFT JOIN kepler_ods.kdm1 v
      ON v.sucursal=oe.sucursal  AND v.c2='X'  AND v.c3='A'  AND btrim(v.c4::text)='37'  AND btrim(v.c6::text)=btrim(oe.c39::text)
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

  await knex.raw(`
    CREATE VIEW analytics.erp_goods_receipt_lines AS
    SELECT
      '${M}'::uuid                    AS tenant_id,
      ap.sucursal::text               AS sucursal,
      btrim(ap.c6::text)              AS folio,
      btrim(l.c7::text)               AS linea,
      NULLIF(btrim(l.c8::text),'')    AS sku,
      NULLIF(btrim(l.c10::text),'')   AS nombre,
      round(coalesce(nullif(regexp_replace(l.c9::text,'[^0-9.-]','','g'),'')::numeric,0),4)  AS cantidad,
      NULLIF(btrim(l.c11::text),'')   AS unidad,
      round(coalesce(nullif(regexp_replace(l.c12::text,'[^0-9.-]','','g'),'')::numeric,0),4) AS costo_unitario,
      round(coalesce(nullif(regexp_replace(l.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
      now()                           AS computed_at
    FROM kepler_ods.kdm1 ap
    JOIN kepler_ods.kdm2 l
      ON l.sucursal=ap.sucursal AND l.c1=ap.c1 AND l.c2=ap.c2 AND l.c3=ap.c3 AND l.c4=ap.c4 AND l.c6=ap.c6
    WHERE ap.c2='X' AND ap.c3='A' AND btrim(ap.c4::text)='20' AND btrim(ap.c1::text)=ap.sucursal::text
  `);

  await knex.raw('GRANT SELECT ON analytics.erp_goods_receipts TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.erp_goods_receipt_lines TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.erp_goods_receipts IS
    'Vista derive-no-copy: recepciones EN VIVO desde kepler_ods.kdm1 (XA2001+cadena, anti-réplica c1=sucursal) '
    'UNION Wincaja movimiento_proveedores (CR/CC). Reemplaza el importer batch que se atoraba. '
    'Comprobantes/OCR en finance.goods_receipt_proofs (join por sucursal,folio). Backup: *_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_goods_receipt_lines');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_goods_receipts');
  await knex.raw('ALTER TABLE IF EXISTS analytics.erp_goods_receipt_lines_snapshot_bak RENAME TO erp_goods_receipt_lines');
  await knex.raw('ALTER TABLE analytics.erp_goods_receipts_snapshot_bak RENAME TO erp_goods_receipts');
  await knex.raw('DROP INDEX IF EXISTS kepler_ods.idx_kdm1_xa_doc');
  await knex.raw('DROP INDEX IF EXISTS kepler_ods.idx_kdm1_xa_chain');
};
