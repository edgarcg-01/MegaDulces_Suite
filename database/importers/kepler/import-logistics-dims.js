/* eslint-disable no-console */
/**
 * EMB.2 (antes KV.8) — Dimensiones de logística de Kepler → `logistics.*`, IDEMPOTENTE y sin wipe.
 *
 * ⛔ RETIRADO del carril nocturno 2026-11-13 `[CANON.6.18]`. Lo mantiene el hop-2 de la ingesta AL LLEGAR un cambio
 * de `kdm_transporte` / `kdm_chofer` / `kdm_rutas` (`normalizeVehiclesFromOds` / `normalizeDriversFromOds` /
 * `normalizeRoutesFromOds`), con la MISMA regla: vive en `services/feeds-ingest/logistics-dims.js` y esta herramienta
 * la llama sobre el catálogo entero. Medido antes de retirarlo: 21 noches seguidas en error (12-oct → 5-nov, H1 del
 * anexo CANON.5) y 8 noches sin nada que hacer desde el arreglo; en toda su vida, 17 rutas dadas de alta y ninguna
 * unidad ni chofer (ésas sólo las adopta). El árbitro `logistica_dims_evento` de db-health vigila lo que el evento no vea.
 *
 * Queda como herramienta MANUAL:
 *   node database/importers/kepler/import-logistics-dims.js          # en seco (ROLLBACK): qué daría de alta o adoptaría
 *   node database/importers/kepler/import-logistics-dims.js --apply  # commit
 * ⚠️ El modo en seco escribe dentro de una transacción que revierte: necesita un rol con INSERT en `logistics.*`
 * (el de `feeds-cron`), no el de sólo lectura.
 *
 * Historia de la regla (2026-09-17): lee el ODS en la misma base (antes una réplica de sucursal), upsertea por la clave
 * de Kepler (`kepler_code`) y lee los catálogos por los resolvedores `analytics.v_kepler_transporte` / `v_kepler_chofer`,
 * que colapsan las altas duplicadas (`00018` y `018`). Las RUTAS no llevan clave a propósito (ver el módulo).
 */

const { Client } = require('pg');
const { declararActor } = require('../lib/declare-actor');
const { sincronizarUnidades, sincronizarChoferes, sincronizarRutas } = require('../../../services/feeds-ingest/logistics-dims');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

const reportar = (r) => {
  console.log(`  ${r.tabla}: +${r.insertados} nuevas · ${r.adoptados} adoptadas · ${r.actualizados} al día (${r.enKepler} en Kepler)`);
  if (r.respetadas.length) console.log(`  ⓘ ${r.tabla}: ${r.respetadas.length} no se dan de alta (borradas en la app u ocupadas): ${r.respetadas.join(' · ')}`);
};

async function main() {
  const db = new Client({ connectionString: DST });
  await db.connect();
  await declararActor(db, 'import-logistics-dims');
  try {
    const [{ db: dbname }] = (await db.query('SELECT current_database() AS db')).rows;
    console.log(`\n=== Dims logística Kepler → logistics.* · ${dbname} · ${APPLY ? 'APPLY' : 'EN SECO'} ===\n`);
    const reg = await db.query(`SELECT to_regclass('analytics.v_kepler_transporte') AS t`);
    if (!reg.rows[0].t) throw new Error('falta analytics.v_kepler_transporte (migración 20260917120000 sin aplicar)');

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    reportar(await sincronizarUnidades(db, M, null));
    const ch = await sincronizarChoferes(db, M, null);
    reportar(ch);
    if (ch.ambiguos) console.log(`  ⚠ ${ch.ambiguos} claves de chofer son ambiguas en el catálogo de Kepler (el nombre difiere entre ramas) — se tomó la forma canónica; ver analytics.v_kepler_chofer.ambiguo`);

    // Lo que NO se da de alta, DECLARADO (ADR-056): Kepler tiene a la misma persona dos veces con nombres distintos
    // («ENRIQUE FUENTES» vs «ENRIQUE FUENTES MONTES») bajo una clave corta local a la sucursal. Se dedupea por clave
    // canónica (si no, serían personas duplicadas); el alta de quien SÓLO existe bajo la clave corta la decide un humano.
    const huerfanos = (await db.query(`
      SELECT DISTINCT upper(btrim(k.c2)) AS nombre,
             string_agg(DISTINCT btrim(k.sucursal)||':'||btrim(k.c1), ' ') AS claves
        FROM kepler_ods.kdm_chofer k
       WHERE btrim(coalesce(k.c2,'')) <> ''
         AND NOT EXISTS (SELECT 1 FROM logistics.drivers d
                          WHERE d.tenant_id=$1 AND d.deleted_at IS NULL
                            AND upper(btrim(d.full_name)) = upper(btrim(k.c2)))
       GROUP BY 1 ORDER BY 1`, [M])).rows;
    if (huerfanos.length) {
      console.log(`  ⓘ ${huerfanos.length} nombres de chofer del ODS sin fila propia en logistics.drivers (casi todos son la MISMA persona con el nombre abreviado):`);
      for (const h of huerfanos) console.log(`      · ${h.nombre}  [${h.claves}]`);
    }
    reportar(await sincronizarRutas(db, M, null));

    if (APPLY) { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
    else { await db.query('ROLLBACK'); console.log('\n[EN SECO] ROLLBACK — nada cambió.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

if (require.main === module) main();
module.exports = { main };
