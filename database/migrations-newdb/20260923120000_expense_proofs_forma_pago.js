/**
 * `[GX.14]` — **Cómo se pagó**, declarado por quien gastó, junto al expediente.
 *
 * Kepler tiene el campo (`kdm1.c90` → `analytics.expense_requests.forma_pago`) y **nadie
 * lo llena**, porque al capturar la solicitud nada se lo pide. Medido en prod el
 * 2026-09-23: **5,410 de 10,082 solicitudes (54%) lo traen vacío**, y suman
 * **$20,283,721.89**. Para un solicitante concreto (LEONARDO CAZARES, 1,513 folios /
 * $4.8 M en 12 meses) está declarado en **5**.
 *
 * Así que lo pide la Suite, y lo guarda de su lado. ⛔ **No se escribe a Kepler** — el
 * expediente es evidencia sobre el ERP, nunca al revés (hereda el principio de la Fase CC).
 *
 * ## Por qué `forma_pago` y no `payment_method`
 * La convención del proyecto manda inglés para columnas nuevas, con la excepción de los
 * términos de dominio. Acá los dos motivos de la excepción se cumplen a la vez:
 *   1. la columna **hermana ya existe y se llama así** (`analytics.expense_requests.forma_pago`,
 *      derivada de Kepler) y el objetivo declarado es que las dos sean conmensurables;
 *   2. la tabla es Spanish de punta a punta (`solicitante`, `proveedor`, `importe`,
 *      `motivo_rechazo`, `clasificacion`): una sola columna en inglés se lee como un error.
 *
 * ## Lo que NO lleva CHECK, a propósito
 * `forma_pago_detalle` es texto libre porque cada forma pide una cosa distinta (caja,
 * últimos 4, referencia, número de cheque). Lo que sí se valida es **que esté** cuando la
 * forma elegida lo exige, y eso vive en `aporte-solicitante.contract.ts`, que leen el
 * botón y el `400` — una sola regla, no dos.
 *
 * Idempotente (`hasColumn` antes de `addColumn`). No toca filas existentes: los 9
 * expedientes que ya hay quedan con `forma_pago` NULL, que es la verdad — nadie se la
 * preguntó. Se distinguen de los nuevos sin adivinar nada.
 *
 * @param { import("knex").Knex } knex
 */

const IDS = ['efectivo', 'tarjeta', 'transferencia', 'cheque', 'vales', 'otro'];
const CHECK = 'expense_proofs_forma_pago_check';

exports.up = async function (knex) {
  const tiene = async (col) => knex.schema.withSchema('finance').hasColumn('expense_proofs', col);

  if (!(await tiene('forma_pago'))) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => {
      t.text('forma_pago').nullable();
    });
    console.log('[gx14_forma_pago] up: finance.expense_proofs.forma_pago creada');
  } else {
    console.log('[gx14_forma_pago] up: forma_pago ya existía, no se toca');
  }

  if (!(await tiene('forma_pago_detalle'))) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => {
      t.text('forma_pago_detalle').nullable();
    });
    console.log('[gx14_forma_pago] up: finance.expense_proofs.forma_pago_detalle creada');
  } else {
    console.log('[gx14_forma_pago] up: forma_pago_detalle ya existía, no se toca');
  }

  // CHECK sobre el catálogo cerrado. NULL pasa: los expedientes viejos no mienten,
  // simplemente nadie les preguntó. Lo que se prohíbe es un valor inventado.
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'finance.expense_proofs'::regclass`,
    [CHECK],
  );
  if (!rows.length) {
    const lista = IDS.map((i) => `'${i}'`).join(', ');
    await knex.raw(
      `ALTER TABLE finance.expense_proofs
         ADD CONSTRAINT ${CHECK}
         CHECK (forma_pago IS NULL OR forma_pago IN (${lista}))`,
    );
    console.log(`[gx14_forma_pago] up: CHECK ${CHECK} agregado (${IDS.length} valores)`);
  } else {
    console.log(`[gx14_forma_pago] up: CHECK ${CHECK} ya existía`);
  }

  await knex.raw(
    `COMMENT ON COLUMN finance.expense_proofs.forma_pago IS
     '[GX.14] Cómo se pagó, declarado por quien gastó. Catálogo cerrado en libs/contracts/src/finance/forma-pago.contract.ts, atado a los códigos de Kepler (kdm1.c90 / SAT): efectivo=01 cheque=02 transferencia=03 tarjeta=04 vales=07 otro=99. NULL = nadie se lo preguntó (los expedientes anteriores a GX.14).'`,
  );
  await knex.raw(
    `COMMENT ON COLUMN finance.expense_proofs.forma_pago_detalle IS
     '[GX.14] El dato que pide la forma elegida: caja de origen, últimos 4 dígitos, referencia del banco o número de cheque. Texto libre a propósito (cada forma pide otra cosa); que ESTÉ lo exige aporte-solicitante.contract.ts.'`,
  );
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS ${CHECK}`);
  const tiene = async (col) => knex.schema.withSchema('finance').hasColumn('expense_proofs', col);
  if (await tiene('forma_pago_detalle')) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => t.dropColumn('forma_pago_detalle'));
  }
  if (await tiene('forma_pago')) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => t.dropColumn('forma_pago'));
  }
  console.log('[gx14_forma_pago] down: columnas y CHECK retirados');
};
