/**
 * Migration to fix scoring_pesos: add missing "Crítico" level and normalize names
 * to match the catalogs table (capitalized: "Alto", "Medio", "Bajo", "Crítico")
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  console.log("[FixScoringPesos] Checking scoring_pesos for level consistency...");

  // Get the active config version
  const activeVersion = await knex('scoring_config_versions')
    .whereNull('fecha_fin')
    .orderBy('fecha_inicio', 'desc')
    .first();

  if (!activeVersion) {
    console.log("[FixScoringPesos] No active scoring config version found. Skipping.");
    return;
  }

  const configVersionId = activeVersion.id;

  // 1. Check existing execution levels
  const existingLevels = await knex('scoring_pesos')
    .where({ config_version_id: configVersionId, tipo: 'ejecucion' });

  console.log("[FixScoringPesos] Existing execution levels:", existingLevels.length);

  // Build a map of existing levels by lowercase name
  const existingMap = {};
  existingLevels.forEach(l => {
    existingMap[l.nombre.toLowerCase()] = l;
  });

  // 2. Define the correct levels (matching catalogs table)
  const correctLevels = [
    { nombre: 'Alto',    valor: 1.0,   orden: 1 },
    { nombre: 'Medio',   valor: 0.7,   orden: 2 },
    { nombre: 'Bajo',    valor: 0.4,   orden: 3 },
    { nombre: 'Crítico', valor: 0.2,   orden: 4 },
  ];

  for (const level of correctLevels) {
    const existing = existingMap[level.nombre.toLowerCase()];

    if (existing) {
      // Update existing record to have correct name and value
      await knex('scoring_pesos')
        .where({ id: existing.id })
        .update({ nombre: level.nombre, valor: level.valor });
      console.log(`[FixScoringPesos] Updated level: "${existing.nombre}" → "${level.nombre}" (valor: ${level.valor})`);
    } else {
      // Insert missing level
      await knex('scoring_pesos').insert({
        config_version_id: configVersionId,
        tipo: 'ejecucion',
        nombre: level.nombre,
        valor: level.valor,
      });
      console.log(`[FixScoringPesos] Inserted missing level: "${level.nombre}" (valor: ${level.valor})`);
    }
  }

  // 3. Also fix posicion and exhibicion names to match catalogs
  // Get all catalogs
  const ubicaciones = await knex('catalogs').where({ catalog_id: 'ubicaciones' });
  const conceptos = await knex('catalogs').where({ catalog_id: 'conceptos' });

  // Fix posicion names
  const existingPosiciones = await knex('scoring_pesos')
    .where({ config_version_id: configVersionId, tipo: 'posicion' });

  const posicionMap = {};
  existingPosiciones.forEach(p => {
    posicionMap[p.nombre.toLowerCase()] = p;
  });

  for (const ubi of ubicaciones) {
    const existing = posicionMap[ubi.value.toLowerCase()];
    if (existing) {
      await knex('scoring_pesos')
        .where({ id: existing.id })
        .update({ nombre: ubi.value });
    }
  }

  // Fix exhibicion names
  const existingExhibiciones = await knex('scoring_pesos')
    .where({ config_version_id: configVersionId, tipo: 'exhibicion' });

  const exhibicionMap = {};
  existingExhibiciones.forEach(e => {
    exhibicionMap[e.nombre.toLowerCase()] = e;
  });

  for (const con of conceptos) {
    const existing = exhibicionMap[con.value.toLowerCase()];
    if (existing) {
      await knex('scoring_pesos')
        .where({ id: existing.id })
        .update({ nombre: con.value });
    }
  }

  // 4. Recalculate score_maximo
  const pesos = await knex('scoring_pesos')
    .where({ config_version_id: configVersionId });

  const posicionValues = pesos.filter(p => p.tipo === 'posicion').map(p => Number(p.valor));
  const exhibicionValues = pesos.filter(p => p.tipo === 'exhibicion').map(p => Number(p.valor));
  const ejecucionValues = pesos.filter(p => p.tipo === 'ejecucion').map(p => Number(p.valor));

  const maxPosicion = posicionValues.length > 0 ? Math.max(...posicionValues) : 0;
  const maxExhibicion = exhibicionValues.length > 0 ? Math.max(...exhibicionValues) : 0;
  const maxEjecucion = ejecucionValues.length > 0 ? Math.max(...ejecucionValues) : 0;
  const scoreMaximo = maxPosicion * maxExhibicion * maxEjecucion;

  await knex('scoring_config_versions')
    .where({ id: configVersionId })
    .update({
      score_maximo: scoreMaximo,
      score_maximo_calculado_at: knex.fn.now()
    });

  console.log(`[FixScoringPesos] Recalculated score_maximo: ${maxPosicion} × ${maxExhibicion} × ${maxEjecucion} = ${scoreMaximo}`);
  console.log("[FixScoringPesos] Done!");
};

exports.down = async function(knex) {
  // No down needed - this is a data fix migration
  console.log("[FixScoringPesos] Down migration not applicable for data fix.");
};
