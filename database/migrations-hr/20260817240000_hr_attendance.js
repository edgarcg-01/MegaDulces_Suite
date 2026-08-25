/**
 * Fase CH — schema de asistencia en la base dedicada `hr`.
 *
 * REUSA la migración de `postgres_platform` en vez de copiarla: el schema de
 * asistencia debe ser BIT A BIT el mismo en las dos bases, para que el mismo
 * SQL, los mismos importers y un eventual módulo del backend funcionen contra
 * cualquiera de las dos cambiando solo la cadena de conexión. Duplicar el DDL
 * garantizaba que tarde o temprano divergieran.
 *
 * Knex rastrea las migraciones por nombre de archivo, así que cada base lleva
 * su propio registro y esta no se re-corre en la otra.
 *
 * @param { import("knex").Knex } knex
 */
module.exports = require('../migrations-newdb/20260817220000_hr_attendance.js');
