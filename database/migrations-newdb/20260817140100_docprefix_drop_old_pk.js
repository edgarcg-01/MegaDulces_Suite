/**
 * NORM P0 (clase C, §4.1) — paso C: dropear la PK vieja `(tenant, sucursal, folio)` de
 * analytics.erp_collections + analytics.erp_goods_receipts. El índice único con doc_prefix
 * (paso A, 20260817140000) queda como la llave efectiva → ya permite multi-doctype por folio.
 *
 * ⚠️ APLICAR SOLO DESPUÉS de deployar el código con `ON CONFLICT (tenant,sucursal,doc_prefix,folio)`
 * (feeds-ingest redeploy + .249 git pull). Si se aplica antes, los feeds con el ON CONFLICT viejo
 * fallan (no hay unique constraint que matchee). Drop del PK por nombre real (robusto). Idempotente.
 */
async function dropPk(knex, rel) {
  await knex.raw(`DO $$ DECLARE cn text;
    BEGIN
      SELECT conname INTO cn FROM pg_constraint WHERE conrelid='${rel}'::regclass AND contype='p';
      IF cn IS NOT NULL THEN EXECUTE format('ALTER TABLE ${rel} DROP CONSTRAINT %I', cn); END IF;
    END $$;`);
}

exports.up = async function (knex) {
  await dropPk(knex, 'analytics.erp_collections');
  await dropPk(knex, 'analytics.erp_goods_receipts');
};

exports.down = async function (knex) {
  // Reponer la PK vieja (falla si ya existen folios multi-doctype colisionando — aceptable en down).
  await knex.raw(`ALTER TABLE analytics.erp_collections ADD PRIMARY KEY (tenant_id, sucursal, folio)`);
  await knex.raw(`ALTER TABLE analytics.erp_goods_receipts ADD PRIMARY KEY (tenant_id, sucursal, folio)`);
};
