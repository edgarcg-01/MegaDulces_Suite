exports.seed = async function(knex) {
  // 1. Limpiamos la tabla
  await knex("catalogs").del();

  // 2. Conceptos de Exhibición
  await knex("catalogs").insert([
    { catalog_id: "conceptos", value: "Exhibidor", puntuacion: 200, orden: 1 },
    { catalog_id: "conceptos", value: "Vitrina", puntuacion: 300, orden: 2 },
    { catalog_id: "conceptos", value: "Vitrolero", puntuacion: 100, orden: 3 },
    { catalog_id: "conceptos", value: "Paletero", puntuacion: 400, orden: 4 },
    { catalog_id: "conceptos", value: "Tiras", puntuacion: 100, orden: 5 },
  ]);

  // 3. Ubicaciones
  await knex("catalogs").insert([
    { catalog_id: "ubicaciones", value: "Caja registradora", puntuacion: 100, orden: 1 },
    { catalog_id: "ubicaciones", value: "Al frente", puntuacion: 80, orden: 2 },
    { catalog_id: "ubicaciones", value: "Pasillo principal", puntuacion: 60, orden: 3 },
    { catalog_id: "ubicaciones", value: "Lado del refrigerador", puntuacion: 50, orden: 4 },
    { catalog_id: "ubicaciones", value: "Al fondo", puntuacion: 20, orden: 5 },
  ]);

  // 4. Niveles de Ejecución
  await knex("catalogs").insert([
    { catalog_id: "niveles", value: "Excelente", puntuacion: 120, orden: 1 },
    { catalog_id: "niveles", value: "Básico", puntuacion: 80, orden: 2 },
    { catalog_id: "niveles", value: "Crítico", puntuacion: 40, orden: 3 },
  ]);

  // 5. ZONAS
  const zonesList = ["LA PIEDAD", "ZAMORA", "MORELIA", "NACIONAL"];
  const insertedZones = await knex("catalogs").insert(
    zonesList.map((z, i) => ({
      catalog_id: "zonas",
      value: z,
      orden: i + 1,
    }))
  ).returning("*");

  // Map for easy access
  const zoneMap = {};
  insertedZones.forEach(z => { zoneMap[z.value] = z.id; });

  // 6. RUTAS por Zona
  const routes = [
    { zone: "LA PIEDAD", names: ["Ruta 01 - Centro", "Ruta 02 - Norte", "Ruta 03 - Sur", "Ruta 04 - Mercado", "Ruta 05 - Periférico"] },
    { zone: "ZAMORA", names: ["Ruta 11 - Juarez", "Ruta 12 - Minsa", "Ruta 13 - Jacona", "Ruta 14 - Centro", "Ruta 15 - Valle"] },
    { zone: "MORELIA", names: ["Ruta 21 - Camelinas", "Ruta 22 - Centro Hist", "Ruta 23 - Tres Marias", "Ruta 24 - Salida Quiroga", "Ruta 25 - Mil Cumbres"] }
  ];

  for (const routeSet of routes) {
    const parentId = zoneMap[routeSet.zone];
    if (parentId) {
      await knex("catalogs").insert(
        routeSet.names.map((name, i) => ({
          catalog_id: "rutas",
          value: name,
          parent_id: parentId,
          orden: i + 1
        }))
      );
    }
  }

  // 7. Roles (Actualizados a RBAC v2)
  await knex("catalogs").insert([
    { catalog_id: "roles", value: "superadmin", orden: 1 },
    { catalog_id: "roles", value: "supervisor_v", orden: 2 },
    { catalog_id: "roles", value: "colaborador", orden: 3 }
  ]);
};
