/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Agregar campo score_maximo a scoring_config_versions
  await knex.schema.alterTable("scoring_config_versions", (table) => {
    table.decimal("score_maximo", 10, 2).nullable();
    table.timestamp("score_maximo_calculado_at").nullable();
  });

  // Calcular y actualizar score_maximo para versiones existentes
  const versions = await knex("scoring_config_versions").select("*");
  
  for (const version of versions) {
    // Obtener pesos de esta versión
    const pesos = await knex("scoring_pesos")
      .where({ config_version_id: version.id })
      .select("*");
    
    // Agrupar por tipo
    const posicionValues = pesos
      .filter(p => p.tipo === "posicion")
      .map(p => Number(p.valor));
    const exhibicionValues = pesos
      .filter(p => p.tipo === "exhibicion")
      .map(p => Number(p.valor));
    const ejecucionValues = pesos
      .filter(p => p.tipo === "ejecucion")
      .map(p => Number(p.valor));
    
    const maxPosicion = posicionValues.length > 0 ? Math.max(...posicionValues) : 0;
    const maxExhibicion = exhibicionValues.length > 0 ? Math.max(...exhibicionValues) : 0;
    const maxEjecucion = ejecucionValues.length > 0 ? Math.max(...ejecucionValues) : 0;
    
    const scoreMaximo = maxPosicion * maxExhibicion * maxEjecucion;
    
    // Actualizar versión con el score máximo
    await knex("scoring_config_versions")
      .where({ id: version.id })
      .update({
        score_maximo: scoreMaximo,
        score_maximo_calculado_at: knex.fn.now()
      });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.alterTable("scoring_config_versions", (table) => {
    table.dropColumn("score_maximo");
    table.dropColumn("score_maximo_calculado_at");
  });
};
