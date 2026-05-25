/**
 * Recalcula los scores de las capturas de HOY que tienen el bug
 * (stats.puntuacionTotal = 0 porque el backend re-calculó con
 * scoring_pesos incompleto, que ahora ya está poblado).
 *
 * Para cada captura:
 *   1. Por cada exhibición: lookup posicion/concepto/nivel y compute puntos
 *   2. Suma → puntuacionTotal
 *   3. Actualiza stats y exhibición[i].puntuacionCalculada
 *   4. Actualiza score_maximo, score_*_pct, etc.
 *
 * Uso: DATABASE_URL='...' node database/recalc-today-scores.js
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

const SCORE_MAXIMO_POR_EXHIBICION = 200; // Caja(100) × Exhibidor(2) × Alto(1)

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

(async () => {
  try {
    // Cargar catálogos a Map
    const catalogRows = await db('catalogs')
      .whereIn('catalog_id', ['ubicaciones', 'conceptos', 'niveles'])
      .select('id', 'catalog_id', 'value', 'puntuacion');
    const catalogById = new Map(catalogRows.map(r => [r.id, r]));
    const nivelByName = new Map();
    for (const r of catalogRows) {
      if (r.catalog_id === 'niveles') nivelByName.set(r.value.toLowerCase(), r);
    }

    const captures = await db('daily_captures')
      .where('fecha', db.fn.now())  // hoy
      .orWhereRaw("fecha = CURRENT_DATE")
      .select('id', 'folio', 'captured_by_username', 'exhibiciones', 'stats');

    console.log(`Procesando ${captures.length} capturas de hoy...`);
    let totalRecalculated = 0;
    let totalSkipped = 0;

    await db.transaction(async (trx) => {
      for (const cap of captures) {
        const exhibArr = typeof cap.exhibiciones === 'string'
          ? JSON.parse(cap.exhibiciones)
          : cap.exhibiciones;
        const stats = typeof cap.stats === 'string'
          ? JSON.parse(cap.stats)
          : cap.stats;

        if (!Array.isArray(exhibArr) || exhibArr.length === 0) {
          totalSkipped++;
          continue;
        }

        let scoreVisitaTotal = 0;
        let avgNivelSum = 0;
        let numExhValid = 0;

        const updatedExhibs = exhibArr.map((e) => {
          const ubicacion = catalogById.get(e.ubicacionId);
          const concepto = catalogById.get(e.conceptoId);
          let nivel = catalogById.get(e.nivelEjecucionId);
          // Fallback 1: lookup nivel por string si nivelEjecucionId está vacío
          if (!nivel && e.nivelEjecucion) {
            nivel = nivelByName.get(String(e.nivelEjecucion).toLowerCase());
          }
          // Fallback 2: reverse-engineer el nivel desde puntuacionCalculada del front
          if (!nivel && ubicacion && concepto && Number(e.puntuacionCalculada) > 0) {
            const product = Number(ubicacion.puntuacion) * Number(concepto.puntuacion);
            if (product > 0) {
              const nivelValue = Number(e.puntuacionCalculada) / product;
              const allNiveles = Array.from(catalogById.values()).filter(r => r.catalog_id === 'niveles');
              nivel = allNiveles
                .map(r => ({ row: r, dist: Math.abs(Number(r.puntuacion) - nivelValue) }))
                .sort((a, b) => a.dist - b.dist)[0]?.row;
              if (nivel) {
                console.log(
                  `  ℹ ${cap.folio}: nivel inferido = ${nivel.value} (puntuacion=${e.puntuacionCalculada})`,
                );
              }
            }
          }
          // Fallback 3: si nada funcionó, asumir Medio (caso conservador)
          if (!nivel) {
            nivel = nivelByName.get('medio');
            if (nivel) {
              console.log(`  ℹ ${cap.folio}: nivel default = Medio (sin info para inferir)`);
            }
          }

          if (!ubicacion || !concepto || !nivel) {
            console.warn(
              `  ⚠ ${cap.folio}: exhibicion incompleta `,
              { ubicacion: !!ubicacion, concepto: !!concepto, nivel: !!nivel },
            );
            return e;
          }

          const puntos = Number(
            (Number(ubicacion.puntuacion) *
              Number(concepto.puntuacion) *
              Number(nivel.puntuacion)).toFixed(2),
          );
          scoreVisitaTotal += puntos;
          avgNivelSum += Number(nivel.puntuacion);
          numExhValid++;

          return {
            ...e,
            puntuacionCalculada: puntos,
            // Asegurar nivelEjecucionId esté guardado para futuras recalcs
            nivelEjecucionId: nivel.id,
            nivelEjecucion: nivel.value.toLowerCase(),
          };
        });

        if (numExhValid === 0) {
          totalSkipped++;
          continue;
        }

        scoreVisitaTotal = Number(scoreVisitaTotal.toFixed(2));
        const scoreMaximo = Number((SCORE_MAXIMO_POR_EXHIBICION * exhibArr.length).toFixed(2));
        const scoreFinalPct = scoreMaximo > 0
          ? Number(((scoreVisitaTotal / scoreMaximo) * 100).toFixed(2))
          : 0;
        const scoreCalidadPct = Number(((avgNivelSum / numExhValid) * 100).toFixed(2));
        const totalProductosMarcados = exhibArr.reduce(
          (s, e) => s + ((e.productosMarcados || []).length), 0,
        );
        const scoreCoberturaPct = Number(
          (clamp((totalProductosMarcados / exhibArr.length) / 6, 0, 1) * 100).toFixed(2),
        );

        const updatedStats = {
          ...stats,
          puntuacionTotal: scoreVisitaTotal,
        };

        await trx('daily_captures').where({ id: cap.id }).update({
          exhibiciones: JSON.stringify(updatedExhibs),
          stats: JSON.stringify(updatedStats),
          score_maximo: scoreMaximo,
          score_final_pct: scoreFinalPct,
          score_calidad_pct: scoreCalidadPct,
          score_cobertura_pct: scoreCoberturaPct,
        });

        totalRecalculated++;
        console.log(
          `  ✓ ${cap.folio} (${cap.captured_by_username}): puntos=${scoreVisitaTotal} (${scoreFinalPct}%)`,
        );
      }
    });

    console.log(`\n✓ Recalculadas ${totalRecalculated} capturas. Skipped: ${totalSkipped}.`);
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
