/**
 * FIX P1 — FK faltante `commercial.purchase_requisition_lines.supplier_id`.
 *
 * Inconsistencia detectada en el audit: la tabla PADRE `purchase_requisitions` YA protege
 * `(tenant_id, supplier_id) → catalog.suppliers (tenant_id, id) ON DELETE SET NULL`
 * (mig 20260708120000:111), pero la LÍNEA no. Mismo atributo, protegido en cabecera y suelto en
 * detalle. Se replica la MISMA FK compuesta + regla (match → SET NULL: perder el proveedor no debe
 * borrar la línea). 0 huérfanos verificado (1,675 filas). Idempotente. Reversible.
 * @param { import("knex").Knex } knex
 */
const NAME = 'fk_purch_req_lines_supplier';

exports.up = async function (knex) {
  const exists = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname=? AND conrelid=to_regclass('commercial.purchase_requisition_lines')`, [NAME]);
  if (exists.rows.length) return;
  await knex.raw(
    `ALTER TABLE commercial.purchase_requisition_lines
       ADD CONSTRAINT ${NAME} FOREIGN KEY (tenant_id, supplier_id)
       REFERENCES catalog.suppliers (tenant_id, id) ON DELETE SET NULL NOT VALID`);
  await knex.raw(`ALTER TABLE commercial.purchase_requisition_lines VALIDATE CONSTRAINT ${NAME}`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.purchase_requisition_lines DROP CONSTRAINT IF EXISTS ${NAME}`);
};
