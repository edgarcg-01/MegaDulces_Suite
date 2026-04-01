const knex = require('knex');
const config = require('./knexfile').default;
const db = knex(config.development);

async function runSeeds() {
  try {
    console.log('--- Reseteando Tablas ---');
    await db("planograma_productos").del();
    await db("planograma_marcas").del();
    await db("catalogs").del();

    console.log('--- Sembrando Marcas ---');
    const [bimboId] = await db("planograma_marcas").insert({ nombre: "Bimbo", activo: true, orden: 1 }).returning("id");
    const [marinelaId] = await db("planograma_marcas").insert({ nombre: "Marinela", activo: true, orden: 2 }).returning("id");
    const [barcelId] = await db("planograma_marcas").insert({ nombre: "Barcel", activo: true, orden: 3 }).returning("id");
    const [tiaRosaId] = await db("planograma_marcas").insert({ nombre: "Tía Rosa", activo: true, orden: 4 }).returning("id");

    console.log('--- Sembrando Productos ---');
    await db("planograma_productos").insert([
      { marca_id: bimboId.id, nombre: "Pan Blanco Large", puntuacion: 5, orden: 1 },
      { marca_id: bimboId.id, nombre: "Pan Integral", puntuacion: 5, orden: 2 },
      { marca_id: bimboId.id, nombre: "Medias Noches 8p", puntuacion: 3, orden: 3 },
      { marca_id: marinelaId.id, nombre: "Gansito 50g", puntuacion: 8, orden: 1 },
      { marca_id: barcelId.id, nombre: "Takis Fuego", puntuacion: 10, orden: 1 },
      { marca_id: tiaRosaId.id, nombre: "Tortillinas 12p", puntuacion: 5, orden: 1 },
    ]);

    console.log('--- Sembrando Catálogos ---');
    await db("catalogs").insert([
      { catalog_id: "conceptos", value: "Exhibidor", puntuacion: 10, icono: "pi pi-box", orden: 1 },
      { catalog_id: "conceptos", value: "Vitrina", puntuacion: 15, icono: "pi pi-desktop", orden: 2 },
      { catalog_id: "conceptos", value: "Tiras", puntuacion: 5, icono: "pi pi-bars", orden: 3 },
      { catalog_id: "ubicaciones", value: "Al frente", puntuacion: 20, orden: 1 },
      { catalog_id: "ubicaciones", value: "Lado del refrigerador", puntuacion: 15, orden: 2 },
    ]);

    console.log('✅ Semilla completada con éxito.');
  } catch (err) {
    console.error('❌ Error sembrando:', err);
  } finally {
    await db.destroy();
  }
}

runSeeds();
