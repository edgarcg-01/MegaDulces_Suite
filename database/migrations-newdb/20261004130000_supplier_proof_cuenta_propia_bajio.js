/**
 * [PC.7] — Corrige la falsa alerta «cuenta de origen NO reconocida» en comprobantes de BanBajío.
 *
 * En BanBajío la clave de la cuenta va en el CENTRO del número de 12 dígitos, no al final:
 * `2457` + `6506` + `0201` es la cuenta Kepler BAJIO 6506 (medido con comprobantes reales de
 * BajioNet el 2026-10-04: `245765060201` → 6506, `245758540201` → 5854, `199241660201` → 4166).
 * El control `cuenta_propia` (SP.1) comparaba por el FINAL contra `finance.bank_accounts`, así que
 * todo pago que salió de BanBajío quedó con `cuenta_propia = false` y la pantalla lo marcaba como
 * «salió de una cuenta que no es de la empresa».
 *
 * El código ya lo lee bien (`cuentaEsClave` en libs/contracts); esto corrige lo ya guardado, con la
 * MISMA regla en SQL: 12 dígitos + banco BBAJIO → los primeros 8 dígitos terminan en la etiqueta.
 *
 *  · Sólo pasa `false → true`, y sólo en filas de 12 dígitos que calzan con una cuenta BanBajío
 *    propia y activa. Nunca toca `NULL` ni filas de otros bancos.
 *  · ⚠️ No recalcula `coincidencias` (eso lo hace «Volver a comparar» desde la pantalla, con la
 *    regla de TS; duplicarla en SQL la desincronizaría).
 *  · Idempotente: una segunda corrida no encuentra filas.
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  const hay = await knex.schema.withSchema('finance').hasTable('supplier_payment_proofs');
  const hayCuentas = await knex.schema.withSchema('finance').hasTable('bank_accounts');
  if (!hay || !hayCuentas) return;
  await knex.transaction(async (trx) => {
    // finance.* con RLS forzado: el UPDATE corre con el tenant puesto.
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
    const r = await trx.raw(`
      UPDATE finance.supplier_payment_proofs p
         SET cuenta_propia = true, updated_at = now()
       WHERE p.tenant_id = '${MEGA}'::uuid
         AND p.cuenta_propia = false
         AND length(regexp_replace(coalesce(p.ocr_cuenta_origen, ''), '[^0-9]', '', 'g')) = 12
         AND EXISTS (
               SELECT 1 FROM finance.bank_accounts ba
                WHERE ba.tenant_id = p.tenant_id
                  AND ba.kind = 'bank' AND ba.active
                  AND ba.bank ~* 'BAJ[IÍ]O'
                  AND ba.account_label ~ '^[0-9]{3,}$'
                  AND left(regexp_replace(p.ocr_cuenta_origen, '[^0-9]', '', 'g'), 8) ~ (ba.account_label || '$')
             )`);
    console.log(`[PC.7] comprobantes BanBajío corregidos a cuenta propia: ${r.rowCount}`);
  });
};

exports.down = async function (knex) {
  // No se revierte: devolver `false` volvería a encender una alerta que se sabe falsa.
  void knex;
};
