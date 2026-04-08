/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Mapeo de username -> nombre completo (basado en la tabla proporcionada)
  const userNames = {
    // ZONA LA PIEDAD
    'joaquin_hurtado': 'JOAQUIN HURTADO OROZCO',
    'victorino_urbano': 'VICTORINO URBANO OLIVARES',
    'mariano_martinez': 'MARIANO MARTINEZ PATLAN',
    'victor_garcia': 'VICTOR HUGO GARCIA HURTADO',
    'victor_mata': 'VICTOR ALFONSO MATA VILLA',
    'jose_garcia': 'JOSE DE JESUS GARCIA TORRES',
    'maria_valadez': 'MARIA ELENA VALADEZ LIMON',
    'maria_rocha': 'MARIA TERESA ROCHA FUENTES',

    // ZONA ZAMORA
    'victor_zalapa': 'VICTOR MANUEL ZALAPA BARRIGA',
    'daniel_rojano': 'DANIEL ROJAÑO PADILLA',
    'jose_munoz': 'JOSE LUIS MUÑOZ MOTA',
    'jose_zavala': 'JOSE DE JESUS ZAVALA VILLALOBOS',

    // ZONA MORELIA
    'cesar_plascencia': 'CESAR RICARDO PLASCENCIA RAZO',
    'guillermo_hernandez': 'GUILLERMO HERNANDEZ ALMANZA',
    'enrique_herrera': 'ENRIQUE HERRERA SANCHEZ',
    'joseph_guerrero': 'JOSEPH AGUSTIN GUERRERO PEREZ',
    'eduardo_miranda': 'EDUARDO MIRANDA ROMERO',
  };

  console.log(' Actualizando nombres de usuarios...');

  for (const [username, nombre] of Object.entries(userNames)) {
    const updated = await knex('users')
      .where({ username })
      .update({ nombre });

    if (updated > 0) {
      console.log(`  ✓ ${username} -> ${nombre}`);
    } else {
      console.log(`  ⚠ ${username} no encontrado`);
    }
  }

  // También actualizar supervisores si existen con estos usernames
  const supervisorNames = {
    'angel_vazquez': 'ANGEL ALBERTO VAZQUEZ MEJIA',
    'francisco_martinez': 'FRANCISCO DE JESUS MARTINEZ RAZO',
    'jose_herrera': 'JOSE MANUEL HERRERA MARTINEZ',
  };

  for (const [username, nombre] of Object.entries(supervisorNames)) {
    const updated = await knex('users')
      .where({ username })
      .update({ nombre });

    if (updated > 0) {
      console.log(`  ✓ Supervisor ${username} -> ${nombre}`);
    }
  }

  console.log(' Nombres de usuarios actualizados.');
};
