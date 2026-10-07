/**
 * CG — `finance.cash_ledger.origen_tipo` admite `'gasto'` y `'orden_entrada'`.
 *
 * La interfaz principal de la caja ya muestra el EFECTIVO inferido: `v_caja_movimientos_pendientes`
 * filtra `tipo_cuenta='caja'` = `kdm1.c45='0011'` (CAJA GENERAL / EFECTIVO), medido al 100% contra
 * la caja del Control (CG.21). El BUSCADOR suma lo que cae FUERA de ese set: los documentos POR
 * PAGAR — **gastos (`XA1001`)** y **órdenes de entrada (`XA2001`)**, ambos vivos en
 * `analytics.expense_documents`. Al pagar uno en efectivo desde la caja, el movimiento se registra
 * con `origen_tipo='gasto'` u `'orden_entrada'` y `origen_ref='sucursal|doc_tipo|folio'`.
 *
 * El CHECK previo (`20260925140400`) permitía cfdi|recepcion|pago_proveedor|cobro|banco|manual|caos.
 * Se recrea sumando los dos. Aditiva, idempotente, no edita la aplicada.
 *
 * ⚠️ Ninguno de los dos ANCLA (no van en `ORIGEN_ANCLADO` de cash-ledger.service.ts): un gasto y una
 * orden de entrada son OBLIGACIONES (devengo), no un movimiento de caja de Kepler del cual releer el
 * monto — el monto real sale del ARQUEO (lo que se pagó en efectivo), con el importe del documento
 * como prefill. El candado `ux_cash_ledger_origen_vivo (tenant_id, origen_tipo, origen_ref)`
 * (mig 20260921170000) garantiza que cada documento se capture UNA vez.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_origen_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger ADD CONSTRAINT cash_ledger_origen_chk CHECK (
      origen_tipo IS NULL OR origen_tipo IN
      ('cfdi','recepcion','pago_proveedor','cobro','banco','manual','caos','gasto','orden_entrada')
    )`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_origen_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger ADD CONSTRAINT cash_ledger_origen_chk CHECK (
      origen_tipo IS NULL OR origen_tipo IN
      ('cfdi','recepcion','pago_proveedor','cobro','banco','manual','caos')
    )`);
};
