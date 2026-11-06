/* eslint-disable no-console */
/**
 * KV.4 — Markup % por producto → catalog.products.markup_pct, MODO BULK.
 *
 * Fuente: kdpv_prod_util (c1=sku, c3=nivel de volumen, c6=markup% sobre costo) de UNA
 * sucursal (los markups se fijan central, una sucursal es representativa; default '03').
 * markup_pct = promedio de c6 sobre los tiers/presentaciones del SKU. Lo consume
 * import-sales-fact.js (cost=revenue/(1+markup/100)) y Thot.
 *
 * `[CANON.5.1]` (2026-11-05) — la fuente por default es `kepler_ods.kdpv_prod_util` (misma
 * base de prod, sin conexión al POS). Comparación en seco contra lo que este importer escribió
 * leyendo el POS de la '03': 9,009 de 9,057 SKUs vivos idénticos. De la diferencia:
 *   · 35 eran un BUG del camino viejo: mapeaba sku→id con un Map sobre `public.products`, que
 *     trae también las filas BORRADAS; con un SKU repetido (887 en el catálogo) se quedaba con
 *     la borrada y la fila viva nunca recibía markup. Ahora el UPDATE va por sku contra las
 *     filas vivas (`deleted_at IS NULL`).
 *   · 13 (familia 21xxx) no se explicaron al centavo; la réplica lógica de la '03' coincide con
 *     el ODS, consistente con un cambio de precio posterior a las 03:00. NO PROBADO.
 * `--source=branch` conserva el camino viejo (POS de la sucursal) como respaldo.
 *
 *   node database/importers/kepler/import-margin.js                    # dry-run (ODS)
 *   node database/importers/kepler/import-margin.js --apply            # commit
 *   node database/importers/kepler/import-margin.js --source=branch    # POS de la sucursal
 */

const { Client } = require('pg');

const { declararActor } = require('../lib/declare-actor');
const M = '00000000-0000-0000-0000-00000000d01c';
const { branchUrl } = require('../lib/kepler-branches');
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
const BRANCH = process.env.MARGIN_BRANCH || '03'; // 8 Esquinas, markup ref
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

// Markup promedio por SKU (todos los tiers/presentaciones). c6 numérico válido.
const MARKUP_SQL = (tabla, filtro) => `
  SELECT c1 AS sku, round(avg(c6::numeric), 4) AS markup
    FROM ${tabla}
   WHERE c6 IS NOT NULL AND btrim(coalesce(c1,'')) <> '' ${filtro}
   GROUP BY c1`;

async function leerMarkups(db) {
  if (SOURCE === 'ods') {
    return (await db.query(MARKUP_SQL('kepler_ods.kdpv_prod_util', 'AND sucursal = $1'), [BRANCH])).rows;
  }
  if (SOURCE !== 'branch') throw new Error(`--source desconocido: ${SOURCE} (ods | branch)`);
  const src = new Client({ connectionString: process.env.MARGIN_BRANCH_URL || branchUrl(BRANCH) });
  await src.connect();
  try { return (await src.query(MARKUP_SQL('md.kdpv_prod_util', ''))).rows; } finally { await src.end(); }
}

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  // [VP.3.2] Quien escribe, declarado: el trigger de analytics.master_data_history lo lee
  // solo. Nunca lanza — el actor es metadata, un feed no se cae por no poder firmar.
  await declararActor(db, 'import-margin');
  try {
    console.log(`\n=== Markup % → catalog.products.markup_pct (BULK, source=${SOURCE} '${BRANCH}', ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const mk = await leerMarkups(db);
    console.log(`  fuente: ${mk.length} SKUs con markup`);

    // El lote viaja como parámetro JSON (no tabla temporal): así el dry-run corre en una
    // conexión de sólo lectura, donde Postgres no deja crear ni una TEMP TABLE.
    const STG = `json_to_recordset($2::json) AS s(sku text, markup numeric)`;
    const lote = JSON.stringify(mk);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const { rows: [c] } = await db.query(
      `SELECT count(p.id)::int AS vivas,
              count(p.id) FILTER (WHERE p.markup_pct IS DISTINCT FROM s.markup)::int AS cambian,
              count(*) FILTER (WHERE p.id IS NULL)::int AS sin_catalogo,
              round(avg(s.markup) FILTER (WHERE p.id IS NOT NULL), 1) AS promedio
         FROM ${STG}
         LEFT JOIN catalog.products p ON p.sku = s.sku AND p.tenant_id = $1 AND p.deleted_at IS NULL`, [M, lote]);
    console.log(`  filas vivas del catálogo: ${c.vivas} (cambian: ${c.cambian}) · SKUs sin catálogo: ${c.sin_catalogo} · markup promedio: ${c.promedio}%`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] nada cambió.'); return; }

    const up = await db.query(
      `UPDATE catalog.products p SET markup_pct = s.markup, updated_at = now()
         FROM ${STG}
        WHERE p.sku = s.sku AND p.tenant_id = $1 AND p.deleted_at IS NULL`, [M, lote]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} productos con markup_pct (${c.cambian} cambiaron).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
