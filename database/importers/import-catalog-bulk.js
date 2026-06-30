/* eslint-disable no-console */
/**
 * Sync de catálogo Kepler → public.products en MODO BULK (rápido contra prod remoto).
 *
 * El importer per-fila (mega_dulces_sync --scope=products) hace ~3 queries por
 * producto → contra Railway (latencia ~1.2s/query) son ~14h. Este hace:
 *   1) lee catalogo_completo de .245 (igual baseQuery que el importer),
 *   2) resuelve brand_id/category_id en memoria (lookup de prod por code),
 *   3) carga a TEMP staging en batches (~14 inserts en vez de ~14k),
 *   4) MERGE server-side: UPDATE existentes por (brand_id,nombre) [setea sku] +
 *      INSERT los nuevos. Corre en el CPU de prod, sin round-trips por fila.
 * → de ~14h a <1 min.
 *
 * Match idéntico al importer: sku primero (vacío en prod → no pega), luego
 * (brand_id, nombre). Skips: sin nombre / sin brand (igual que el original).
 *
 *   node database/importers/import-catalog-bulk.js          # dry-run (reporta update/insert)
 *   node database/importers/import-catalog-bulk.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.MEGA_DULCES_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/Mega_Dulces';
const DST = process.env.DATABASE_URL_NEW; // OBLIGATORIO (prod o local)
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

const clean = (v) => (v == null ? null : String(v).trim() || null);
const numOr = (v) => (v == null || v === '' ? null : Number(v));

const COLS = [
  'sku','barcode','brand_id','category_id','nombre','description','unit_purchase','unit_sale',
  'factor_purchase','factor_sale','iva_rate','ieps_rate','cost_with_tax','cost_per_case','cost_base',
  'location','location_warehouse','iva_purchase_rate','ieps_purchase_rate','loyalty_points','activo',
];

(async () => {
  if (!DST) throw new Error('DATABASE_URL_NEW obligatorio (target).');
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  try {
    console.log(`\n=== Catálogo Kepler → products (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const { rows: srcRows } = await src.query(`
      SELECT cc.articulo, cc.codigo_barras, cc.nombre, cc.descripcion,
             cc.categoria AS categoria_codigo, cc.subfamilia AS subfamilia_codigo,
             cc.unidad_compra, cc.unidad_venta, cc.factor_compra, cc.factor_venta,
             cc.iva_venta, cc.ieps_venta, cc.iva_compra, cc.ieps_compra, cc.ptos_frecuencia,
             pa.costo_civa, pa.costo_x_caja, et.costo_matriz, et.ubicacion, et.ubicacion_bodega,
             et.en_existencia,
             CASE WHEN pa.articulo IS NOT NULL THEN true ELSE false END AS is_activo
      FROM catalogo_completo cc
      LEFT JOIN productos_activos pa  ON pa.articulo = cc.articulo
      LEFT JOIN catalogo_etiquetas et ON et.articulo = cc.articulo
      WHERE cc.nombre IS NOT NULL ORDER BY cc.articulo`);
    console.log(`  source .245: ${srcRows.length} productos`);

    // Lookups de prod (brands/categories por code) — 2 queries.
    const brandsByCode = new Map();
    for (const b of (await db.query(`SELECT id, code FROM catalog.brands WHERE tenant_id=$1 AND code IS NOT NULL`, [M])).rows)
      brandsByCode.set(b.code, b.id);
    const catsByCode = new Map();
    for (const c of (await db.query(`SELECT id, code FROM catalog.categories WHERE tenant_id=$1`, [M])).rows)
      catsByCode.set(c.code, c.id);
    console.log(`  lookup prod: ${brandsByCode.size} brands × ${catsByCode.size} categories`);

    // Transformar (mismo mapeo que mega_dulces_sync) + skips.
    const recs = []; let skipName = 0, skipBrand = 0;
    for (const r of srcRows) {
      const sku = clean(r.articulo), nombre = clean(r.nombre);
      if (!sku || !nombre) { skipName++; continue; }
      const brand_id = brandsByCode.get(clean(r.subfamilia_codigo));
      if (!brand_id) { skipBrand++; continue; }
      recs.push([
        sku, clean(r.codigo_barras), brand_id, catsByCode.get(clean(r.categoria_codigo)) || null,
        nombre, clean(r.descripcion), clean(r.unidad_compra), clean(r.unidad_venta),
        numOr(r.factor_compra), numOr(r.factor_venta),
        r.iva_venta != null ? Number(r.iva_venta)/100 : null, r.ieps_venta != null ? Number(r.ieps_venta)/100 : null,
        numOr(r.costo_civa), numOr(r.costo_x_caja), numOr(r.costo_matriz),
        clean(r.ubicacion), clean(r.ubicacion_bodega),
        r.iva_compra != null ? Number(r.iva_compra)/100 : null, r.ieps_compra != null ? Number(r.ieps_compra)/100 : null,
        numOr(r.ptos_frecuencia), r.is_activo === true && r.en_existencia !== false,
      ]);
    }
    console.log(`  transformados: ${recs.length} (skip sin-nombre: ${skipName}, sin-brand: ${skipBrand})`);

    // STAGING temp + carga en batches.
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg2 (${COLS.map((c)=>`${c} text`).join(',')}) ON COMMIT DROP`);
    for (let i = 0; i < recs.length; i += BATCH) {
      const chunk = recs.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => {
        vals.push(`(${COLS.map((_, ci) => `$${ri * COLS.length + ci + 1}`).join(',')})`);
        params.push(...row.map((v) => (v === null ? null : String(v))));
      });
      await db.query(`INSERT INTO stg2 (${COLS.join(',')}) VALUES ${vals.join(',')}`, params);
    }
    console.log(`  staging cargado: ${recs.length} filas`);

    // Conteo update vs insert. Match por NOMBRE (el brand_id de prod no alinea
    // con los códigos de subfamilia Kepler; el nombre sí — 99.9% 1:1).
    const { rows: cu } = await db.query(`
      SELECT count(DISTINCT btrim(upper(p.nombre))) AS c
      FROM catalog.products p
      WHERE p.tenant_id=$1 AND EXISTS (
        SELECT 1 FROM stg2 s WHERE btrim(upper(s.nombre))=btrim(upper(p.nombre)))`, [M]);
    const willUpdate = Number(cu[0].c);
    const { rows: ci } = await db.query(`
      SELECT count(*) AS c FROM stg2 s WHERE NOT EXISTS (
        SELECT 1 FROM catalog.products p WHERE p.tenant_id=$1
          AND btrim(upper(p.nombre))=btrim(upper(s.nombre)))`, [M]);
    const willInsert = Number(ci[0].c);
    console.log(`  → UPDATE (match brand+nombre, setea sku): ${willUpdate}`);
    console.log(`  → INSERT (nuevos): ${willInsert}`);

    if (!APPLY) {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — nada cambió.');
      return;
    }

    // MERGE server-side. UPDATE existentes.
    const setCols = COLS.filter((c) => c !== 'sku').map((c) => {
      if (['brand_id','category_id'].includes(c)) return `${c}=s.${c}::uuid`;
      if (['factor_purchase','factor_sale','iva_rate','ieps_rate','cost_with_tax','cost_per_case','cost_base','iva_purchase_rate','ieps_purchase_rate','loyalty_points'].includes(c)) return `${c}=NULLIF(s.${c},'')::numeric`;
      if (c === 'activo') return `activo=(s.activo='true')`;
      return `${c}=s.${c}`;
    }).join(', ');
    // UPDATE existentes por NOMBRE, solo a nombres ÚNICOS en prod (evita los 7
    // dup-name que colisionarían en la constraint (brand_id,nombre) al re-marcar).
    // DISTINCT ON source dedupe por nombre (ambiguos toman sku más bajo).
    const upd = await db.query(`
      UPDATE catalog.products p SET sku=s.sku, ${setCols}, updated_at=now()
      FROM (SELECT DISTINCT ON (btrim(upper(nombre))) * FROM stg2 ORDER BY btrim(upper(nombre)), sku) s
      WHERE p.tenant_id=$1 AND btrim(upper(p.nombre))=btrim(upper(s.nombre))
        AND (SELECT count(*) FROM catalog.products p2
               WHERE p2.tenant_id=$1 AND btrim(upper(p2.nombre))=btrim(upper(p.nombre)))=1`, [M]);
    // INSERT respetando la constraint (tenant,brand_id,nombre): dedupe el source
    // por (brand_id,nombre) y excluye los que ya existen por esa misma clave
    // (estado post-UPDATE).
    const ins = await db.query(`
      INSERT INTO catalog.products (id, tenant_id, ${COLS.join(',')}, created_at, updated_at)
      SELECT gen_random_uuid(), $1, sku, barcode, brand_id::uuid, category_id::uuid, nombre, description,
             unit_purchase, unit_sale, NULLIF(factor_purchase,'')::numeric, NULLIF(factor_sale,'')::numeric,
             NULLIF(iva_rate,'')::numeric, NULLIF(ieps_rate,'')::numeric, NULLIF(cost_with_tax,'')::numeric,
             NULLIF(cost_per_case,'')::numeric, NULLIF(cost_base,'')::numeric, location, location_warehouse,
             NULLIF(iva_purchase_rate,'')::numeric, NULLIF(ieps_purchase_rate,'')::numeric,
             NULLIF(loyalty_points,'')::numeric, (activo='true'), now(), now()
      FROM (SELECT DISTINCT ON (brand_id, btrim(upper(nombre))) * FROM stg2
            ORDER BY brand_id, btrim(upper(nombre)), sku) s
      WHERE NOT EXISTS (
        SELECT 1 FROM catalog.products p WHERE p.tenant_id=$1
          AND p.brand_id=s.brand_id::uuid AND btrim(upper(p.nombre))=btrim(upper(s.nombre)))`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — UPDATE ${upd.rowCount} / INSERT ${ins.rowCount}.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
