/**
 * RA-PRO.45 — La curva de supervivencia de las OC, materializada.
 *
 *   P(la OC termina llegando | seguía abierta al día `edad`)
 *
 * 8 filas. La escribe el MISMO importer que arma el fact del pedido (en su transacción), y la leen
 * el motor y la bandeja de OCs abiertas. Existe para que la curva tenga UN solo productor: definirla
 * dos veces (una en el importer, otra en el servicio) es exactamente el patrón que ya nos costó el
 * bug del tránsito fantasma — dos lugares, uno se movió.
 *
 * No lleva RLS (como el resto de analytics.*): se filtra por tenant_id explícito.
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.withSchema('analytics').hasTable('oc_survival_curve');
  if (!exists) {
    await knex.schema.withSchema('analytics').createTable('oc_survival_curve', (t) => {
      t.uuid('tenant_id').notNullable();
      t.integer('edad').notNullable().comment('días abierta (arista inferior del tramo)');
      t.integer('muestra').notNullable().comment('OCs históricas que seguían abiertas a esa edad');
      t.decimal('p', null).notNullable().comment('probabilidad 0..1 de que termine recibiéndose');
      t.boolean('fallback').notNullable().defaultTo(false).comment('true = sin muestra suficiente, valor de respaldo');
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'edad']);
    });
  }
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.oc_survival_curve TO app_runtime`);
};

exports.down = async function down() {
  // aditiva — no se revierte
};
