/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // [CI.LEGACY] Estas tablas de logística se crearon a mano en la base legacy; ninguna migración
  // las crea. Sobre una base vacía (el CI) no existen: se declara y no se hace nada. En la base
  // legacy existen y esta migración ya estaba aplicada, así que ahí no cambia nada.
  for (const t of ['logistica_checklists','logistica_fotos_entrega']) {
    if (!(await knex.schema.hasTable(t))) {
      console.log(`[20260427000002_fix_checklists_fotos_foreign_keys] NO MEDIDO: falta la tabla ${t} (creada a mano en la base legacy); se omite.`);
      return;
    }
  }
  return upOriginal(knex);
};

async function upOriginal(knex) {
  return knex.transaction(async (trx) => {
    // Primero eliminar datos que violan la foreign key en logistica_checklists
    await trx('logistica_checklists')
      .whereNotExists(
        trx('users').select('id').whereRaw('logistica_checklists.creado_por = users.id')
      )
      .del();

    // Primero eliminar datos que violan la foreign key en logistica_fotos_entrega
    await trx('logistica_fotos_entrega')
      .whereNotExists(
        trx('users').select('id').whereRaw('logistica_fotos_entrega.subido_por = users.id')
      )
      .del();

    // Corregir foreign key de logistica_checklists.creado_por
    await trx.schema
      .alterTable('logistica_checklists', (table) => {
        table.dropForeign('creado_por');
        table.foreign('creado_por').references('id').inTable('users');
      });

    // Corregir foreign key de logistica_fotos_entrega.subido_por
    await trx.schema
      .alterTable('logistica_fotos_entrega', (table) => {
        table.dropForeign('subido_por');
        table.foreign('subido_por').references('id').inTable('users');
      });
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.transaction(async (trx) => {
    // Revertir foreign key de logistica_checklists.creado_por
    await trx.schema
      .alterTable('logistica_checklists', (table) => {
        table.dropForeign('creado_por');
        table.foreign('creado_por').references('id').inTable('logistica_colaboradores');
      });

    // Revertir foreign key de logistica_fotos_entrega.subido_por
    await trx.schema
      .alterTable('logistica_fotos_entrega', (table) => {
        table.dropForeign('subido_por');
        table.foreign('subido_por').references('id').inTable('logistica_colaboradores');
      });
  });
};
