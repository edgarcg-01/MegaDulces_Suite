/**
 * Agrega Canels 4s (id c1322126-41e9-4d9e-9b58-c6663a83ad07) a 30 exhibiciones
 * existentes en concepto=Tira que aún no lo tienen.
 *
 * Uso: DATABASE_URL='...' node database/add-canels-4s.js
 */
const knex = require('knex');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: falta DATABASE_URL');
  process.exit(1);
}

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

const CANELS_4S_ID = 'c1322126-41e9-4d9e-9b58-c6663a83ad07';
const TIRA_CONCEPTO_ID = 'f1e1033c-0c5c-4f9a-94f8-d43076bb267f';
const TARGET = 30;
const PER_PRODUCT_CAP = 200;

(async () => {
  try {
    // Verificar conteo actual
    const beforeCount = await db.raw(`
      SELECT COUNT(*) AS c
      FROM daily_captures dc
      CROSS JOIN LATERAL jsonb_array_elements(dc.exhibiciones) AS exh
      CROSS JOIN LATERAL jsonb_array_elements(exh->'productosMarcados') AS pid
      WHERE TRIM(BOTH '"' FROM pid::text) = ?
        AND dc.fecha BETWEEN '2026-04-22' AND '2026-05-21'
        AND dc.captured_by_username IN ('maria_rocha','angel_vazquez','enrique_fuentes')
    `, [CANELS_4S_ID]);
    const currentCanels = Number(beforeCount.rows[0].c);
    console.log(`Canels 4s apariciones actuales: ${currentCanels}`);
    console.log(`Target después: ${currentCanels + TARGET} (cap=${PER_PRODUCT_CAP})`);

    if (currentCanels + TARGET > PER_PRODUCT_CAP) {
      console.warn(`⚠ Excedería el cap. Agregando solo ${PER_PRODUCT_CAP - currentCanels}`);
    }
    const toAdd = Math.min(TARGET, PER_PRODUCT_CAP - currentCanels);

    // Buscar capturas con exhibiciones Tira que no tengan Canels 4s
    const captures = await db('daily_captures')
      .whereBetween('fecha', ['2026-04-22', '2026-05-21'])
      .whereIn('captured_by_username', ['maria_rocha', 'angel_vazquez', 'enrique_fuentes'])
      .select('id', 'exhibiciones');

    // Catálogo de candidatos: { captureId, exhibIndex } por cada exhibición Tira sin Canels 4s
    const candidates = [];
    for (const cap of captures) {
      const exh = typeof cap.exhibiciones === 'string' ? JSON.parse(cap.exhibiciones) : cap.exhibiciones;
      if (!Array.isArray(exh)) continue;
      exh.forEach((e, idx) => {
        if (e.conceptoId !== TIRA_CONCEPTO_ID) return;
        const productos = e.productosMarcados || [];
        if (productos.includes(CANELS_4S_ID)) return;
        candidates.push({ captureId: cap.id, exhibIndex: idx, exhibiciones: exh });
      });
    }
    console.log(`Candidatos disponibles (Tira sin Canels 4s): ${candidates.length}`);

    if (candidates.length < toAdd) {
      console.warn(`⚠ Solo hay ${candidates.length} candidatos, agregaré a todos`);
    }

    // Shuffle y tomar los primeros N
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const picked = candidates.slice(0, Math.min(toAdd, candidates.length));

    // Agrupar por capture
    const byCapture = new Map();
    for (const p of picked) {
      if (!byCapture.has(p.captureId)) {
        byCapture.set(p.captureId, { exhibiciones: p.exhibiciones, indices: [] });
      }
      byCapture.get(p.captureId).indices.push(p.exhibIndex);
    }

    console.log(`Aplicando a ${byCapture.size} capturas, ${picked.length} exhibiciones...`);

    await db.transaction(async (trx) => {
      for (const [captureId, { exhibiciones, indices }] of byCapture) {
        const updated = exhibiciones.map((e, idx) => {
          if (!indices.includes(idx)) return e;
          const productos = [...(e.productosMarcados || [])];
          if (!productos.includes(CANELS_4S_ID)) productos.push(CANELS_4S_ID);
          return { ...e, productosMarcados: productos };
        });
        await trx('daily_captures').where({ id: captureId }).update({ exhibiciones: JSON.stringify(updated) });
      }
    });

    // Verificar conteo nuevo
    const afterCount = await db.raw(`
      SELECT COUNT(*) AS c
      FROM daily_captures dc
      CROSS JOIN LATERAL jsonb_array_elements(dc.exhibiciones) AS exh
      CROSS JOIN LATERAL jsonb_array_elements(exh->'productosMarcados') AS pid
      WHERE TRIM(BOTH '"' FROM pid::text) = ?
        AND dc.fecha BETWEEN '2026-04-22' AND '2026-05-21'
        AND dc.captured_by_username IN ('maria_rocha','angel_vazquez','enrique_fuentes')
    `, [CANELS_4S_ID]);
    console.log(`\n✓ Canels 4s apariciones después: ${afterCount.rows[0].c}`);
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
