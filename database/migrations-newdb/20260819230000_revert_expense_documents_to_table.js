/**
 * REVIERTE `analytics.expense_documents` de VISTA (mig 20260819210000) → TABLA contable.
 *
 * Motivo: la vista derivaba importe/fecha de `kepler_ods.kdm1` (movimiento), pero la tabla
 * se alimenta de la CONTABILIDAD (`kdc2`). Divergían en **277 recepciones XA2001 = $2.57M**
 * (78 con movimiento en $0, 199 con monto reclasificado). La conciliación fiscal
 * (`poliza-cruce.service.ts`) cruza CFDIs ↔ expense_documents por **RFC + importe + fecha**,
 * y `materialidad` usa el monto → la vista rompía el match de esas 277 (se verían "sin CFDI").
 * El CFDI se timbra por el monto/fecha CONTABLE, no el del movimiento. Híbrido inviable:
 * `kdc2` no está en el ODS.
 *
 * Restaura la tabla contable desde el backup (`*_snapshot_bak`, con su FK warehouse). El
 * vínculo solicitud↔gasto (objetivo de la mig revertida) se conserva SIN tocar el monto:
 * `import-expense-requests.js` reescribe `solicitud_folio` desde el c39 del ODS. La tabla
 * queda congelada al momento del backup → re-correr `import-expenses-polizas --apply` para
 * refrescar (su write fue restaurado). Idempotente (guard relkind).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const rk = await knex.raw(`SELECT relkind FROM pg_class WHERE oid=to_regclass('analytics.expense_documents')`);
  if (!(rk.rows[0] && rk.rows[0].relkind === 'v')) return; // no es vista → ya revertida / nada que hacer
  const bak = await knex.raw(`SELECT 1 FROM pg_class WHERE oid=to_regclass('analytics.expense_documents_snapshot_bak')`);
  if (!bak.rows.length) throw new Error('expense_documents_snapshot_bak no existe — no se puede revertir sin backup');

  await knex.raw('DROP VIEW analytics.expense_documents');
  await knex.raw('ALTER TABLE analytics.expense_documents_snapshot_bak RENAME TO expense_documents');
  // el índice/constraint fk_expense_documents_warehouse viaja con el rename (estaba en el backup).
  await knex.raw(`COMMENT ON TABLE analytics.expense_documents IS
    'Tabla contable (kdc2) restaurada 2026-08-19 tras revertir la vista sobre kdm1 (rompía conciliación fiscal). La escribe import-expenses-polizas; vínculo solicitud_folio por import-expense-requests.'`);
};

exports.down = async function (knex) {
  // Re-crear la vista sería reintroducir la regresión fiscal → no-op deliberado.
  return Promise.resolve();
};
