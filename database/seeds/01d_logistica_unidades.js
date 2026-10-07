/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Unidades / Flotilla de Logística
  const unidades = [
    {
      placa: 'ABC-123-4',
      modelo: 'INTERNATIONAL',
      rendimiento: 3.5,
      capacidad_cajas: 400,
      capacidad_kg: 15000,
      estado: 'disponible'
    },
    {
      placa: 'DEF-567-8',
      modelo: 'INTERNATIONAL II',
      rendimiento: 3.2,
      capacidad_cajas: 450,
      capacidad_kg: 18000,
      estado: 'disponible'
    },
    {
      placa: 'GHI-901-2',
      modelo: 'FREIGHTLINER STD',
      rendimiento: 4.0,
      capacidad_cajas: 500,
      capacidad_kg: 20000,
      estado: 'disponible'
    },
    {
      placa: 'JKL-345-6',
      modelo: 'FREIGHTLINER AUTO',
      rendimiento: 3.8,
      capacidad_cajas: 480,
      capacidad_kg: 19000,
      estado: 'disponible'
    },
    {
      placa: 'MNO-789-0',
      modelo: 'HINO 500',
      rendimiento: 2.5,
      capacidad_cajas: 300,
      capacidad_kg: 12000,
      estado: 'disponible'
    },
    {
      placa: 'PQR-234-5',
      modelo: 'F-350',
      rendimiento: 8.0,
      capacidad_cajas: 100,
      capacidad_kg: 4000,
      estado: 'disponible'
    },
    {
      placa: 'STU-678-9',
      modelo: 'NISSAN',
      rendimiento: 7.5,
      capacidad_cajas: 80,
      capacidad_kg: 3500,
      estado: 'disponible'
    }
  ];

  const existingUnidades = await knex('logistica_unidades').select('placa');
  const existingUnidadPlacas = existingUnidades.map(u => u.placa);

  const unidadesToInsert = unidades.filter(u => !existingUnidadPlacas.includes(u.placa));

  if (unidadesToInsert.length > 0) {
    await knex('logistica_unidades').insert(unidadesToInsert);
    console.log(`[01d_logistica_unidades] Inserted ${unidadesToInsert.length} unidades.`);
  } else {
    console.log('[01d_logistica_unidades] All unidades already exist, skipping.');
  }
};
