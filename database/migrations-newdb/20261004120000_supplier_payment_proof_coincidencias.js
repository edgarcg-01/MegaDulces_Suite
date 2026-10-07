/**
 * [PC.6] — El comprobante de pago a proveedor guarda sus CUATRO COINCIDENCIAS con el pago de Kepler
 * (banco · fecha · monto · proveedor), y con las cuatro en verde se valida SOLO.
 *
 * Decisión del usuario (2026-10-03): lo que ya coincide exacto no espera a una persona; en «con
 * comprobante» quedan sólo los que tienen diferencias, hasta que se arreglen.
 *
 *   - `coincidencias`      jsonb  {banco, fecha, monto, proveedor} → 'ok' | 'difiere' | 'sin_dato'.
 *                                 La regla vive en libs/contracts (coincidencia-pago.contract.ts).
 *                                 NULL = nunca se evaluó (comprobantes anteriores a esta migración).
 *   - `auto_validado`      bool   lo validó el sistema por las cuatro coincidencias, no una persona.
 *   - `lectura_verificada` bool   la lectura de la IA la recuperó el servidor por el hash del archivo
 *                                 (no vino del navegador). ⛔ Sin esto NO se valida solo: una lectura
 *                                 que llegó en el request se puede alterar.
 *
 * Sin backfill a propósito: de los comprobantes anteriores no se sabe si la lectura guardada es la
 * del modelo o la del request, así que quedan `lectura_verificada = NULL` y la re-comparación les
 * calcula las coincidencias (para que se vea qué difiere) pero nunca los valida sola.
 *
 * Idempotente (hasColumn). Columnas nuevas, ningún DROP.
 *
 * @param { import("knex").Knex } knex
 */
const T = 'finance.supplier_payment_proofs';

exports.up = async function (knex) {
  const hay = await knex.schema.withSchema('finance').hasTable('supplier_payment_proofs');
  if (!hay) return;
  const add = async (col, ddl) => {
    if (!(await knex.schema.withSchema('finance').hasColumn('supplier_payment_proofs', col))) {
      await knex.raw(`ALTER TABLE ${T} ADD COLUMN ${ddl}`);
    }
  };
  await add('coincidencias', 'coincidencias jsonb');
  await add('auto_validado', 'auto_validado boolean NOT NULL DEFAULT false');
  await add('lectura_verificada', 'lectura_verificada boolean');
  await knex.raw(`COMMENT ON COLUMN ${T}.coincidencias IS
    'PC.6 — banco/fecha/monto/proveedor del comprobante vs el pago de Kepler: ok | difiere | sin_dato. Regla en libs/contracts/src/finance/coincidencia-pago.contract.ts. NULL = nunca evaluado.'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.auto_validado IS
    'PC.6 — true = lo validó el sistema porque coincidieron las cuatro (y la lectura era verificada); false = lo decidió una persona o sigue pendiente.'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.lectura_verificada IS
    'PC.6 — true = la lectura de la IA la recuperó el servidor por el hash del archivo. Sin esto el comprobante nunca se valida solo. NULL = anterior a PC.6.'`);
};

exports.down = async function (knex) {
  // Columnas aditivas: se dejan. Quitarlas borraría el rastro de qué se validó solo.
  void knex;
};
