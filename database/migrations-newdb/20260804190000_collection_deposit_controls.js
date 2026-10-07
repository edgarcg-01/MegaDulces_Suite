/**
 * CC.3 — Controles de cobranza sobre la evidencia de depósito.
 *
 * Dos controles financieros derivados de las fichas reales (Comprobante Universal
 * de Sucursales Banorte):
 *   1) `ref_norm` = folio electrónico NORMALIZADO (solo dígitos), columna GENERATED
 *      STORED a partir de `ocr_referencia`. Es la llave determinista de dedup:
 *      dos fichas con el mismo folio electrónico son el MISMO depósito (o la misma
 *      ficha aplicada a dos cobros distintos → hay que revisarlo).
 *   2) `cuenta_propia` = ¿la cuenta destino de la ficha (`ocr_cuenta_dest`) pertenece
 *      a una cuenta de banco de la empresa (`finance.bank_accounts`)? Un depósito a
 *      una cuenta ajena es bandera de fraude. La calcula el servicio al adjuntar;
 *      aquí se hace backfill de lo ya cargado.
 *
 * Idempotente (hasColumn). Backfill bajo `SET LOCAL app.tenant_id` (finance.* con
 * RLS FORZADO exige el contexto de tenant, igual que el seed de la fase CB).
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  const hasCuenta = await knex.schema.withSchema('finance').hasColumn('collection_deposits', 'cuenta_propia');
  if (!hasCuenta) {
    await knex.raw(`ALTER TABLE finance.collection_deposits ADD COLUMN cuenta_propia boolean`);
  }

  const hasRef = await knex.schema.withSchema('finance').hasColumn('collection_deposits', 'ref_norm');
  if (!hasRef) {
    // Solo dígitos del folio electrónico; NULL si la ficha no trae referencia legible.
    await knex.raw(`
      ALTER TABLE finance.collection_deposits
        ADD COLUMN ref_norm text
        GENERATED ALWAYS AS (
          NULLIF(regexp_replace(coalesce(ocr_referencia, ''), '[^0-9]', '', 'g'), '')
        ) STORED`);
    // Dedup rápido: mismo ref_norm entre fichas vivas (no rechazadas) del tenant.
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS ix_fin_cd_refnorm
        ON finance.collection_deposits (tenant_id, ref_norm)
        WHERE ref_norm IS NOT NULL AND status <> 'rechazado'`);
  }

  // Backfill de cuenta_propia para la evidencia ya cargada (mega_dulces).
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
    await trx.raw(`
      UPDATE finance.collection_deposits cd
         SET cuenta_propia = EXISTS (
               SELECT 1 FROM finance.bank_accounts ba
                WHERE ba.tenant_id = cd.tenant_id
                  AND ba.kind = 'bank' AND ba.active
                  AND ba.account_label ~ '^[0-9]{3,}$'
                  AND regexp_replace(coalesce(cd.ocr_cuenta_dest, ''), '[^0-9]', '', 'g')
                        ~ (ba.account_label || '$')
             )
       WHERE cd.ocr_cuenta_dest IS NOT NULL
         AND cd.cuenta_propia IS NULL`);
  });
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_fin_cd_refnorm`);
  const hasRef = await knex.schema.withSchema('finance').hasColumn('collection_deposits', 'ref_norm');
  if (hasRef) await knex.raw(`ALTER TABLE finance.collection_deposits DROP COLUMN ref_norm`);
  const hasCuenta = await knex.schema.withSchema('finance').hasColumn('collection_deposits', 'cuenta_propia');
  if (hasCuenta) await knex.raw(`ALTER TABLE finance.collection_deposits DROP COLUMN cuenta_propia`);
};
