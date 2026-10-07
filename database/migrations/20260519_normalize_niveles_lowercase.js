/**
 * Normalize niveles catalog values to lowercase.
 * Also ensures daily_captures exhibiciones[].nivelEjecucion is lowercase.
 */

exports.up = async function(knex) {
  // 1. Normalize catalogs table - niveles to lowercase
  const niveles = await knex('catalogs').where({ catalog_id: 'niveles' });
  
  for (const nivel of niveles) {
    const lowercaseValue = nivel.value.toLowerCase();
    if (nivel.value !== lowercaseValue) {
      await knex('catalogs')
        .where({ id: nivel.id })
        .update({ value: lowercaseValue });
      console.log(`[Migration] Normalized nivel "${nivel.value}" -> "${lowercaseValue}"`);
    }
  }

  // 2. Normalize daily_captures exhibiciones[].nivelEjecucion to lowercase
  const captures = await knex('daily_captures').select('id', 'exhibiciones');
  
  for (const capture of captures) {
    if (!capture.exhibiciones) continue;
    
    const exArray = typeof capture.exhibiciones === 'string' 
      ? JSON.parse(capture.exhibiciones) 
      : capture.exhibiciones;
    
    let changed = false;
    for (const ex of exArray) {
      if (ex.nivelEjecucion && typeof ex.nivelEjecucion === 'string') {
        const lower = ex.nivelEjecucion.toLowerCase();
        if (ex.nivelEjecucion !== lower) {
          ex.nivelEjecucion = lower;
          changed = true;
        }
      }
    }
    
    if (changed) {
      await knex('daily_captures')
        .where({ id: capture.id })
        .update({ exhibiciones: JSON.stringify(exArray) });
      console.log(`[Migration] Normalized exhibiciones for capture ${capture.id}`);
    }
  }

  console.log('[Migration] Niveles normalization complete');
};

exports.down = async function(knex) {
  // Revert catalogs to Title Case
  const niveles = await knex('catalogs').where({ catalog_id: 'niveles' });
  
  const titleCaseMap = {
    'alto': 'Alto',
    'medio': 'Medio',
    'bajo': 'Bajo',
    'crítico': 'Crítico',
  };
  
  for (const nivel of niveles) {
    const titleValue = titleCaseMap[nivel.value];
    if (titleValue) {
      await knex('catalogs')
        .where({ id: nivel.id })
        .update({ value: titleValue });
    }
  }

  console.log('[Migration] Reverted niveles to Title Case');
};
