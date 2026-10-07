/**
 * CB.9.4 — Corrige la regla "código '-' = traspaso" que era demasiado glotona.
 *
 * Estaba en prioridad 11 (antes de las reglas por tipo-M: CF=20, PF=30, DS=40, ID=50),
 * así que se tragaba pagos de factoraje / devoluciones / compras que traían código "-"
 * y los metía al grupo `traspaso`. Efecto: el neteo TI=TE (que cuadra perfecto) salía
 * descuadrado por ~$1.25M (falso positivo en el diagnóstico), y esos movimientos no
 * entraban a su conciliación correcta.
 *
 * Fix: mover esa regla a prioridad 82 (después de todos los tipos-M y códigos base) →
 * el tipo-M gana, y el código "-" solo aplica como fallback a movimientos sin otra señal.
 * Validado vs enero: 8 movs vuelven a su categoría correcta (PF $963k, DS $696k, ID $95k,
 * C $376k) y el descuadre de traspasos baja de -$1.25M a -$698k (residual = tipo-M 'S').
 *
 * Idempotente. Requiere reclasificar después (botón "Reclasificar" o reclassifyAll).
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('bank_classify_rules'))) return;
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
  // Solo si sigue en 11 y la prioridad 82 está libre (idempotente).
  const clash = await knex('finance.bank_classify_rules').where({ tenant_id: MEGA, priority: 82 }).first();
  if (clash) return;
  await knex.raw(
    `UPDATE finance.bank_classify_rules
       SET priority = 82,
           note = 'Código "-" = traspaso (fallback, cede ante tipo-M)',
           updated_at = now()
     WHERE tenant_id = ? AND priority = 11 AND match_code = '^-$'
       AND match_type IS NULL AND match_concept IS NULL`,
    [MEGA],
  );
};

exports.down = async function (knex) {
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
  const clash = await knex('finance.bank_classify_rules').where({ tenant_id: MEGA, priority: 11 }).first();
  if (clash) return;
  await knex.raw(
    `UPDATE finance.bank_classify_rules SET priority = 11, updated_at = now()
     WHERE tenant_id = ? AND priority = 82 AND match_code = '^-$'
       AND match_type IS NULL AND match_concept IS NULL`,
    [MEGA],
  );
};
