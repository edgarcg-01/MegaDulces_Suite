/**
 * NORM P0 (clase C, §4.1) — paso A: índice único `(tenant, sucursal, doc_prefix, folio)` en
 * analytics.erp_collections + analytics.erp_goods_receipts.
 *
 * Hoy la PK es `(tenant, sucursal, folio)` → al agregar un 2º doctype con el MISMO folio, el
 * UPSERT PISA la fila del otro doctype en silencio (erp_goods_receipts YA coexisten XA2001 +
 * WCJ-CR + WCJ-CC). Este índice hace del doc_prefix parte de la llave.
 *
 * ADITIVO y SEGURO: la PK vieja (subconjunto) garantiza que el superset es único → el índice
 * construye sin violación (verificado: 0 violaciones, 0 doc_prefix NULL). Coexiste con la PK
 * vieja. Paso B (código: ON CONFLICT al nuevo índice) + paso C (drop PK vieja,
 * 20260817140100) van DESPUÉS de deployar el código. Idempotente.
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS erp_collections_tenant_docprefix_folio_uk
    ON analytics.erp_collections (tenant_id, sucursal, doc_prefix, folio)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS erp_goods_receipts_tenant_docprefix_folio_uk
    ON analytics.erp_goods_receipts (tenant_id, sucursal, doc_prefix, folio)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.erp_collections_tenant_docprefix_folio_uk`);
  await knex.raw(`DROP INDEX IF EXISTS analytics.erp_goods_receipts_tenant_docprefix_folio_uk`);
};
