/**
 * Crea la zona MORELIA MADERO + rutas RUTA 321 y RUTA 322 (catálogos de venta,
 * catalogs.catalog_id='rutas'). Decisión del usuario: las rutas 321/322 del
 * maestro de clientes (Excel CLIENTES RUTAS) pertenecen a una zona nueva
 * "Morelia Madero", distinta de LA PIEDAD RD y de la zona MORELIA existente.
 *
 * Idempotente (crea solo si no existen, por nombre/valor). Scoped a Mega Dulces.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const T = '00000000-0000-0000-0000-00000000d01c';

  // 1) Zona MORELIA MADERO
  let zone = await knex('zones')
    .where({ tenant_id: T })
    .whereRaw("UPPER(name) = 'MORELIA MADERO'")
    .whereNull('deleted_at')
    .first();
  if (!zone) {
    const maxZ = await knex('zones').where({ tenant_id: T }).max('orden as m').first();
    const [row] = await knex('zones')
      .insert({ tenant_id: T, name: 'MORELIA MADERO', orden: Number(maxZ?.m || 0) + 1, is_system: false })
      .returning('*');
    zone = row;
    console.log('[morelia_madero] zona creada id=' + zone.id);
  } else {
    console.log('[morelia_madero] zona ya existía id=' + zone.id);
  }

  // 2) Rutas RUTA 321 / RUTA 322 bajo esa zona
  const maxR = await knex('catalogs')
    .where({ tenant_id: T, catalog_id: 'rutas' })
    .max('orden as m')
    .first();
  let orden = Number(maxR?.m || 0);
  for (const value of ['RUTA 321', 'RUTA 322']) {
    const exists = await knex('catalogs')
      .where({ tenant_id: T, catalog_id: 'rutas', value })
      .whereNull('deleted_at')
      .first();
    if (exists) {
      console.log(`[morelia_madero] ${value} ya existía`);
      continue;
    }
    orden += 1;
    await knex('catalogs').insert({
      tenant_id: T,
      catalog_id: 'rutas',
      value,
      orden,
      puntuacion: 0,
      parent_id: zone.id,
    });
    console.log(`[morelia_madero] ${value} creada bajo MORELIA MADERO.`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: borrarlas rompería referencias de tiendas/clientes ya asignados.
  console.log('[morelia_madero] down: no-op');
};
