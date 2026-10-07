/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
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
