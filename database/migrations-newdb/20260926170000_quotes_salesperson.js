'use strict';
/**
 * `[COT.1d]` — Vendedor / agente de seguimiento en cotizaciones de mayoreo.
 *
 * Cada sucursal Kepler tiene su plantilla de vendedores (`kepler_ods.kduv`). La cotización
 * registra qué vendedor le dará seguimiento comercial al presupuesto levantado.
 */
exports.up = async function (knex) {
  const has = (t, c) => knex.schema.withSchema('commercial').hasColumn(t, c);
  if (!(await has('quotes', 'salesperson_code'))) {
    await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN salesperson_code varchar(20)`);
  }
  if (!(await has('quotes', 'salesperson_name'))) {
    await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN salesperson_name varchar(100)`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.quotes DROP COLUMN IF EXISTS salesperson_name`);
  await knex.raw(`ALTER TABLE commercial.quotes DROP COLUMN IF EXISTS salesperson_code`);
};
