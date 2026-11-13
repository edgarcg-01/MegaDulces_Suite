/* eslint-disable no-console */
/**
 * Líneas Kepler (kepler_ods.kdig) → catalog.brands (solo ALTAS, nunca renombra).
 *
 * ⛔ RETIRADO del carril `catalog` (sábados 02:00) 2026-11-12 `[CANON.6.12]`. Lo hace el hop-2 de la ingesta AL
 * LLEGAR la línea (`normalizeBrandsFromKdig` en `services/feeds-ingest/apply-handlers.js`, registrado para
 * `kdig`), con estas mismas reglas. Y además mueve a la marca nueva los productos que habían entrado a
 * SIN-LINEA, cosa que este script nunca hizo: medido en prod el 12-nov, 31 productos vivos seguían en
 * SIN-LINEA con la marca de su línea ya creada (KURUMAYA 5, COLOMBINA 4, PERFETTI 4, GALFRA 4…).
 *
 * En Kepler cada producto pertenece a una "línea" (kdii.c3 → kdig.c1) cuyo nombre es el proveedor/marca.
 * catalog.brands.code = kdig.c1. Caso que lo originó: línea 874 "JOSE BALTAZAR ZUÑIGA VAZQUEZ" (obleas ZUVA).
 *
 * Reglas (la normalización manual de brands es intocable) — viven en `normalizeBrandsFromKdig`:
 *   - code ya existe            → skip.
 *   - nombre ya existe sin code → adopta el code (backfill).
 *   - nombre ya existe con OTRO code → conflicto, skip.
 *   - nombre corresponde a una brand SOFT-DELETED → skip (la unique de nombre cuenta las borradas).
 *   - resto                     → INSERT (nombre UPPERCASE canónico).
 *
 * Queda como herramienta MANUAL, con la MISMA función del hop-2 (la importa, no la copia):
 *   node database/importers/kepler/import-brands-lineas.js          # sólo lectura: qué haría
 *   node database/importers/kepler/import-brands-lineas.js --apply  # todas las líneas + productos en SIN-LINEA
 */

const { Client } = require('pg');
const { declararActor } = require('../lib/declare-actor');
const { normalizeBrandsFromKdig } = require('../../../services/feeds-ingest/apply-handlers');
const { identitySnapshotSql } = require('../../../services/feeds-ingest/product-identity');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  await declararActor(db, 'import-brands-lineas');
  try {
    console.log(`\n=== Líneas Kepler (kdig) → catalog.brands (${APPLY ? 'APPLY' : 'SÓLO LECTURA'}) ===\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const lineas = (await db.query(`
      WITH k AS (
        SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS code, upper(btrim(regexp_replace(c2, '\\s+', ' ', 'g'))) AS nombre,
               btrim(sucursal) AS suc
          FROM kepler_ods.kdig
         WHERE btrim(coalesce(c1, '')) <> '' AND btrim(coalesce(c2, '')) <> ''
         ORDER BY btrim(c1), btrim(sucursal))
      SELECT k.code, k.nombre,
             CASE WHEN EXISTS (SELECT 1 FROM catalog.brands b WHERE b.tenant_id=$1 AND b.deleted_at IS NULL AND btrim(upper(b.nombre))=k.nombre AND b.code IS NULL) THEN 'adoptar'
                  WHEN EXISTS (SELECT 1 FROM catalog.brands b WHERE b.tenant_id=$1 AND b.deleted_at IS NULL AND btrim(upper(b.nombre))=k.nombre) THEN 'conflicto'
                  WHEN EXISTS (SELECT 1 FROM catalog.brands b WHERE b.tenant_id=$1 AND btrim(upper(b.nombre))=k.nombre) THEN 'borrada'
                  ELSE 'alta' END AS accion
        FROM k
       WHERE NOT EXISTS (SELECT 1 FROM catalog.brands b WHERE b.tenant_id=$1 AND b.deleted_at IS NULL AND btrim(b.code)=k.code)
       ORDER BY 3, 1`, [M])).rows;
    const atorados = (await db.query(`
      WITH sl AS (SELECT p.sku FROM catalog.products p JOIN catalog.brands b ON b.id=p.brand_id AND b.code='SIN-LINEA'
                   WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku IS NOT NULL)
      SELECT i.linea, count(*)::int AS productos
        FROM (${identitySnapshotSql({ skuParam: '$2' })}) i
        JOIN catalog.brands b ON b.tenant_id=$1 AND b.deleted_at IS NULL AND btrim(b.code)=i.linea AND b.code<>'SIN-LINEA'
       GROUP BY 1 ORDER BY 2 DESC`,
      [M, (await db.query(`SELECT p.sku FROM catalog.products p JOIN catalog.brands b ON b.id=p.brand_id AND b.code='SIN-LINEA'
                             WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku IS NOT NULL`, [M])).rows.map((r) => r.sku)])).rows;
    await db.query('ROLLBACK');
    const por = (a) => lineas.filter((l) => l.accion === a);
    // Dos códigos nuevos con el mismo nombre: sólo uno se da de alta (el otro queda en conflicto después).
    console.log(`  líneas sin marca por código: ${lineas.length} — alta ${por('alta').length} · adoptar código ${por('adoptar').length}`
      + ` · conflicto (el nombre ya es de otra marca con código) ${por('conflicto').length} · nombre de marca borrada ${por('borrada').length}`);
    if (por('alta').length + por('adoptar').length) console.table(lineas.filter((l) => l.accion === 'alta' || l.accion === 'adoptar').slice(0, 20));
    console.log(`  productos vivos en SIN-LINEA cuya línea ya es marca: ${atorados.reduce((s, r) => s + r.productos, 0)}`
      + (atorados.length ? ` (${atorados.map((r) => `${r.linea}×${r.productos}`).join(' ')})` : ''));

    if (!APPLY) { console.log('\n[SÓLO LECTURA] nada cambió.'); return; }
    const n = await normalizeBrandsFromKdig(db, M, null);
    console.log(`\n[APPLY] COMMIT — ${n} (marcas dadas de alta + códigos adoptados + productos movidos de SIN-LINEA).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  } finally { await db.end().catch(() => {}); }
})();
