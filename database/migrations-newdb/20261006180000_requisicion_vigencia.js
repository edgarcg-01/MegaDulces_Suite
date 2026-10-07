/**
 * `[RQ.1]` La requisición declara CUÁNDO se le refrescaron los precios.
 *
 * Por qué hace falta, medido contra prod el 2026-10-06 sobre las 610 requisiciones que llevan
 * meses en `pending_approval`, comparando el `unit_cost` que capturó el renglón contra el
 * `caja_cost` de hoy en `analytics.replenishment_plan`:
 *
 *     antigüedad      renglones   costo que ya se movió   monto
 *     0-7 dias            132              6.1 %          $ 1,195,847
 *     8-30 dias           283             13.6 %          $ 2,804,783
 *     31-60 dias          766             83.5 %          $17,498,782
 *     60+ dias            261             98.7 %          $   828,094
 *
 * O sea: **$18.3 M de requisiciones pendientes tienen 31+ dias y entre el 84 % y el 99 % de sus
 * costos ya no son los de hoy.** Aprobar una de esas es ordenar a un precio que ya cambió, y
 * hasta ahora la ficha no lo decia en ningun lado.
 *
 * ⚠️ LAS DOS COLUMNAS SON LA CONSTANCIA DEL REFRESCO, NO LA VIGENCIA.
 * La vigencia se MIDE en el momento de leerla (renglon contra el plan de hoy) y no se guarda:
 * un valor guardado envejece solo y vuelve a mentir, que es exactamente el problema que esto
 * viene a cerrar. Acá solo queda quien apretó "Recalcular" y cuando.
 *
 * ⚠️ La unidad se verifico ANTES de construir sobre ella (ADR-057): la razon
 * `unit_cost` / `caja_cost` da **1.0000 exacto en 435 de 435** renglones de 0-3 dias, en los dos
 * tipos (281 traspaso + 154 compra). Son la misma unidad — la caja de ESE almacen — asi que la
 * deriva medida arriba es movimiento de costo, no un artefacto de conversion.
 *
 * Aditiva e idempotente: dos columnas nullable sobre una tabla de 670 filas. No toca RLS ni
 * indices ni datos existentes.
 */
exports.up = async function up(knex) {
  const tabla = 'purchase_requisitions';
  const tieneRecalcAt = await knex.schema.withSchema('commercial').hasColumn(tabla, 'recalculated_at');
  const tieneRecalcBy = await knex.schema.withSchema('commercial').hasColumn(tabla, 'recalculated_by');
  if (!tieneRecalcAt || !tieneRecalcBy) {
    await knex.schema.withSchema('commercial').alterTable(tabla, (t) => {
      if (!tieneRecalcAt) t.timestamp('recalculated_at', { useTz: true }).nullable();
      if (!tieneRecalcBy) t.uuid('recalculated_by').nullable();
    });
  }
  await knex.raw(`
    COMMENT ON COLUMN commercial.purchase_requisitions.recalculated_at IS
      '[RQ.1] Cuando se refrescaron los costos de los renglones contra analytics.replenishment_plan. NULL = nunca: los costos son los del dia en que se creo.';
    COMMENT ON COLUMN commercial.purchase_requisitions.recalculated_by IS
      '[RQ.1] Quien apreto Recalcular. identity.users.id, sin FK a proposito (mismo criterio que created_by/approved_by en esta tabla).';
  `);
};

exports.down = async function down(knex) {
  const tabla = 'purchase_requisitions';
  const tieneRecalcAt = await knex.schema.withSchema('commercial').hasColumn(tabla, 'recalculated_at');
  const tieneRecalcBy = await knex.schema.withSchema('commercial').hasColumn(tabla, 'recalculated_by');
  if (tieneRecalcAt || tieneRecalcBy) {
    await knex.schema.withSchema('commercial').alterTable(tabla, (t) => {
      if (tieneRecalcAt) t.dropColumn('recalculated_at');
      if (tieneRecalcBy) t.dropColumn('recalculated_by');
    });
  }
};
