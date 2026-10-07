/**
 * AUDIT 2026-08-20 (frescura/normalización) — DROP de los 11 respaldos MUERTOS `*_snapshot_bak`.
 *
 * Son los backups congelados de la migración tabla→vista de 2026-08-19 (derive-no-copy): cuando
 * erp_supplier_payments/collections/goods_receipts/…/expense_documents/requests pasaron de TABLA a
 * VISTA sobre kepler_ods, la data vieja quedó respaldada en `<nombre>_snapshot_bak`. Las vistas vivas
 * ya existen y sirven el dato fresco → los `_bak` son ~217k filas muertas y una **trampa de lectura**
 * (un consumer podría leer el respaldo viejo en vez de la vista). Verificado 2026-08-21: NINGÚN código
 * (libs/apps/importers) referencia estas tablas.
 *
 * `DROP TABLE IF EXISTS` (idempotente) SIN CASCADE: si algo inesperado las referenciara, falla fuerte
 * en vez de arrastrar dependencias. Sin `down` de restauración: son respaldos muertos; la fuente viva
 * es la vista homónima sin `_snapshot_bak`.
 */
const BAKS = [
  'erp_goods_receipt_lines_snapshot_bak',
  'erp_shipments_snapshot_bak',
  'erp_collections_snapshot_bak',
  'expense_documents_snapshot_bak',
  'erp_goods_receipts_snapshot_bak',
  'expense_requests_snapshot_bak',
  'erp_supplier_payments_snapshot_bak',
  'erp_customers_snapshot_bak',
  'erp_promotions_snapshot_bak',
  'erp_purchase_docs_snapshot_bak',
  'erp_purchase_doc_lines_snapshot_bak',
];

exports.up = async function up(knex) {
  for (const t of BAKS) {
    await knex.raw(`DROP TABLE IF EXISTS analytics."${t}"`);
  }
};

exports.down = async function down() {
  // Irreversible a propósito: eran respaldos muertos de la migración a vista; la vista viva homónima
  // (sin _snapshot_bak) tiene el dato fresco. No hay nada que restaurar.
};
