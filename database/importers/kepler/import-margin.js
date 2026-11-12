/* eslint-disable no-console */
/**
 * KV.4 — Markup % por producto → catalog.products.markup_pct.
 *
 * ⛔ RETIRADO del carril nocturno 2026-11-12 `[CANON.6.8]`. El markup lo mantiene el hop-2 de la
 * ingesta AL LLEGAR el cambio de `kepler_ods.kdpv_prod_util` (`normalizeMarkup` en
 * `services/feeds-ingest/ods-derived.js`, registrado en `ODS_NORMALIZERS.kdpv_prod_util`). Antes este
 * script lo reescribía a las 03:00 y un cambio de Kepler se veía al día siguiente (2–181 por noche).
 *
 * Queda como herramienta MANUAL, con la MISMA fórmula (la importa, no la copia):
 *   node database/importers/kepler/import-margin.js           # sólo lectura: cuántos difieren del ODS
 *                                                              # (debe dar 0 con el hop-2 sano)
 *   node database/importers/kepler/import-margin.js --apply   # recalcula el catálogo completo, sin churn
 *
 * Se quitó `--source=branch` (leer el POS de la sucursal directo): era el respaldo de cuando el ODS no
 * traía `kdpv_prod_util`; desde `[CANON.5.1]` la fuente es el ODS y el POS no se vuelve a leer.
 *
 * La regla, sin cambios: promedio de `c6` sobre los escalones/presentaciones del SKU en la sucursal
 * `MARGIN_BRANCH` (default '03', 8 Esquinas). Lo consumen `import-sales-fact.js`
 * (cost = revenue / (1 + markup/100)) y el reabasto.
 */

const { Client } = require('pg');

const { declararActor } = require('../lib/declare-actor');
const { normalizeMarkup, markupFuenteSql, MARKUP_BRANCH } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  // [VP.3.2] Quien escribe, declarado: el trigger de analytics.master_data_history lo lee
  // solo. Nunca lanza — el actor es metadata, un feed no se cae por no poder firmar.
  await declararActor(db, 'import-margin');
  try {
    console.log(`\n=== Markup % → catalog.products.markup_pct (sucursal '${MARKUP_BRANCH}', ${APPLY ? 'APPLY' : 'SÓLO LECTURA'}) ===\n`);
    const { rows: [c] } = await db.query(
      `SELECT count(p.id)::int AS vivas,
              count(p.id) FILTER (WHERE p.markup_pct IS DISTINCT FROM f.markup)::int AS difieren,
              count(*) FILTER (WHERE p.id IS NULL)::int AS sin_catalogo
         FROM (${markupFuenteSql(false)}) f
         LEFT JOIN catalog.products p ON p.sku = f.sku AND p.tenant_id = $2 AND p.deleted_at IS NULL`,
      [MARKUP_BRANCH, M]);
    console.log(`  productos vivos con fuente: ${c.vivas} · difieren del ODS: ${c.difieren} · SKUs sin catálogo: ${c.sin_catalogo}`);

    if (!APPLY) { console.log('\n[SÓLO LECTURA] nada cambió.'); return; }
    const n = await normalizeMarkup(db, M, null);
    console.log(`\n[APPLY] COMMIT — ${n} productos con markup_pct actualizado.`);
  } catch (e) {
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
