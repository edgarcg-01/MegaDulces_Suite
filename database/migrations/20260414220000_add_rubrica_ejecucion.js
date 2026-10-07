/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Crear tabla de criterios de rúbrica de ejecución
  await knex.schema.createTable("rubrica_criterios", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("config_version_id").notNullable();
    table.string("criterio", 200).notNullable(); // Ej. "Producto visible de frente"
    table.string("descripcion", 500).nullable();
    table.integer("orden").defaultTo(0);
    table.boolean("activo").defaultTo(true);
    table.timestamp("created_at").defaultTo(knex.fn.now());
    
    // Foreign key
    table.foreign("config_version_id")
      .references("id")
      .inTable("scoring_config_versions")
      .onDelete("CASCADE");
    
    // Índices
    table.index(["config_version_id", "activo"], "idx_rubrica_criterios");
  });

  // Crear tabla de niveles de rúbrica (resultados)
  await knex.schema.createTable("rubrica_niveles", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("config_version_id").notNullable();
    table.string("nombre", 50).notNullable(); // Ej. "Alto", "Medio", "Bajo"
    table.integer("criterios_minimos").notNullable(); // Mínimo de criterios para este nivel
    table.integer("criterios_maximos").notNullable(); // Máximo de criterios para este nivel
    table.decimal("multiplicador", 10, 2).notNullable(); // Valor multiplicador
    table.string("color", 20).nullable(); // Para UI
    table.integer("orden").defaultTo(0);
    table.timestamp("created_at").defaultTo(knex.fn.now());
    
    // Foreign key
    table.foreign("config_version_id")
      .references("id")
      .inTable("scoring_config_versions")
      .onDelete("CASCADE");
    
    // Índices
    table.index(["config_version_id"], "idx_rubrica_niveles");
  });

  // Insertar rúbrica inicial para v1.0
  const version = await knex("scoring_config_versions").where({ version: "v1.0" }).first();
  if (version) {
    // Criterios de ejecución
    const criterios = [
      {
        config_version_id: version.id,
        criterio: "Producto visible de frente sin obstrucciones",
        descripcion: "El producto principal debe estar visible desde el frente del exhibidor",
        orden: 1
      },
      {
        config_version_id: version.id,
        criterio: "Precio visible",
        descripcion: "El precio del producto debe estar claramente visible",
        orden: 2
      },
      {
        config_version_id: version.id,
        criterio: "Sin producto caducado o dañado",
        descripcion: "No debe haber productos vencidos o con daños visibles",
        orden: 3
      },
      {
        config_version_id: version.id,
        criterio: "Exhibición completa según planograma",
        descripcion: "La exhibición debe cumplir con el planograma establecido",
        orden: 4
      },
      {
        config_version_id: version.id,
        criterio: "Material POP visible y en buen estado",
        descripcion: "El material promocional debe estar visible y en buenas condiciones",
        orden: 5
      }
    ];
    await knex("rubrica_criterios").insert(criterios);

    // Niveles de ejecución
    const niveles = [
      {
        config_version_id: version.id,
        nombre: "Alto",
        criterios_minimos: 5,
        criterios_maximos: 5,
        multiplicador: 1.0,
        color: "#10b981",
        orden: 1
      },
      {
        config_version_id: version.id,
        nombre: "Medio",
        criterios_minimos: 3,
        criterios_maximos: 4,
        multiplicador: 0.7,
        color: "#f59e0b",
        orden: 2
      },
      {
        config_version_id: version.id,
        nombre: "Bajo",
        criterios_minimos: 1,
        criterios_maximos: 2,
        multiplicador: 0.4,
        color: "#ef4444",
        orden: 3
      },
      {
        config_version_id: version.id,
        nombre: "Crítico",
        criterios_minimos: 0,
        criterios_maximos: 0,
        multiplicador: 0.2,
        color: "#7f1d1d",
        orden: 4
      }
    ];
    await knex("rubrica_niveles").insert(niveles);
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists("rubrica_niveles");
  await knex.schema.dropTableIfExists("rubrica_criterios");
};
