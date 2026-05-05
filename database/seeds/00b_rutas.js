/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Only insert if routes are empty
  const count = await knex("catalogs").where({ catalog_id: 'rutas' }).count("id as count").first();
  if (count && count.count > 0) {
    console.log("[00b_rutas] Routes already exist, skipping seed.");
    return;
  }

  // Get zones to use as parent_id
  const zones = await knex("zones").select("id", "name");
  
  // Define routes for each zone
  const routesByZone = {
    'LA PIEDAD': [
      { value: 'Ruta 1 - Centro', orden: 1 },
      { value: 'Ruta 2 - Norte', orden: 2 },
      { value: 'Ruta 3 - Sur', orden: 3 },
      { value: 'Ruta 4 - Oriente', orden: 4 },
    ],
    'ZAMORA': [
      { value: 'Ruta 1 - Centro', orden: 1 },
      { value: 'Ruta 2 - Industrial', orden: 2 },
      { value: 'Ruta 3 - Comercial', orden: 3 },
    ],
    'MORELIA': [
      { value: 'Ruta 1 - Centro Histórico', orden: 1 },
      { value: 'Ruta 2 - Valladolid', orden: 2 },
      { value: 'Ruta 3 - Universidad', orden: 3 },
      { value: 'Ruta 4 - Las Americas', orden: 4 },
      { value: 'Ruta 5 - Plaza Sendero', orden: 5 },
    ],
    'NACIONAL': [
      { value: 'Ruta 1 - Norte', orden: 1 },
      { value: 'Ruta 2 - Sur', orden: 2 },
      { value: 'Ruta 3 - Este', orden: 3 },
      { value: 'Ruta 4 - Oeste', orden: 4 },
    ],
    'CANINDO': [
      { value: 'Ruta 1 - Principal', orden: 1 },
      { value: 'Ruta 2 - Secundaria', orden: 2 },
    ]
  };

  // Insert routes for each zone
  const routesToInsert = [];
  for (const zone of zones) {
    const zoneRoutes = routesByZone[zone.name] || [];
    for (const route of zoneRoutes) {
      routesToInsert.push({
        id: knex.raw('gen_random_uuid()'),
        catalog_id: 'rutas',
        parent_id: zone.id,
        value: route.value,
        orden: route.orden,
        puntuacion: 0,
        icono: null
      });
    }
  }

  if (routesToInsert.length > 0) {
    await knex("catalogs").insert(routesToInsert);
    console.log(`[00b_rutas] Inserted ${routesToInsert.length} routes for ${zones.length} zones`);
  }
};
