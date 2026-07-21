/* eslint-disable no-console */
/**
 * Líneas Kepler (md.kdig) → catalog.brands (solo ALTAS, nunca renombra).
 *
 * En Kepler cada producto pertenece a una "línea" (kdii.c3 → kdig.c1) cuyo
 * nombre es el proveedor/marca. catalog.brands.code = kdig.c1: el seed original
 * quedó incompleto (374 brands vs 543 líneas) y todo producto cuya línea no
 * existe como brand es DESCARTADO por import-catalog-bulk (skip sin-brand)
 * → invisible en salidas/sell-out/todo. Caso detonante: línea 874
 * "JOSE BALTAZAR ZUÑIGA VAZQUEZ" (obleas ZUVA, 12 SKUs).
 *
 * Reglas (la normalización manual de brands es intocable):
 *   - code ya existe            → skip.
 *   - nombre ya existe sin code → adopta el code (backfill).
 *   - nombre ya existe con OTRO code → conflicto, se reporta y skip.
 *   - nombre corresponde a una brand SOFT-DELETED → skip (se borró a propósito en
 *     la dedup; reinsertar la resucitaría y violaría brands_tenant_nombre_unique,
 *     que NO es parcial y cuenta las borradas). Se reporta.
 *   - resto                     → INSERT (nombre UPPERCASE canónico), ON CONFLICT DO NOTHING.
 *
 *   node database/importers/kepler/import-brands-lineas.js          # dry-run
 *   node database/importers/kepler/import-brands-lineas.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00',
      'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01',
      'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02',
      'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03',
      'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04',
      'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05',
    ].map((url) => ({ url }));

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Líneas Kepler (kdig) → catalog.brands (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const byCode = new Map();
    for (const b of MAP) {
      const src = new Client({ connectionString: b.url, connectionTimeoutMillis: 8000 });
      try {
        await src.connect();
        const { rows } = await src.query(
          `SELECT btrim(c1) AS code, btrim(c2) AS nombre FROM md.kdig
            WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c2,'')) <> ''`);
        // \s+ → ' ': kdig trae \r y dobles espacios (btrim de PG solo quita espacios)
        for (const r of rows) if (!byCode.has(r.code)) byCode.set(r.code, r.nombre.replace(/\s+/g, ' ').trim().toUpperCase());
        console.log(`  ${b.url.split('@')[1]}: ${rows.length} líneas`);
      } catch (e) {
        console.log(`  ⚠ ${b.url.split('@')[1]} no disponible: ${e.message}`);
      } finally { await src.end().catch(() => {}); }
    }
    console.log(`  total dedup: ${byCode.size} líneas\n`);

    const existing = await db.query(
      `SELECT code, btrim(upper(nombre)) AS nombre FROM catalog.brands WHERE tenant_id=$1 AND deleted_at IS NULL`, [M]);
    const haveCode = new Set(existing.rows.map((r) => r.code).filter(Boolean));
    const codeByName = new Map(existing.rows.map((r) => [r.nombre, r.code]));
    // Nombres de brands SOFT-DELETED: brands_tenant_nombre_unique NO es parcial → cuenta
    // las borradas. Reinsertar un nombre borrado viola la constraint (tumbaba el nightly).
    const deletedRows = await db.query(
      `SELECT btrim(upper(nombre)) AS nombre FROM catalog.brands WHERE tenant_id=$1 AND deleted_at IS NOT NULL`, [M]);
    const deletedNames = new Set(deletedRows.rows.map((r) => r.nombre));

    const inserts = [], adopts = [], conflicts = [], skippedDeleted = [];
    const seenName = new Map(); // dedup por nombre TAMBIÉN entre las nuevas (unique tenant+nombre)
    for (const [code, nombre] of byCode) {
      if (haveCode.has(code)) continue;
      if (codeByName.has(nombre)) {
        const other = codeByName.get(nombre);
        if (other == null) adopts.push([code, nombre]);
        else conflicts.push({ code, nombre, existing_code: other });
        continue;
      }
      if (deletedNames.has(nombre)) { skippedDeleted.push([code, nombre]); continue; }
      if (seenName.has(nombre)) { conflicts.push({ code, nombre, existing_code: `${seenName.get(nombre)} (nueva)` }); continue; }
      seenName.set(nombre, code);
      inserts.push([code, nombre]);
    }
    console.log(`  → INSERT nuevas: ${inserts.length}`);
    console.log(`  → adoptar code (nombre ya existe sin code): ${adopts.length}`);
    if (skippedDeleted.length) { console.log(`  → skip (nombre = brand borrada en dedup): ${skippedDeleted.length}`); console.table(skippedDeleted.slice(0, 10).map(([code, nombre]) => ({ code, nombre }))); }
    if (conflicts.length) { console.log(`  → conflictos nombre-con-otro-code (skip): ${conflicts.length}`); console.table(conflicts.slice(0, 10)); }
    if (inserts.length) console.table(inserts.slice(0, 15).map(([code, nombre]) => ({ code, nombre })));

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    for (const [code, nombre] of adopts) {
      await db.query(
        `UPDATE catalog.brands SET code=$2, updated_at=now()
          WHERE tenant_id=$1 AND code IS NULL AND btrim(upper(nombre))=$3`, [M, code, nombre]);
    }
    for (let i = 0; i < inserts.length; i += 500) {
      const chunk = inserts.slice(i, i + 500);
      const vals = chunk.map((_, ri) => `($${ri * 2 + 1}, $${ri * 2 + 2}, '${M}', now(), now())`);
      const params = []; chunk.forEach(([code, nombre]) => params.push(code, nombre));
      await db.query(
        `INSERT INTO catalog.brands (code, nombre, tenant_id, created_at, updated_at) VALUES ${vals.join(',')}
           ON CONFLICT (tenant_id, nombre) DO NOTHING`, params);
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${inserts.length} brands nuevas + ${adopts.length} codes adoptados.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
