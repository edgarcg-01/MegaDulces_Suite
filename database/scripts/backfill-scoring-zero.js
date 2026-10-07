/**
 * Backfill de capturas con `stats.puntuacionTotal = 0` indebido.
 *
 * Causa (bug scoring-0): el backend recalculaba el total leyendo de
 * `scoring_weights` (por nombre). Si faltaba la fila de un valor de catálogo,
 * el factor resolvía a 0 y el total de la visita quedaba en 0 — aunque el
 * score por-exhibición (`exhibiciones[i].puntuacionCalculada`, calculado por
 * el front desde `catalogs.puntuacion`) sí era correcto.
 *
 * Este script recomputa el total y lo persiste:
 *   1. Prefiere la suma de `exhibiciones[i].puntuacionCalculada` (ya correcta).
 *   2. Si esos están en 0/ausentes, recomputa desde `catalogs.puntuacion`
 *      (ubic × concepto × min(nivel, 1), nivel→1 si falta).
 *
 * Idempotente: solo toca filas donde el total guardado difiere del recomputado.
 * Dry-run por DEFAULT. Para escribir: pasar --apply.
 *
 * Uso:
 *   DATABASE_URL='postgres://...' node database/scripts/backfill-scoring-zero.js          # dry-run
 *   DATABASE_URL='postgres://...' node database/scripts/backfill-scoring-zero.js --apply  # escribe
 */
const path = require('path');
const knex = require(path.join(__dirname, '..', '..', 'node_modules', 'knex'));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: falta DATABASE_URL');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');

const db = knex({
  client: 'pg',
  connection: {
    connectionString: DATABASE_URL,
    ssl: /railway|rlwy|proxy|amazonaws/i.test(DATABASE_URL)
      ? { rejectUnauthorized: false }
      : false,
  },
  pool: { min: 0, max: 4 },
});

const round2 = (n) => Number(Number(n).toFixed(2));

(async () => {
  try {
    // Catálogos a Map (id -> {catalog_id, value, puntuacion})
    const catalogRows = await db('catalogs')
      .whereIn('catalog_id', ['ubicaciones', 'conceptos', 'niveles'])
      .select('id', 'catalog_id', 'value', 'puntuacion');
    const catById = new Map(catalogRows.map((r) => [r.id, r]));
    const nivelByName = new Map();
    for (const r of catalogRows) {
      if (r.catalog_id === 'niveles') nivelByName.set(String(r.value).toLowerCase(), r);
    }

    // Solo capturas con total 0/null — el universo del bug.
    const caps = await db('daily_captures')
      .whereRaw("(stats->>'puntuacionTotal') IS NULL OR (stats->>'puntuacionTotal')::numeric = 0")
      .select('id', 'folio', 'captured_by_username', 'exhibiciones', 'stats', 'score_maximo');

    console.log(`Modo: ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'}`);
    console.log(`Capturas con total 0/null: ${caps.length}\n`);

    let toFix = 0;
    let skipped = 0;

    await db.transaction(async (trx) => {
      for (const cap of caps) {
        const exhib = typeof cap.exhibiciones === 'string'
          ? JSON.parse(cap.exhibiciones)
          : cap.exhibiciones;
        const stats = typeof cap.stats === 'string' ? JSON.parse(cap.stats) : cap.stats;

        if (!Array.isArray(exhib) || exhib.length === 0) {
          skipped++;
          continue;
        }

        // 1. Suma de puntuacionCalculada ya guardada (la confiable).
        let total = exhib.reduce((s, e) => s + (Number(e.puntuacionCalculada) || 0), 0);

        // 2. Si quedó en 0, recomputar desde catálogo.
        if (total === 0) {
          total = exhib.reduce((s, e) => {
            const ubic = catById.get(e.ubicacionId);
            const concepto = catById.get(e.conceptoId);
            let nivel = catById.get(e.nivelEjecucionId);
            if (!nivel && e.nivelEjecucion) nivel = nivelByName.get(String(e.nivelEjecucion).toLowerCase());
            const pUbic = Number(ubic?.puntuacion) || 0;
            const pConcepto = Number(concepto?.puntuacion) || 0;
            const pNivel = nivel ? Math.min(Number(nivel.puntuacion) || 0, 1) : 1;
            return s + pUbic * pConcepto * pNivel;
          }, 0);
        }

        total = round2(total);
        const current = Number(stats?.puntuacionTotal) || 0;

        if (total === current) {
          skipped++;
          continue;
        }

        toFix++;
        const scoreMaximo = Number(cap.score_maximo) || 0;
        const scoreFinalPct = scoreMaximo > 0 ? round2((total / scoreMaximo) * 100) : null;

        console.log(
          `  ${APPLY ? 'FIX' : 'WOULD-FIX'} ${cap.folio} (${cap.captured_by_username}): ${current} → ${total}` +
            (scoreFinalPct != null ? ` (${scoreFinalPct}%)` : ''),
        );

        if (APPLY) {
          const newStats = { ...stats, puntuacionTotal: total };
          const update = { stats: JSON.stringify(newStats) };
          if (scoreFinalPct != null) update.score_final_pct = scoreFinalPct;
          await trx('daily_captures').where({ id: cap.id }).update(update);
        }
      }

      if (!APPLY) {
        // Dry-run: no persistir nada.
        await trx.rollback(new Error('__dry_run__'));
      }
    }).catch((e) => {
      if (e && e.message === '__dry_run__') return; // rollback intencional
      throw e;
    });

    console.log(`\n${APPLY ? 'Corregidas' : 'A corregir'}: ${toFix}. Sin cambio: ${skipped}.`);
    if (!APPLY && toFix > 0) {
      console.log('Re-ejecutá con --apply para persistir.');
    }
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
