/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Colaboradores de Logística (choferes, ayudantes, cargadores)
  const colaboradores = [
    {
      nombre: 'JUAN PEREZ GARCIA',
      roles: ['chofer'],
      tipo: 'interno',
      estado: 'activo',
      nss: '12345678901',
      telefono: '3511234567'
    },
    {
      nombre: 'PEDRO LOPEZ MENDOZA',
      roles: ['chofer'],
      tipo: 'interno',
      estado: 'activo',
      nss: '12345678902',
      telefono: '3511234568'
    },
    {
      nombre: 'CARLOS SANCHEZ RODRIGUEZ',
      roles: ['chofer'],
      tipo: 'interno',
      estado: 'activo',
      nss: '12345678903',
      telefono: '3511234569'
    },
    {
      nombre: 'MIGUEL ANGEL HERNANDEZ',
      roles: ['ayudante'],
      tipo: 'interno',
      estado: 'activo',
      nss: '12345678904',
      telefono: '3511234570'
    },
    {
      nombre: 'JOSE LUIS GONZALEZ',
      roles: ['ayudante'],
      tipo: 'interno',
      estado: 'activo',
      nss: '12345678905',
      telefono: '3511234571'
    },
    {
      nombre: 'ANTONIO RAMIREZ FLORES',
      roles: ['ayudante', 'cargador'],
      tipo: 'interno',
      estado: 'activo',
      nss: '12345678906',
      telefono: '3511234572'
    },
    {
      nombre: 'FRANCISCO JIMENEZ CRUZ',
      roles: ['cargador'],
      tipo: 'interno',
      estado: 'activo',
      nss: '12345678907',
      telefono: '3511234573'
    },
    {
      nombre: 'RAUL MORALES TORRES',
      roles: ['cargador'],
      tipo: 'interno',
      estado: 'activo',
      nss: '12345678908',
      telefono: '3511234574'
    }
  ];

  const existingColaboradores = await knex('logistica_colaboradores').select('nombre');
  const existingColaboradorNames = existingColaboradores.map(c => c.nombre);

  const colaboradoresToInsert = colaboradores
    .filter(c => !existingColaboradorNames.includes(c.nombre))
    .map(c => ({
      ...c,
      roles: `{${c.roles.join(',')}}`
    }));

  if (colaboradoresToInsert.length > 0) {
    await knex('logistica_colaboradores').insert(colaboradoresToInsert);
    console.log(`[01c_logistica_colaboradores] Inserted ${colaboradoresToInsert.length} colaboradores.`);
  } else {
    console.log('[01c_logistica_colaboradores] All colaboradores already exist, skipping.');
  }
};
