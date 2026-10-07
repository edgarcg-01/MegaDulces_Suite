/**
 * RESCATE histórico (ya corrido — NO modificar): restauró los permisos del
 * rol `superadmin` cuando se pensó que estaba corrupto.
 *
 * Al diagnosticar contra la DB directa, se confirmó que `superadmin` ya tenía
 * los 20 permisos correctos. El síntoma reportado ("veo permisos como
 * colaborador") era un bug en el frontend (auth.service.ts esperaba `rules`
 * en el JWT que el backend dejó de mandar). Esa parte se arregló en el
 * commit que devolvió `rules` al JWT.
 *
 * Esta migración quedó registrada en `knex_migrations` (id=85, batch=3) en
 * el deploy que la corrió. Borrar el archivo hizo que knex tirara
 * "migration directory is corrupt". Para resolver sin tocar la tabla
 * `knex_migrations`, dejamos el archivo presente pero con cuerpo vacío:
 * knex ve la fila como ya aplicada y no la vuelve a ejecutar.
 *
 * @param { import("knex").Knex } _knex
 * @returns { Promise<void> }
 */
exports.up = async function (_knex) {
  // No-op. Ya aplicada en producción; mantenida solo para satisfacer el
  // chequeo de integridad de knex (`validateMigrationList`).
};

/**
 * @param { import("knex").Knex } _knex
 * @returns { Promise<void> }
 */
exports.down = async function (_knex) {
  // No-op intencional.
};
