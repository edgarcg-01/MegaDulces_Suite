/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Embarques de ejemplo
  const colaboradores = await knex('logistica_colaboradores').select('id', 'nombre').limit(5);
  const unidades = await knex('logistica_unidades').select('id', 'placa').limit(3);
  const destinos = await knex('logistica_catalogo_destinos').select('nombre').limit(5);

  if (colaboradores.length < 2 || unidades.length < 1 || destinos.length < 1) {
    console.log('[01e_logistica_embarques] Not enough data to create sample embarques, skipping.');
    return;
  }

  const chofer = colaboradores[0];
  const ayudante = colaboradores[1];
  const unidad = unidades[0];
  const destino = destinos[0];

  const embarques = [
    {
      folio: 'EMB-2026-001',
      fecha: new Date('2026-04-15'),
      unidad_id: unidad.id,
      origen: 'ZAMORA',
      destino_texto: destino.nombre,
      km: 120,
      flete: 3500.00,
      valor_carga: 45000.00,
      cajas: 200,
      peso: 8500.00,
      estado: 'completado'
    },
    {
      folio: 'EMB-2026-002',
      fecha: new Date('2026-04-16'),
      unidad_id: unidades[1]?.id || unidad.id,
      origen: 'MORELIA',
      destino_texto: destinos[1]?.nombre || 'GUADALAJARA',
      km: 180,
      flete: 5200.00,
      valor_carga: 62000.00,
      cajas: 280,
      peso: 12000.00,
      estado: 'en_transito'
    },
    {
      folio: 'EMB-2026-003',
      fecha: new Date('2026-04-17'),
      unidad_id: unidades[2]?.id || unidad.id,
      origen: 'LA PIEDAD',
      destino_texto: destinos[2]?.nombre || 'LEON',
      km: 95,
      flete: 2800.00,
      valor_carga: 32000.00,
      cajas: 150,
      peso: 6500.00,
      estado: 'programado'
    }
  ];

  const existingEmbarques = await knex('logistica_embarques').select('folio');
  const existingFolios = existingEmbarques.map(e => e.folio);

  const embarquesToInsert = embarques.filter(e => !existingFolios.includes(e.folio));

  if (embarquesToInsert.length > 0) {
    const insertedEmbarques = await knex('logistica_embarques').insert(embarquesToInsert).returning('*');
    console.log(`[01e_logistica_embarques] Inserted ${insertedEmbarques.length} embarques.`);
    console.log(`[01e_logistica_embarques] Skipping guias creation due to schema differences.`);
  } else {
    console.log('[01e_logistica_embarques] All embarques already exist, skipping.');
  }
};
