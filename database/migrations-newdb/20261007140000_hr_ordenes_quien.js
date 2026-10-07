/**
 * Fase RH · `[RH.1.2]` — quién pidió cada orden al reloj, también para lo que llega de Mega Talento.
 *
 * `hr.device_commands.requested_by` es el `uuid` de la persona en la Suite. Las 120 órdenes de
 * Mega Talento (renombrados y borrados, con los RESPALDOS que permiten restaurar a alguien)
 * guardan a quien las pidió como texto (su correo). Misma convención que las incidencias: el
 * `uuid` para lo nuevo y `*_name` para lo histórico; lo nuevo llena los dos.
 *
 * Aditiva e idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('hr').hasTable('device_commands'))) return;
  if (!(await knex.schema.withSchema('hr').hasColumn('device_commands', 'requested_by_name'))) {
    await knex.raw(`ALTER TABLE hr.device_commands ADD COLUMN requested_by_name text`);
    await knex.raw(`COMMENT ON COLUMN hr.device_commands.requested_by_name IS 'Fase RH: quién pidió la orden, como texto (lo histórico de Mega Talento lo trae así).'`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE hr.device_commands DROP COLUMN IF EXISTS requested_by_name`);
};
