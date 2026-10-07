/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // 1. Agregar campos de scoring a daily_captures
  await knex.schema.alterTable("daily_captures", (table) => {
    // Version de configuración vigente al momento del registro
    table.uuid("config_version_id").nullable();
    
    // Score máximo calculado en el momento (inmutable)
    table.decimal("score_maximo", 10, 2).nullable();
    
    // Porcentajes de scoring
    table.decimal("score_calidad_pct", 5, 2).nullable();
    table.decimal("score_cobertura_pct", 5, 2).nullable();
    table.decimal("score_final_pct", 5, 2).nullable();
    
    // Foreign key a scoring_config_versions (nullable para histórico)
    table.foreign("config_version_id")
      .references("id")
      .inTable("scoring_config_versions")
      .onDelete("SET NULL");
  });

  // 2. Agregar campos de configuración a stores
  await knex.schema.alterTable("stores", (table) => {
    // Exhibiciones esperadas según tipo de tienda
    table.integer("exhibiciones_esperadas").nullable().defaultTo(5);
  });

  // NOTA: NO hacer backfill de scores históricos
  // Los registros existentes mantendrán sus valores originales
  // Los nuevos campos serán NULL para registros históricos
  // Solo se calcularán para nuevos registros a partir de esta migración
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  // Revertir cambios en daily_captures
  await knex.schema.alterTable("daily_captures", (table) => {
    table.dropForeign("config_version_id");
    table.dropColumn("config_version_id");
    table.dropColumn("score_maximo");
    table.dropColumn("score_calidad_pct");
    table.dropColumn("score_cobertura_pct");
    table.dropColumn("score_final_pct");
  });

  // Revertir cambios en stores
  await knex.schema.alterTable("stores", (table) => {
    table.dropColumn("exhibiciones_esperadas");
  });
};
