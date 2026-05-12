exports.up = async function (knex) {
  const updated = await knex.raw(`
    UPDATE stores s
    SET zona_id = z.id
    FROM zones z
    WHERE s.zona_id IS NULL
      AND s.zona IS NOT NULL
      AND LOWER(TRIM(s.zona)) = LOWER(z.name)
    RETURNING s.id, s.nombre, z.name as zona_asignada
  `);

  const count = updated?.rows?.length || 0;
  console.log(`[Migration] Backfilled zona_id for ${count} stores`);

  if (count > 0) {
    console.log('[Migration] Stores fixed:', updated.rows.map(r => `${r.nombre} → ${r.zona_asignada}`).join(', '));
  }
};

exports.down = async function (knex) {
  console.log('[Migration] No-op: cannot revert automatic zone assignment');
};
