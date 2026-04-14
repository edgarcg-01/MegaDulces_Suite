/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // 1. Crear tabla de versiones de configuración de scoring
  await knex.schema.createTable("scoring_config_versions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("version", 20).notNullable(); // Ej. "v1.0"
    table.timestamp("fecha_inicio").notNullable().defaultTo(knex.fn.now());
    table.timestamp("fecha_fin").nullable(); // null si vigente
    table.string("creado_por", 100).notNullable();
    table.text("notas").nullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    
    // Índices
    table.index(["fecha_inicio", "fecha_fin"], "idx_scoring_versions_vigente");
  });

  // 2. Crear tabla de pesos de scoring (normalizada)
  await knex.schema.createTable("scoring_pesos", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("config_version_id").notNullable();
    table.enum("tipo", ["posicion", "exhibicion", "ejecucion"]).notNullable();
    table.string("nombre", 100).notNullable(); // Ej. "caja", "alto"
    table.decimal("valor", 10, 2).notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    
    // Foreign key
    table.foreign("config_version_id")
      .references("id")
      .inTable("scoring_config_versions")
      .onDelete("CASCADE");
    
    // Índices
    table.index(["config_version_id", "tipo"], "idx_scoring_pesos_version_tipo");
    table.unique(["config_version_id", "tipo", "nombre"], "uniq_scoring_pesos");
  });

  // 3. Crear tabla de combinaciones válidas (posicion × exhibicion)
  await knex.schema.createTable("combinaciones_validas", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("config_version_id").notNullable();
    table.uuid("posicion_id").notNullable();
    table.uuid("exhibicion_id").notNullable();
    table.boolean("activo").defaultTo(true);
    table.timestamp("created_at").defaultTo(knex.fn.now());
    
    // Foreign keys
    table.foreign("config_version_id")
      .references("id")
      .inTable("scoring_config_versions")
      .onDelete("CASCADE");
    
    // Índices
    table.index(["config_version_id", "posicion_id", "exhibicion_id"], "idx_combinaciones_validas");
  });

  // 4. Migrar configuración actual a versión v1.0
  const currentConfig = await knex("scoring_config").first();
  if (currentConfig) {
    const config = typeof currentConfig.config === "string" 
      ? JSON.parse(currentConfig.config) 
      : currentConfig.config;

    // Crear versión v1.0
    const [version] = await knex("scoring_config_versions").insert({
      version: "v1.0",
      fecha_inicio: knex.fn.now(),
      creado_por: "system_migration",
      notas: "Migración desde scoring_config original"
    }).returning("*");

    // Migrar pesos_posicion
    if (config.pesos_posicion) {
      const pesosPosicion = Object.entries(config.pesos_posicion).map(([nombre, valor]) => ({
        config_version_id: version.id,
        tipo: "posicion",
        nombre,
        valor
      }));
      await knex("scoring_pesos").insert(pesosPosicion);
    }

    // Migrar factores_tipo
    if (config.factores_tipo) {
      const factoresTipo = Object.entries(config.factores_tipo).map(([nombre, valor]) => ({
        config_version_id: version.id,
        tipo: "exhibicion",
        nombre,
        valor
      }));
      await knex("scoring_pesos").insert(factoresTipo);
    }

    // Migrar niveles_ejecucion
    if (config.niveles_ejecucion) {
      const nivelesEjecucion = Object.entries(config.niveles_ejecucion).map(([nombre, valor]) => ({
        config_version_id: version.id,
        tipo: "ejecucion",
        nombre,
        valor
      }));
      await knex("scoring_pesos").insert(nivelesEjecucion);
    }
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists("combinaciones_validas");
  await knex.schema.dropTableIfExists("scoring_pesos");
  await knex.schema.dropTableIfExists("scoring_config_versions");
};
