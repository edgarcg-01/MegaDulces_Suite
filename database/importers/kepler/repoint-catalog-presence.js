/* eslint-disable no-console */
/**
 * Catálogo — PRESENCIA (altas, reactivaciones y factor de caja vacío) desde `kepler_ods.kdii`.
 *
 * ⛔ RETIRADO del carril nocturno 2026-11-12 `[CANON.6.16]`. Lo hace el hop-2 de la ingesta AL LLEGAR el cambio de
 * `kdii`, con la misma regla:
 *   · ALTA de un SKU sin fila: `normalizeProductsFromOds` (ya lo hacía; el nocturno dio de alta 1 en 30 días);
 *   · REACTIVAR un SKU que sólo tiene filas borradas y Kepler trae vivo (precio real, nombre que no es
 *     «DESCONTINUADO» ni asteriscos): `normalizeProductsFromOds`, paso 0 (el nocturno: 5 en 30 días);
 *   · FACTOR DE CAJA vacío ← el árbitro, sólo con testigo y entero: `normalizeFactorSale` (`[VSO.10]`, ~40 en 30 días).
 *
 * Lo que NINGUNO de los dos puede dar de alta (medido el 12-nov: 4): Kepler tiene dos SKUs con el mismo nombre en la
 * misma marca (99225 y 99204 «ETIQUETA NARANJA 30X49 9000») y el catálogo exige (marca, nombre) único.
 *
 * Queda como herramienta MANUAL, con las MISMAS funciones del hop-2 (las importa, no las copia):
 *   node database/importers/kepler/repoint-catalog-presence.js           # sólo lectura: qué haría
 *   node database/importers/kepler/repoint-catalog-presence.js --apply   # todo el catálogo
 * Se quitó `--source=kp` (KP_CONCENTRADA en el `.245`, que ya no se usa).
 */
const { Client } = require('pg');
const { declararActor } = require('../lib/declare-actor');
const { identitySnapshotSql } = require('../../../services/feeds-ingest/product-identity');
const { normalizeProductsFromOds } = require('../../../services/feeds-ingest/apply-handlers');
const { normalizeFactorSale } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const APPLY = process.argv.includes('--apply');
const VIVA = `k.c90::numeric > 0.05 AND btrim(coalesce(k.c2, '')) <> ''
  AND btrim(k.c2) NOT ILIKE '%DESCONTINUADO%' AND btrim(k.c2) !~ '^[*[:space:]]+$'`;

(async () => {
  const db = new Client({ connectionString: DST, statement_timeout: 300000 });
  await db.connect();
  await declararActor(db, 'repoint-catalog-presence');
  try {
    console.log(`\n=== PRESENCIA de catálogo desde kepler_ods.kdii (${APPLY ? 'APPLY' : 'SÓLO LECTURA'}) ===\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const [c] = (await db.query(`
      WITH i AS (${identitySnapshotSql({})}),
      sinfila AS (SELECT i.* FROM i WHERE NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id = $1 AND p.sku = i.sku AND p.deleted_at IS NULL)),
      marca AS (SELECT s.*, coalesce((SELECT b.id FROM catalog.brands b WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND btrim(b.code) = s.linea LIMIT 1),
                                     (SELECT b.id FROM catalog.brands b WHERE b.tenant_id = $1 AND b.code = 'SIN-LINEA' LIMIT 1)) AS brand_id FROM sinfila s)
      SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id = $1 AND p.sku = m.sku)
                                AND EXISTS (SELECT 1 FROM kepler_ods.kdii k WHERE btrim(k.c1) = m.sku AND ${VIVA}))::int AS reactivar,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id = $1 AND p.sku = m.sku)
                                AND NOT EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id = $1 AND p2.brand_id = m.brand_id AND p2.nombre = m.nombre))::int AS alta,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id = $1 AND p.sku = m.sku)
                                AND EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id = $1 AND p2.brand_id = m.brand_id AND p2.nombre = m.nombre))::int AS frena_la_unique,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id = $1 AND p.sku = m.sku)
                                AND EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id = $1 AND p2.brand_id = m.brand_id AND p2.nombre = m.nombre)
                                AND EXISTS (SELECT 1 FROM kepler_ods.kdii k WHERE btrim(k.c1) = m.sku AND ${VIVA}))::int AS frena_viva
        FROM marca m`, [M])).rows;
    const [f] = (await db.query(`
      SELECT count(*)::int AS factor FROM catalog.products p JOIN analytics.v_product_box_factor b ON b.product_id = p.id AND b.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.factor_sale IS NULL AND b.source <> 'default' AND b.box_factor = round(b.box_factor)`, [M])).rows;
    await db.query('ROLLBACK');
    console.log(`  a REACTIVAR: ${c.reactivar} · ALTA: ${c.alta} · sin alta posible (otro SKU ya tiene ese nombre en la marca): ${c.frena_la_unique}, de ésos vivos en Kepler ${c.frena_viva} (el resto, «* DESCONTINUADO» y similares)`);
    console.log(`  factor de caja vacío que el árbitro sí sabe: ${f.factor}`);
    if (!APPLY) { console.log('\n[SÓLO LECTURA] nada cambió.'); return; }
    const skus = (await db.query(`SELECT sku FROM (${identitySnapshotSql({})}) i`)).rows.map((r) => r.sku);
    const n = await normalizeProductsFromOds(db, M, skus);
    const nf = await normalizeFactorSale(db, M, null);
    console.log(`\n[APPLY] COMMIT — ${n} productos (reactivados, altas o identidad) · ${nf} con factor de caja del árbitro.`
      + ' El costo por caja lo recalcula el siguiente cambio de kdik/kdii (o repoint-catalog-cost).');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  } finally { await db.end().catch(() => {}); }
})();
