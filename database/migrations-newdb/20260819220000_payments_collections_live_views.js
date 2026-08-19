/**
 * `analytics.erp_supplier_payments` y `analytics.erp_collections`: TABLAS copiadas por importer
 * → **VISTAS derive-no-copy EN VIVO** sobre `kepler_ods.kdm1` (patrón de erp_goods_receipts /
 * expense_requests). Ambas son proyección fina 1:1 de Kepler (CEDIS md_00), sin enriquecimiento
 * preservado. Reconciliadas contra el ODS fresco (2026-08-19): 0 filas perdidas; la vista destapa
 * lo que la copia traía atrasado (+609 cobros) y `monto` coincide con el branch (verdad) — la copia
 * tenía valores viejos. Normalizadas: exponen `warehouse_id` via commercial.warehouses.code.
 *
 * Fuente = CEDIS (sucursal 00, donde se centralizan pagos/cobranza). Anti-réplica c1=sucursal.
 *   Pagos:  XD2501/XD2601/XD6001 (c2='X' c3='D' c4 in 25/26/60), c10 ILIKE 'C%' (proveedor compra).
 *           doc_prefix por c4; metodo_pago por c31; descuento c84.
 *   Cobros: UA0501 (c2='U' c3='A' c4=5). forma_pago por c24; tipo_cuenta por c10.
 *
 * 0 FK apuntan a las tablas; únicos writers eran los importers (retirados de run-prod-feeds
 * intraday). Comprobantes en finance.{supplier_payment_proofs,collection_deposits} (join por
 * (sucursal,folio)) → intactos. Backups: *_snapshot_bak.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  // ── PAGOS ─────────────────────────────────────────────────────────────
  const pv = await knex.raw(`SELECT relkind FROM pg_class WHERE oid=to_regclass('analytics.erp_supplier_payments')`);
  if (!(pv.rows[0] && pv.rows[0].relkind === 'v')) {
    await knex.raw(`ALTER TABLE analytics.erp_supplier_payments RENAME TO erp_supplier_payments_snapshot_bak`);
    await knex.raw(`
      CREATE VIEW analytics.erp_supplier_payments AS
      SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio)
        '${M}'::uuid AS tenant_id, q.sucursal, q.folio, q.doc_prefix, q.pago_date,
        q.proveedor_code, q.proveedor_nombre, q.proveedor_rfc, q.concepto, q.monto,
        'md_00'::text AS source_branch, now() AS computed_at, q.metodo_pago, q.descuento, w.id AS warehouse_id
      FROM (
        SELECT '00'::text AS sucursal, btrim(c6::text) AS folio,
          CASE btrim(c4::text) WHEN '26' THEN 'XD2601' WHEN '60' THEN 'XD6001' ELSE 'XD2501' END AS doc_prefix,
          CASE WHEN lower(btrim(c31::text)) LIKE 'tra%' THEN 'transferencia'
               WHEN lower(btrim(c31::text)) LIKE 'che%' THEN 'cheque'
               WHEN lower(btrim(c31::text)) LIKE 'ant%' THEN 'anticipo' END AS metodo_pago,
          c9::date AS pago_date, NULLIF(btrim(c10::text),'') AS proveedor_code,
          NULLIF(btrim(c32::text),'') AS proveedor_nombre, NULLIF(btrim(c22::text),'') AS proveedor_rfc,
          NULLIF(btrim(c24::text),'') AS concepto,
          round(coalesce(nullif(regexp_replace(c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
          round(coalesce(nullif(regexp_replace(c84::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS descuento
        FROM kepler_ods.kdm1
        WHERE c2='X' AND c3='D' AND btrim(c4::text) IN ('25','26','60') AND btrim(c10::text) ILIKE 'C%'
          AND sucursal::text='00' AND btrim(c1::text)='00'
      ) q
      LEFT JOIN commercial.warehouses w ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL
      ORDER BY q.sucursal, q.doc_prefix, q.folio`);
    await knex.raw('GRANT SELECT ON analytics.erp_supplier_payments TO app_runtime');
  }

  // ── COBROS ────────────────────────────────────────────────────────────
  const cv = await knex.raw(`SELECT relkind FROM pg_class WHERE oid=to_regclass('analytics.erp_collections')`);
  if (!(cv.rows[0] && cv.rows[0].relkind === 'v')) {
    await knex.raw(`ALTER TABLE analytics.erp_collections RENAME TO erp_collections_snapshot_bak`);
    await knex.raw(`
      CREATE VIEW analytics.erp_collections AS
      SELECT DISTINCT ON (q.sucursal, q.folio)
        '${M}'::uuid AS tenant_id, q.sucursal, q.folio, q.doc_prefix, q.cobro_date,
        q.cliente_code, q.cliente_nombre, q.concepto, q.forma_pago, q.monto, q.tipo_cuenta,
        'md_00'::text AS source_branch, now() AS computed_at, w.id AS warehouse_id
      FROM (
        SELECT '00'::text AS sucursal, btrim(c6::text) AS folio, 'UA0501'::text AS doc_prefix,
          c9::date AS cobro_date, NULLIF(btrim(c10::text),'') AS cliente_code, NULLIF(btrim(c32::text),'') AS cliente_nombre,
          NULLIF(btrim(c24::text),'') AS concepto,
          CASE WHEN upper(c24::text) ~ 'DEP[OÓ]SITO|\\mDEP\\M' THEN 'deposito'
               WHEN upper(c24::text) ~ 'TRANSFER|SPEI' THEN 'transferencia'
               WHEN upper(c24::text) ~ 'TARJETA|TARJ|TDC|TDD' THEN 'tarjeta'
               WHEN upper(c24::text) ~ 'EFECTIVO|EFVO|EFECTICO' THEN 'efectivo'
               WHEN upper(c24::text) ~ 'CHEQUE|\\mCHQ\\M' THEN 'cheque' ELSE 'otro' END AS forma_pago,
          round(coalesce(nullif(regexp_replace(c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
          CASE WHEN btrim(c10::text) ~* '^(RUTA|R\\.?[DV]\\.?|R[DV][\\s\\-0-9])' THEN 'ruta'
               WHEN btrim(c10::text) ~ '^\\d{2}-\\d{2}' THEN 'interno' ELSE 'cliente_final' END AS tipo_cuenta
        FROM kepler_ods.kdm1
        WHERE c2='U' AND c3='A' AND btrim(c4::text)='5' AND sucursal::text='00' AND btrim(c1::text)='00'
      ) q
      LEFT JOIN commercial.warehouses w ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL
      ORDER BY q.sucursal, q.folio`);
    await knex.raw('GRANT SELECT ON analytics.erp_collections TO app_runtime');
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_supplier_payments');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_collections');
  await knex.raw(`ALTER TABLE IF EXISTS analytics.erp_supplier_payments_snapshot_bak RENAME TO erp_supplier_payments`);
  await knex.raw(`ALTER TABLE IF EXISTS analytics.erp_collections_snapshot_bak RENAME TO erp_collections`);
};
