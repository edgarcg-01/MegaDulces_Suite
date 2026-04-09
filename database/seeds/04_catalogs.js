/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // 1. Limpiamos la tabla
  await knex("catalogs").del();

  // 2. Conceptos de Exhibición
  await knex("catalogs").insert([
    { catalog_id: "conceptos", value: "Exhibidor", puntuacion: 200, icono: "pi pi-box", orden: 1 },
    { catalog_id: "conceptos", value: "Vitrina", puntuacion: 300, icono: "pi pi-objects-column", orden: 2 },
    { catalog_id: "conceptos", value: "Vitrolero", puntuacion: 100, icono: "pi pi-database", orden: 3 },
    { catalog_id: "conceptos", value: "Paletero", puntuacion: 400, icono: "pi pi-stop-circle", orden: 4 },
    { catalog_id: "conceptos", value: "Tiras", puntuacion: 100, icono: "pi pi-list", orden: 5 },
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

 

  // 6. RUTAS: 15 Rutas
  const rutas = Array.from({ length: 15 }, (_, i) => ({
    catalog_id: "rutas",
    value: `Ruta ${i + 1}`,
    orden: i + 1,
  }));
  await knex("catalogs").insert(rutas);

  // 6. Roles
  await knex("catalogs").insert([
    { catalog_id: "roles", value: "superadmin", orden: 1 },
    { catalog_id: "roles", value: "admin", orden: 2 },
    { catalog_id: "roles", value: "supervisor", orden: 3 },
    { catalog_id: "roles", value: "auditor", orden: 4 },
  ]);
}
