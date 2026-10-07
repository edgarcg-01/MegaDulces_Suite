/**
 * Mueve TODAS las apariciones de Canels 4s (id c1322126) que están en
 * exhibiciones con concepto=Tira a exhibiciones con concepto=Exhibidor/Vitrina.
 *
 * En abarrote real, Canels 4s va en Exhibidor (display de chicles), no en Tira.
 *
 * Uso: DATABASE_URL='...' node database/move-canels-from-tira.js
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

const CANELS_4S_ID  = 'c1322126-41e9-4d9e-9b58-c6663a83ad07';
const CONCEPTO_TIRA       = 'f1e1033c-0c5c-4f9a-94f8-d43076bb267f';
const CONCEPTO_EXHIBIDOR  = 'ce560e85-39a1-4b5b-8fb5-a6bfb7098ba3';
const CONCEPTO_VITRINA    = '72458c36-2af7-474d-828e-9b925b23c9e9';

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

(async () => {
  try {
    // Cargar todas las capturas del seed
    const captures = await db('daily_captures')
      .whereBetween('fecha', ['2026-04-22', '2026-05-21'])
      .whereIn('captured_by_username', ['maria_rocha', 'angel_vazquez', 'enrique_fuentes'])
      .select('id', 'exhibiciones');

    // Catalogar exhibiciones por categoría
    const tiraConCanels = [];       // a remover
    const exhibidorSinCanels = [];  // a agregar
    const vitrinaSinCanels = [];    // a agregar

    // Map: captureId → array de exhibiciones (cached para edits)
    const captureExhs = new Map();
    for (const cap of captures) {
      const exh = typeof cap.exhibiciones === 'string' ? JSON.parse(cap.exhibiciones) : cap.exhibiciones;
      if (!Array.isArray(exh)) continue;
      captureExhs.set(cap.id, exh);
      exh.forEach((e, idx) => {
        const tieneCanels = (e.productosMarcados || []).includes(CANELS_4S_ID);
        if (e.conceptoId === CONCEPTO_TIRA && tieneCanels) {
          tiraConCanels.push({ captureId: cap.id, idx });
        } else if (e.conceptoId === CONCEPTO_EXHIBIDOR && !tieneCanels) {
          exhibidorSinCanels.push({ captureId: cap.id, idx });
        } else if (e.conceptoId === CONCEPTO_VITRINA && !tieneCanels) {
          vitrinaSinCanels.push({ captureId: cap.id, idx });
        }
      });
    }

    console.log(`Tira con Canels 4s (a remover):   ${tiraConCanels.length}`);
    console.log(`Exhibidor sin Canels 4s (slots):  ${exhibidorSinCanels.length}`);
    console.log(`Vitrina sin Canels 4s (slots):    ${vitrinaSinCanels.length}`);

    const toMove = tiraConCanels.length;
    const totalSlots = exhibidorSinCanels.length + vitrinaSinCanels.length;
    if (totalSlots < toMove) {
      console.warn(`⚠ Slots insuficientes: ${totalSlots} disponibles vs ${toMove} a mover`);
    }

    // Distribución 70/30 Exhibidor/Vitrina (con fallback si una se llena)
    shuffle(exhibidorSinCanels);
    shuffle(vitrinaSinCanels);
    const addTargets = [];
    let exhIdx = 0, vitIdx = 0;
    for (let i = 0; i < toMove; i++) {
      const preferExh = Math.random() < 0.70 && exhIdx < exhibidorSinCanels.length;
      if (preferExh) {
        addTargets.push(exhibidorSinCanels[exhIdx++]);
      } else if (vitIdx < vitrinaSinCanels.length) {
        addTargets.push(vitrinaSinCanels[vitIdx++]);
      } else if (exhIdx < exhibidorSinCanels.length) {
        addTargets.push(exhibidorSinCanels[exhIdx++]);
      } else {
        console.warn(`⚠ Sin más slots en la iteración ${i}`);
        break;
      }
    }

    console.log(`\nMovimientos: ${tiraConCanels.length} remove + ${addTargets.length} add`);

    // Aplicar: remover de Tira + agregar a destinos
    await db.transaction(async (trx) => {
      // Marcar exhibiciones modificadas por captureId
      const modified = new Set();

      for (const { captureId, idx } of tiraConCanels) {
        const exh = captureExhs.get(captureId);
        const e = exh[idx];
        e.productosMarcados = (e.productosMarcados || []).filter((pid) => pid !== CANELS_4S_ID);
        modified.add(captureId);
      }
      for (const { captureId, idx } of addTargets) {
        const exh = captureExhs.get(captureId);
        const e = exh[idx];
        const productos = e.productosMarcados || [];
        if (!productos.includes(CANELS_4S_ID)) {
          e.productosMarcados = [...productos, CANELS_4S_ID];
        }
        modified.add(captureId);
      }

      console.log(`Aplicando a ${modified.size} capturas...`);
      for (const captureId of modified) {
        await trx('daily_captures')
          .where({ id: captureId })
          .update({ exhibiciones: JSON.stringify(captureExhs.get(captureId)) });
      }
    });

    // Verificación
    const distrib = await db.raw(`
      SELECT c_concepto.value AS concepto, COUNT(*) AS apariciones
      FROM daily_captures dc
      CROSS JOIN LATERAL jsonb_array_elements(dc.exhibiciones) AS exh
      CROSS JOIN LATERAL jsonb_array_elements(exh->'productosMarcados') AS pid
      JOIN catalogs c_concepto ON c_concepto.id::text = (exh->>'conceptoId')
      WHERE TRIM(BOTH '"' FROM pid::text) = ?
        AND dc.fecha BETWEEN '2026-04-22' AND '2026-05-21'
        AND dc.captured_by_username IN ('maria_rocha','angel_vazquez','enrique_fuentes')
      GROUP BY c_concepto.value
      ORDER BY apariciones DESC
    `, [CANELS_4S_ID]);
    console.log('\n✓ Distribución final de Canels 4s por concepto:');
    for (const row of distrib.rows) {
      console.log(`  ${row.concepto}: ${row.apariciones}`);
    }
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
