exports.up = function(knex) {
  return knex.schema
    .table('brands', function(table) {
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    })
    .table('products', function(table) {
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
};

exports.down = function(knex) {
  return knex.schema
    .table('brands', function(table) {
      table.dropColumn('updated_at');
    })
    .table('products', function(table) {
      table.dropColumn('updated_at');
    });
};
