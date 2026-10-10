/* eslint-disable no-console */
/**
 * Importer Kepler → catalog.suppliers + products.supplier_id (BULK).
 *
 * FUENTE CORRECTA (fix 2026-07-17): el PROVEEDOR REAL vive en
 *   - `md.kdxd`          = catálogo de proveedores (c2=código, c3=nombre, c10=RFC)
 *   - `md.kdpv_prov_prod` = relación proveedor→producto (c1=código prov, c2=SKU)
 *
 * ANTES (bug): leía `md.kdig` (c1/c2) que es el catálogo de **LÍNEAS** (=marca), y
 * enlazaba por `kdii.c3` (la línea del producto). Como import-brands-lineas.js usa
 * la MISMA kdig, el "proveedor" salía IDÉNTICO a la marca (supplier_id==brand_id en
 * 78% del catálogo). Ej: SKU 24007 (YOHARI) → proveedor real CP033 = "PRODUCTOS
 * TECHANI", pero el catálogo lo ponía en la línea 015 "Dulces Chompys".
 *
 * kdpv_prov_prod es ~1:1 (9,346 SKUs, solo 3 con >1 proveedor → gana el 1º). El
 * proveedor "00001" = "PRODUCTOS SIN PROVEEDOR ASIGNADO" (marcador Kepler; se
 * importa tal cual, es más honesto que dejar un proveedor equivocado).
 *
 * ⭐⭐ FUENTE = EL ODS (fix 2026-10-09). Antes abría una conexión a CADA base de sucursal
 * (`stockMap`, **6**) y unía los catálogos a mano. El ODS ya consolida **9** sucursales, así que
 * esa unión importaba DE MENOS, en silencio y sin fallar.
 *
 * Medido contra prod el 2026-10-09, con el importer corriendo normal (última corrida 03:31 del
 * mismo día, 997 proveedores):
 *
 *   `kepler_ods.kdxd`        784 códigos, los 784 con nombre
 *   `catalog.suppliers`      faltaban 51 de esos
 *   productos sin proveedor  21 que SÍ lo tienen en Kepler
 *
 * El caso que lo destapó: SKU `44430` (PAL TIPITIN CERVECITA / 20 COLOMBINA) salía con la columna
 * Proveedor vacía en `/compras/catalogo`. Su proveedor `CA049` (DISTRIBUIDORA COLOMBINA DE MEXICO)
 * está en **las 9 sucursales** del ODS con nombre válido — y no estaba en `catalog.suppliers`, así
 * que el enlace no tenía a dónde apuntar.
 *
 * ⛔ No es sólo cobertura: seis conexiones de red cruzando subredes pueden fallar una por una, y el
 * código sólo aborta si fallan TODAS (`if (!reached) throw`). Una sucursal caída producía un
 * catálogo de proveedores incompleto que se veía exactamente igual que uno completo. El ODS es UNA
 * consulta local y no tiene esa falla.
 *
 * ⚠️ Lo que NO cambia: un SKU con proveedor distinto entre sucursales sigue resolviéndose por la
 * sucursal más baja (`DISTINCT ON … ORDER BY sku, sucursal`) y se CUENTA para reportarlo. Medido:
 * **37 de 9,682 SKUs** tienen dos proveedores; ninguno tiene tres.
 *
 * ⚠️ `kdxd`/`kdpv_prov_prod` en el ODS SÍ traen columna `sucursal` (en las bases por-sucursal no
 * existía). Por eso el desempate es explícito y no "el primero que aparezca".
 *
 * NO toca products sin entrada en kdpv_prov_prod (conservan su supplier_id actual;
 * se reporta el conteo). NO borra los suppliers viejos huérfanos (quedan con 0
 * productos; su limpieza es decisión aparte).
 *
 *   node database/importers/kepler/import-kepler-suppliers.js          # dry-run
 *   node database/importers/kepler/import-kepler-suppliers.js --apply
 *
 * Env: `DATABASE_URL_NEW` — **y sólo eso**. La fuente (`kepler_ods.*`) vive en la MISMA base que el
 * destino, así que no hay credenciales ni subredes de por medio. Las tres variables de sucursal
 * (`SUPPLIERS_BRANCH_MAP`, `STOCK_BRANCH_MAP`, `SUPPLIERS_BRANCH_URL`) ya **no se leen**.
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

// ⛔ Se retiró el mapa de sucursales (`stockMap` + `SUPPLIERS_BRANCH_MAP`/`STOCK_BRANCH_MAP`/
// `SUPPLIERS_BRANCH_URL`): la fuente es el ODS, que ya tiene las 9 sucursales. Dejarlo declarado
// sin uso haría creer que todavía se puede apuntar el importer a una sucursal suelta, y no.

// Clave normalizada anti-duplicado (espejo de database/scripts/suppliers-normalize.js): quita
// puntuación + sufijos de razón social. Kepler trunca nombres a 30 chars (char(30) en kdxd.c3) y
// repite códigos de proveedor → falsos distintos; esta clave los reagrupa para el aviso post-import.
const LEGAL = new Set(['sa', 's', 'a', 'de', 'cv', 'c', 'v', 'rl', 'r', 'l', 'sc', 'sapi', 'p', 'i', 'sab', 'sofom', 'enr', 'sad', 'dc', 'mx', 'mexico']);
function bkey(s) {
  let x = (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,*'`´¨\-\/&()]/g, ' ').replace(/\s+/g, ' ').trim();
  const w = x.split(' ').filter(Boolean);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

async function stage(db, table, cols, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach((row, ri) => {
      vals.push(`(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`);
      params.push(...row);
    });
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
  }
}

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();

  try {
    console.log(`\n=== Import PROVEEDOR REAL Kepler (kdxd + kdpv_prov_prod del ODS) → suppliers + products.supplier_id (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // El ODS ya consolida las 9 sucursales: una consulta local reemplaza las 6 conexiones.
    // `max(name)` desempata el nombre igual que el `GROUP BY` del upsert de abajo, para que el
    // conteo que se imprime sea el mismo que se escribe.
    const { rows: xd } = await db.query(
      `SELECT btrim(c2) AS code, max(btrim(c3)) AS name
         FROM kepler_ods.kdxd
        WHERE btrim(coalesce(c2,'')) <> '' AND btrim(coalesce(c3,'')) <> ''
        GROUP BY btrim(c2)`);

    // ⚠️ Desempate EXPLÍCITO por sucursal: 37 de 9,682 SKUs traen dos proveedores distintos
    // (medido 2026-10-09; ninguno tres). Gana la sucursal más baja — determinista y reproducible,
    // a diferencia de "el primero que aparezca", que dependía del orden en que respondían las bases.
    const { rows: link } = await db.query(
      `SELECT DISTINCT ON (btrim(c2)) btrim(c2) AS sku, btrim(c1) AS prov_code
         FROM kepler_ods.kdpv_prov_prod
        WHERE NULLIF(btrim(c1),'') IS NOT NULL AND NULLIF(btrim(c2),'') IS NOT NULL
        ORDER BY btrim(c2), sucursal`);

    // El conflicto se CUENTA aparte: perderlo seria dejar de ver que 37 SKUs tienen la respuesta
    // en disputa. No bloquea — es un aviso, como antes.
    const { rows: [cf] } = await db.query(
      `SELECT count(*)::int AS n FROM (
         SELECT btrim(c2) FROM kepler_ods.kdpv_prov_prod
          WHERE NULLIF(btrim(c1),'') IS NOT NULL AND NULLIF(btrim(c2),'') IS NOT NULL
          GROUP BY btrim(c2) HAVING count(DISTINCT btrim(c1)) > 1) d`);
    const conflicts = cf?.n ?? 0;

    // ⛔ El freno que reemplaza al `if (!reached)`: un ODS vacío NO puede pasar por "no hay
    // proveedores". Antes, seis conexiones caidas abortaban; ahora aborta un ODS sin filas.
    if (!xd.length || !link.length) {
      throw new Error(`ODS sin datos de proveedor (kdxd=${xd.length}, kdpv_prov_prod=${link.length}) — abort.`);
    }
    console.log(`  ODS: ${xd.length} proveedores · ${link.length} SKUs enlazados${conflicts ? ` · ⚠ ${conflicts} SKUs con proveedor divergente entre sucursales (gana la sucursal más baja)` : ''}`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_sup (code text, name text) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_link (sku text, prov_code text) ON COMMIT DROP`);
    await stage(db, 'stg_sup', ['code', 'name'], xd.map((g) => [g.code, g.name]));
    await stage(db, 'stg_link', ['sku', 'prov_code'], link.map((l) => [l.sku, l.prov_code]));

    // 1) Upsert proveedores reales
    const up = await db.query(`
      INSERT INTO catalog.suppliers (tenant_id, code, name)
      SELECT $1, s.code, max(s.name) FROM stg_sup s GROUP BY s.code
      ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`, [M]);

    // 2) Re-enlazar products.supplier_id al proveedor REAL (solo cambios).
    //    GUARD deleted_at IS NULL: nunca re-enganchar a un proveedor FUSIONADO (soft-deleted por
    //    suppliers-normalize). Sin esto, un código Kepler de un duplicado ya fusionado volvería a
    //    robar sus productos del canónico y desharía el merge. Los SKUs de códigos retirados
    //    conservan su supplier_id actual (= el canónico al que la fusión ya los apuntó).
    const ln = await db.query(`
      UPDATE catalog.products p
         SET supplier_id = s.id, updated_at = now()
        FROM stg_link l
        JOIN catalog.suppliers s ON s.tenant_id=$1 AND s.code=l.prov_code AND s.deleted_at IS NULL
       WHERE p.tenant_id=$1 AND p.sku=l.sku
         AND p.supplier_id IS DISTINCT FROM s.id`, [M]);

    console.log(`  proveedores upsert: ${up.rowCount} · productos (re)enlazados: ${ln.rowCount}`);

    // Diagnóstico: SKUs del catálogo SIN entrada en kdpv_prov_prod (conservan supplier viejo)
    const { rows: [cov] } = await db.query(`
      SELECT count(*) FILTER (WHERE l.sku IS NULL) sin_link, count(*) total
      FROM catalog.products p LEFT JOIN stg_link l ON l.sku=p.sku
      WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.activo=true AND btrim(coalesce(p.sku,''))<>''`, [M]);
    console.log(`  cobertura: ${cov.total - cov.sin_link}/${cov.total} SKUs con proveedor real · ${cov.sin_link} sin enlace (conservan supplier previo)`);

    // Verificación puntual: los YOHARI que reportó el usuario
    const { rows: chk } = await db.query(`
      SELECT p.sku, s.code, s.name FROM catalog.products p
      LEFT JOIN catalog.suppliers s ON s.id=p.supplier_id
      WHERE p.tenant_id=$1 AND p.sku IN ('24007','30070','30084') ORDER BY p.sku`, [M]);
    console.log('  check YOHARI:');
    chk.forEach((r) => console.log(`    ${r.sku} → ${r.code} "${r.name}"`));

    const { rows: top } = await db.query(
      `SELECT s.code, s.name, count(*) n FROM catalog.products p JOIN catalog.suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
        WHERE p.tenant_id=$1 AND p.deleted_at IS NULL GROUP BY s.code, s.name ORDER BY n DESC LIMIT 10`, [M]);
    console.log('\nTop proveedores por # productos:');
    top.forEach((r) => console.log(`  ${String(r.n).padStart(5)}  ${r.code}  ${r.name}`));

    // Aviso anti-duplicado: Kepler repite códigos + trunca nombres a 30 chars → nacen proveedores
    // "distintos" que son el mismo. Agrupa los ACTIVOS por clave normalizada y avisa si hay que
    // correr la consolidación (el guard de arriba ya evita que el merge previo se deshaga).
    const { rows: activeSup } = await db.query(
      `SELECT name FROM catalog.suppliers WHERE tenant_id=$1 AND deleted_at IS NULL`, [M]);
    const grp = new Map();
    for (const s of activeSup) { const k = bkey(s.name); if (k) grp.set(k, (grp.get(k) || 0) + 1); }
    const dupGroups = [...grp.values()].filter((n) => n > 1).length;
    if (dupGroups > 0) {
      console.log(`\n  ⚠ ${dupGroups} grupo(s) de proveedores DUPLICADOS entre activos (códigos Kepler repetidos / nombres truncados).`);
      console.log(`     → node database/scripts/suppliers-normalize.js --aggressive --execute`);
    } else {
      console.log(`\n  ✓ sin proveedores duplicados entre activos.`);
    }

    if (APPLY) { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
    else { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — usar --apply para aplicar.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
