/* eslint-disable no-console */
/**
 * Líneas Kepler (kepler_ods.kdig) → catalog.brands (solo ALTAS, nunca renombra).
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
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Líneas Kepler (kdig) → catalog.brands (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // `[OPS.LIMPIEZA.4]` **DEL ODS, no de las sucursales.** Antes abría una conexión por sucursal
    // con `stockMap()`, que da el POS REMOTO de cada una (no la réplica local): siete viajes por la
    // red de las plazas, y una sucursal caída se saltaba con un `⚠` que nadie leía. Viola la regla
    // principal (todo del ODS, de una tabla). `kepler_ods.kdig` ya trae las 9 con `sucursal`.
    //
    // ⭐ La PRECEDENCIA se conserva: antes ganaba la primera sucursal del mapa (00 → 08) que traía
    // el código; acá, `ORDER BY sucursal` y la misma regla «primera gana». Medido en prod el
    // 2026-10-19: 549 códigos y UNO solo con nombre distinto entre sucursales (`002`: KI´SNACKS
    // en 00–05, MONDELEZ en 01/06/07/08) — gana la 00 antes y después.
    const { rows } = await db.query(
      `SELECT sucursal, btrim(c1) AS code, btrim(c2) AS nombre FROM kepler_ods.kdig
        WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c2,'')) <> ''
        ORDER BY sucursal, c1`);
    // Una fuente vacía no es «no hay líneas nuevas»: es que la lectura falló. Se DECLARA.
    if (!rows.length) throw new Error('kepler_ods.kdig devolvió 0 líneas — fuente vacía, no se decide nada');
    const byCode = new Map();
    const porSucursal = new Map();
    for (const r of rows) {
      porSucursal.set(r.sucursal, (porSucursal.get(r.sucursal) || 0) + 1);
      // \s+ → ' ': kdig trae \r y dobles espacios (btrim de PG solo quita espacios)
      if (!byCode.has(r.code)) byCode.set(r.code, r.nombre.replace(/\s+/g, ' ').trim().toUpperCase());
    }
    console.log(`  kepler_ods.kdig: ${[...porSucursal].map(([s, n]) => `${s}=${n}`).join(' · ')}`);
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
