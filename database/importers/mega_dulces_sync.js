#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Importer Mega_Dulces → postgres_platform.
 *
 * Lee desde la DB ERP real de Mega Dulces (`Mega_Dulces` en 192.168.0.245) y
 * upserta a la DB multi-tenant (`postgres_platform`). Idempotente: re-correrlo
 * es seguro y solo aplica diffs.
 *
 * Mapeo (resumen — ver análisis completo en doc):
 *   - `catalogo_completo`     → `public.products`
 *   - `productos_activos`     → flag de activo + stock pivot
 *   - `catalogo_etiquetas`    → `commercial.product_prices` (5 niveles: MAYOREO, P1..P4)
 *   - `categorias`            → `public.categories` (tipo de producto)
 *   - `subfamilias`           → `public.brands` (proveedor/fabricante)
 *   - `productos_activos.alm{10,30,40,42,44,50,54}_existencia_g` + `ex_cedis`
 *                             → `commercial.stock` (1 row por warehouse × product)
 *
 * NO importa:
 *   - `ventas` (2.1M filas) → FDW read-only en Sprint M.3
 *   - `familias` (98% redundante con subfamilias) → se ignora
 *   - `vendedores`, `archivos_procesados` → fuera de scope
 *
 * Conexión target: DATABASE_URL_NEW (postgres superuser) para evitar fricción
 * con RLS durante bulk inserts. Igualmente setea `app.tenant_id` por seguridad
 * (WITH CHECK no falla).
 *
 * Uso:
 *   node database/importers/mega_dulces_sync.js --tenant-slug=mega_dulces [--dry-run] [--scope=all] [--limit=N]
 *
 * Scopes (orden de dependencia):
 *   all (default) | categories | brands | warehouses | price-lists | products | prices | stock
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

// ───────────────────────── arg parsing ─────────────────────────

function parseArgs(argv) {
  const args = { scope: 'all' };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--')) {
      const [k, v] = raw.slice(2).split('=');
      args[k.replace(/-/g, '_')] = v ?? true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node mega_dulces_sync.js --tenant-slug=<slug> [--dry-run] [--scope=<scope>] [--limit=N]

Scopes (ejecutados en orden por dependencia FK):
  all          (default) corre todo en orden
  categories   tipos de producto (categorias en Mega_Dulces)
  brands       proveedores/fabricantes (subfamilias en Mega_Dulces)
  warehouses   8 almacenes (MD-CEDIS + MD-10/30/40/42/44/50/54)
  price-lists  crea las 5 listas si no existen (MAYOREO, P1, P2, P3, P4)
  products     catalogo_completo + flag activo de productos_activos
  prices       catalogo_etiquetas.p_1..p_4 + precio_mayoreo → product_prices
  stock        productos_activos.alm{X}_existencia_g + ex_cedis → commercial.stock

Examples:
  # Dry-run completo
  node mega_dulces_sync.js --tenant-slug=mega_dulces --dry-run

  # Solo refrescar precios
  node mega_dulces_sync.js --tenant-slug=mega_dulces --scope=prices

  # Smoke test (10 productos)
  node mega_dulces_sync.js --tenant-slug=mega_dulces --limit=10 --dry-run
`);
}

// ───────────────────────── connections ─────────────────────────

function buildSourceKnex() {
  // DB ERP real de Mega Dulces en .245
  return knexLib({
    client: 'pg',
    connection: {
      host: '192.168.0.245',
      port: 5432,
      user: 'postgres',
      password: 'superoot',
      database: 'Mega_Dulces',
    },
    pool: { min: 0, max: 4 },
  });
}

function buildTargetKnex() {
  // postgres_platform local (Docker pgvector pg18)
  const url = process.env.DATABASE_URL_NEW;
  if (!url) throw new Error('DATABASE_URL_NEW no seteado en .env');
  return knexLib({
    client: 'pg',
    connection: url,
    pool: { min: 0, max: 6 },
  });
}

// ───────────────────────── helpers ─────────────────────────

const MD_WAREHOUSE_CODES = ['MD-10', 'MD-30', 'MD-40', 'MD-42', 'MD-44', 'MD-50', 'MD-54', 'MD-CEDIS'];
// Mapping de prefijo de columna en productos_activos → warehouse code.
// `ex_cedis` es columna especial → MD-CEDIS.
const WAREHOUSE_COLUMN_MAP = {
  alm10_existencia_g: 'MD-10',
  alm30_existencias_g: 'MD-30', // typo de la fuente: "existencias" no "existencia"
  alm50_existencia_g: 'MD-50',
  // Los siguientes no tienen `_existencia_g` puro pero sí `_existencia_wc` y `_actual_*`.
  // Para stock real usamos `alm{X}_existencia_g`. Almacenes sin esa columna
  // (40/42/44/54) se inicializan en 0 — el sync siguiente los actualiza si
  // aparecen datos.
  ex_cedis: 'MD-CEDIS',
};

// 5 price lists fijas (orden por priority: MAYOREO=100 default, P1-P4 descenden)
const PRICE_LISTS = [
  { code: 'MAYOREO', name: 'Mayoreo', source_col: 'precio_mayoreo', is_default: true },
  { code: 'P1', name: 'Nivel 1 (precio público)', source_col: 'p_1', is_default: false },
  { code: 'P2', name: 'Nivel 2', source_col: 'p_2', is_default: false },
  { code: 'P3', name: 'Nivel 3', source_col: 'p_3', is_default: false },
  { code: 'P4', name: 'Nivel 4 (mayorista grande)', source_col: 'p_4', is_default: false },
];

// Sanitización: trims + nulleo de strings vacíos
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function resolveTenantId(target, slug) {
  const row = await target('tenants').where({ slug }).first();
  if (!row) throw new Error(`Tenant slug "${slug}" no encontrado en postgres_platform.tenants`);
  return row.id;
}

async function withTenantTx(target, tenantId, callback) {
  return target.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
    return callback(trx);
  });
}

// ───────────────────────── importers por scope ─────────────────────────

async function syncCategories({ source, target, tenantId, dryRun }) {
  console.log('\n[categories] ─────────────────────────────');
  // Solo categorías USADAS por productos activos (no traemos las 542 cuando
  // solo se usan 386).
  const rows = await source.raw(`
    SELECT DISTINCT cat.codigo, cat.nombre
      FROM productos_activos pa
      JOIN catalogo_completo cc ON cc.articulo = pa.articulo
      JOIN categorias cat ON cat.codigo = cc.categoria
     WHERE cat.nombre IS NOT NULL
     ORDER BY cat.codigo
  `);
  console.log(`  source: ${rows.rows.length} categorías en uso`);

  if (dryRun) {
    console.log(`  [DRY-RUN] omitiendo upsert`);
    return { upserted: 0, source: rows.rows.length };
  }

  let upserted = 0;
  await withTenantTx(target, tenantId, async (trx) => {
    for (const r of rows.rows) {
      const code = clean(r.codigo);
      const name = clean(r.nombre);
      if (!code || !name) continue;
      // INSERT ... ON CONFLICT update name si cambió.
      const result = await trx.raw(`
        INSERT INTO categories (tenant_id, code, name)
        VALUES (?, ?, ?)
        ON CONFLICT (tenant_id, code)
        DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
          WHERE categories.name IS DISTINCT FROM EXCLUDED.name
      `, [tenantId, code, name]);
      upserted += result.rowCount || 0;
    }
  });

  console.log(`  ✓ ${upserted} categorías upserted (insert/update)`);
  return { upserted, source: rows.rows.length };
}

async function syncBrands({ source, target, tenantId, dryRun }) {
  console.log('\n[brands] ─────────────────────────────────');
  // Brands = subfamilias (proveedores). Solo las USADAS por productos activos.
  const rows = await source.raw(`
    SELECT DISTINCT sub.codigo, sub.nombre
      FROM productos_activos pa
      JOIN catalogo_completo cc ON cc.articulo = pa.articulo
      JOIN subfamilias sub ON sub.codigo = cc.subfamilia
     WHERE sub.nombre IS NOT NULL
     ORDER BY sub.codigo
  `);
  console.log(`  source: ${rows.rows.length} brands en uso`);

  if (dryRun) {
    console.log(`  [DRY-RUN] omitiendo upsert`);
    return { upserted: 0, source: rows.rows.length };
  }

  let upserted = 0;
  await withTenantTx(target, tenantId, async (trx) => {
    for (const r of rows.rows) {
      const code = clean(r.codigo);
      const name = clean(r.nombre);
      if (!code || !name) continue;
      // Brands ya tiene nombre como unique por (tenant_id, nombre).
      // Estrategia: buscar por code primero, si no existe buscar por nombre,
      // si tampoco existe crear.
      const byCode = await trx('brands').where({ tenant_id: tenantId, code }).first();
      if (byCode) {
        if (byCode.nombre !== name) {
          await trx('brands').where({ id: byCode.id }).update({ nombre: name, updated_at: trx.fn.now() });
          upserted++;
        }
        continue;
      }
      // Sin code → ver si existe por nombre (legacy import previo) para hidratar code.
      const byName = await trx('brands').where({ tenant_id: tenantId, nombre: name }).first();
      if (byName) {
        await trx('brands').where({ id: byName.id }).update({ code, updated_at: trx.fn.now() });
        upserted++;
        continue;
      }
      // Insertar nuevo.
      await trx('brands').insert({ tenant_id: tenantId, code, nombre: name });
      upserted++;
    }
  });

  console.log(`  ✓ ${upserted} brands upserted`);
  return { upserted, source: rows.rows.length };
}

async function syncWarehouses({ target, tenantId, dryRun }) {
  console.log('\n[warehouses] ─────────────────────────────');
  const wh = [
    { code: 'MD-CEDIS', name: 'CEDIS Mega Dulces',           is_default: true  },
    { code: 'MD-10',    name: 'Almacén 10',                   is_default: false },
    { code: 'MD-30',    name: 'Almacén 30',                   is_default: false },
    { code: 'MD-40',    name: 'Almacén 40',                   is_default: false },
    { code: 'MD-42',    name: 'Almacén 42',                   is_default: false },
    { code: 'MD-44',    name: 'Almacén 44',                   is_default: false },
    { code: 'MD-50',    name: 'Almacén 50',                   is_default: false },
    { code: 'MD-54',    name: 'Almacén 54',                   is_default: false },
  ];

  if (dryRun) {
    console.log(`  [DRY-RUN] omitiendo upsert de ${wh.length} warehouses`);
    return { upserted: 0, source: wh.length };
  }

  let upserted = 0;
  await withTenantTx(target, tenantId, async (trx) => {
    for (const w of wh) {
      const exists = await trx('commercial.warehouses').where({ code: w.code }).first();
      if (exists) {
        // Solo actualizar nombre si cambió. NO tocamos `is_default` para no
        // sobrescribir lo que el admin haya configurado vía UI.
        if (exists.name !== w.name) {
          await trx('commercial.warehouses').where({ id: exists.id })
            .update({ name: w.name, updated_at: trx.fn.now() });
          upserted++;
        }
        continue;
      }
      // El primer warehouse en crearse será default si no hay otro default.
      const hasDefault = await trx('commercial.warehouses').where({ is_default: true }).first();
      await trx('commercial.warehouses').insert({
        tenant_id: tenantId,
        code: w.code,
        name: w.name,
        is_default: !hasDefault && w.is_default,
        active: true,
      });
      upserted++;
    }
  });

  console.log(`  ✓ ${upserted} warehouses upserted`);
  return { upserted, source: wh.length };
}

async function syncPriceLists({ target, tenantId, dryRun }) {
  console.log('\n[price-lists] ────────────────────────────');
  if (dryRun) {
    console.log(`  [DRY-RUN] omitiendo upsert de ${PRICE_LISTS.length} price lists`);
    return { upserted: 0, source: PRICE_LISTS.length };
  }

  let upserted = 0;
  await withTenantTx(target, tenantId, async (trx) => {
    for (const pl of PRICE_LISTS) {
      const exists = await trx('commercial.price_lists').where({ code: pl.code }).first();
      if (exists) {
        if (exists.name !== pl.name) {
          await trx('commercial.price_lists').where({ id: exists.id })
            .update({ name: pl.name, updated_at: trx.fn.now() });
          upserted++;
        }
        continue;
      }
      // is_default: solo lo aplica el primero (MAYOREO) si no hay otra default.
      const hasDefault = await trx('commercial.price_lists').where({ is_default: true }).first();
      await trx('commercial.price_lists').insert({
        tenant_id: tenantId,
        code: pl.code,
        name: pl.name,
        currency: 'MXN',
        is_default: !hasDefault && pl.is_default,
        active: true,
      });
      upserted++;
    }
  });

  console.log(`  ✓ ${upserted} price lists upserted`);
  return { upserted, source: PRICE_LISTS.length };
}

async function syncProducts({ source, target, tenantId, dryRun, limit }) {
  console.log('\n[products] ───────────────────────────────');
  const baseQuery = `
    SELECT
      cc.articulo,
      cc.codigo_barras,
      cc.nombre,
      cc.descripcion,
      cc.categoria   AS categoria_codigo,
      cc.subfamilia  AS subfamilia_codigo,
      cc.unidad_compra,
      cc.unidad_venta,
      cc.factor_compra,
      cc.factor_venta,
      cc.iva_venta,
      cc.ieps_venta,
      CASE WHEN pa.articulo IS NOT NULL THEN true ELSE false END AS is_activo
    FROM catalogo_completo cc
    LEFT JOIN productos_activos pa ON pa.articulo = cc.articulo
    WHERE cc.nombre IS NOT NULL
    ORDER BY cc.articulo
    ${limit ? `LIMIT ${parseInt(limit, 10)}` : ''}
  `;
  const rows = await source.raw(baseQuery);
  console.log(`  source: ${rows.rows.length} productos (${rows.rows.filter((r) => r.is_activo).length} activos)`);

  if (dryRun) {
    console.log(`  [DRY-RUN] sample row:`, JSON.stringify(rows.rows[0], null, 2));
    return { upserted: 0, source: rows.rows.length };
  }

  // Pre-cargar lookup tables para mapping rápido (en lugar de 1 query por row).
  const brandsByCode = new Map();
  const categoriesByCode = new Map();
  await withTenantTx(target, tenantId, async (trx) => {
    for (const b of await trx('brands').where({ tenant_id: tenantId }).whereNotNull('code')) {
      brandsByCode.set(b.code, b.id);
    }
    for (const c of await trx('categories').where({ tenant_id: tenantId })) {
      categoriesByCode.set(c.code, c.id);
    }
  });
  console.log(`  lookup: ${brandsByCode.size} brands × ${categoriesByCode.size} categories cacheadas`);

  let upserted = 0;
  let skipped = 0;
  const skipReasons = { no_brand: 0, no_name: 0, error: 0 };

  await withTenantTx(target, tenantId, async (trx) => {
    for (const r of rows.rows) {
      const sku = clean(r.articulo);
      const nombre = clean(r.nombre);
      if (!sku || !nombre) { skipped++; skipReasons.no_name++; continue; }

      const brandId = brandsByCode.get(clean(r.subfamilia_codigo));
      if (!brandId) { skipped++; skipReasons.no_brand++; continue; }

      const categoryId = categoriesByCode.get(clean(r.categoria_codigo)) || null;
      const ivaRate = r.iva_venta != null ? Number(r.iva_venta) / 100 : null;
      const iepsRate = r.ieps_venta != null ? Number(r.ieps_venta) / 100 : null;

      try {
        // Buscar por sku primero (preferido), si no existe por (brand_id, nombre)
        // (legacy import inicial que usó nombre como dedup key).
        let existing = await trx('products')
          .where({ tenant_id: tenantId, sku })
          .first();
        if (!existing) {
          existing = await trx('products')
            .where({ tenant_id: tenantId, brand_id: brandId, nombre })
            .first();
        }

        const patch = {
          sku,
          barcode: clean(r.codigo_barras),
          brand_id: brandId,
          category_id: categoryId,
          nombre,
          unit_purchase: clean(r.unidad_compra),
          unit_sale: clean(r.unidad_venta),
          factor_purchase: r.factor_compra != null ? Number(r.factor_compra) : null,
          factor_sale: r.factor_venta != null ? Number(r.factor_venta) : null,
          iva_rate: ivaRate,
          ieps_rate: iepsRate,
          activo: r.is_activo === true,
          updated_at: trx.fn.now(),
        };

        if (existing) {
          await trx('products').where({ id: existing.id }).update(patch);
        } else {
          await trx('products').insert({ tenant_id: tenantId, ...patch });
        }
        upserted++;
      } catch (e) {
        skipped++;
        skipReasons.error++;
        if (skipReasons.error <= 5) {
          console.warn(`  WARN sku=${sku}: ${e.message}`);
        }
      }
    }
  });

  console.log(`  ✓ ${upserted} productos upserted (skip ${skipped}: ${JSON.stringify(skipReasons)})`);
  return { upserted, skipped, source: rows.rows.length };
}

async function syncPrices({ source, target, tenantId, dryRun, limit }) {
  console.log('\n[prices] ─────────────────────────────────');
  const baseQuery = `
    SELECT et.articulo, et.precio_mayoreo, et.p_1, et.p_2, et.p_3, et.p_4
      FROM catalogo_etiquetas et
      JOIN productos_activos pa ON pa.articulo = et.articulo
      ${limit ? `LIMIT ${parseInt(limit, 10)}` : ''}
  `;
  const rows = await source.raw(baseQuery);
  console.log(`  source: ${rows.rows.length} productos con precios`);

  if (dryRun) {
    console.log(`  [DRY-RUN] sample row:`, JSON.stringify(rows.rows[0], null, 2));
    return { upserted: 0, source: rows.rows.length };
  }

  // Pre-cargar lookup tables
  const priceListByCode = new Map();
  const productBySku = new Map();
  await withTenantTx(target, tenantId, async (trx) => {
    for (const pl of await trx('commercial.price_lists').where({ tenant_id: tenantId })) {
      priceListByCode.set(pl.code, pl.id);
    }
    for (const p of await trx('products').where({ tenant_id: tenantId }).whereNotNull('sku')) {
      productBySku.set(p.sku, { id: p.id, iva_rate: p.iva_rate });
    }
  });
  console.log(`  lookup: ${priceListByCode.size} price_lists × ${productBySku.size} products cacheados`);

  let upserted = 0;
  let skipped = 0;

  await withTenantTx(target, tenantId, async (trx) => {
    for (const r of rows.rows) {
      const sku = clean(r.articulo);
      const product = productBySku.get(sku);
      if (!product) { skipped++; continue; }

      const tax = product.iva_rate != null ? Number(product.iva_rate) : 0.16;

      for (const pl of PRICE_LISTS) {
        const price = r[pl.source_col];
        if (price == null || Number(price) <= 0) continue;
        const priceListId = priceListByCode.get(pl.code);
        if (!priceListId) continue;

        // UNIQUE constraint es (tenant_id, price_list_id, product_id) sin
        // partial. Hacemos SELECT + UPDATE/INSERT explícito (sin ON CONFLICT)
        // para evitar contaminar la trx con errores recuperables.
        const existing = await trx('commercial.product_prices')
          .where({ tenant_id: tenantId, price_list_id: priceListId, product_id: product.id })
          .first();
        if (existing) {
          if (Number(existing.price) !== Number(price) || Number(existing.tax_rate) !== tax) {
            await trx('commercial.product_prices').where({ id: existing.id })
              .update({ price: Number(price), tax_rate: tax, updated_at: trx.fn.now() });
            upserted++;
          }
        } else {
          await trx('commercial.product_prices').insert({
            tenant_id: tenantId,
            price_list_id: priceListId,
            product_id: product.id,
            price: Number(price),
            tax_rate: tax,
            min_qty: 1,
          });
          upserted++;
        }
      }
    }
  });

  console.log(`  ✓ ${upserted} precios upserted (skip ${skipped} sin sku en target)`);
  return { upserted, skipped, source: rows.rows.length };
}

async function syncStock({ source, target, tenantId, dryRun, limit }) {
  console.log('\n[stock] ──────────────────────────────────');
  const baseQuery = `
    SELECT pa.articulo,
           pa.alm10_existencia_g,
           pa.alm30_existencias_g,
           pa.alm50_existencia_g,
           pa.ex_cedis
      FROM productos_activos pa
      ${limit ? `LIMIT ${parseInt(limit, 10)}` : ''}
  `;
  const rows = await source.raw(baseQuery);
  console.log(`  source: ${rows.rows.length} productos activos con stock`);

  if (dryRun) {
    console.log(`  [DRY-RUN] sample row:`, JSON.stringify(rows.rows[0], null, 2));
    return { upserted: 0, source: rows.rows.length };
  }

  // Lookup
  const warehouseByCode = new Map();
  const productBySku = new Map();
  await withTenantTx(target, tenantId, async (trx) => {
    for (const w of await trx('commercial.warehouses').where({ tenant_id: tenantId })) {
      warehouseByCode.set(w.code, w.id);
    }
    for (const p of await trx('products').where({ tenant_id: tenantId }).whereNotNull('sku')) {
      productBySku.set(p.sku, p.id);
    }
  });
  console.log(`  lookup: ${warehouseByCode.size} warehouses × ${productBySku.size} products`);

  let upserted = 0;
  let skipped = 0;

  await withTenantTx(target, tenantId, async (trx) => {
    for (const r of rows.rows) {
      const sku = clean(r.articulo);
      const productId = productBySku.get(sku);
      if (!productId) { skipped++; continue; }

      for (const [col, whCode] of Object.entries(WAREHOUSE_COLUMN_MAP)) {
        const qty = r[col];
        if (qty == null) continue;
        const warehouseId = warehouseByCode.get(whCode);
        if (!warehouseId) continue;

        // Stock NUNCA puede ser negativo en commercial.stock — convertimos a 0
        // si la fuente devuelve negativos (descuentos contables, etc.).
        const safeQty = Math.max(0, Number(qty));

        const existing = await trx('commercial.stock')
          .where({ warehouse_id: warehouseId, product_id: productId })
          .first();

        if (existing) {
          // Solo actualizar si cambió.
          if (Number(existing.quantity) !== safeQty) {
            await trx('commercial.stock').where({ id: existing.id })
              .update({ quantity: safeQty, updated_at: trx.fn.now() });
          }
        } else {
          await trx('commercial.stock').insert({
            tenant_id: tenantId,
            warehouse_id: warehouseId,
            product_id: productId,
            quantity: safeQty,
            reserved_quantity: 0,
          });
        }
        upserted++;
      }
    }
  });

  console.log(`  ✓ ${upserted} stock rows upserted (skip ${skipped} sin sku en target)`);
  return { upserted, skipped, source: rows.rows.length };
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }
  if (!args.tenant_slug) {
    console.error('ERROR: --tenant-slug=<slug> requerido');
    process.exit(1);
  }

  console.log(`\nMega_Dulces → postgres_platform sync`);
  console.log(`tenant_slug: ${args.tenant_slug}`);
  console.log(`scope:       ${args.scope}`);
  console.log(`dry-run:     ${args.dryRun ? 'YES' : 'no'}`);
  if (args.limit) console.log(`limit:       ${args.limit} (testing)`);

  const source = buildSourceKnex();
  const target = buildTargetKnex();

  let tenantId;
  try {
    tenantId = await resolveTenantId(target, args.tenant_slug);
    console.log(`tenant_id:   ${tenantId}`);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }

  const ctx = { source, target, tenantId, dryRun: !!args.dryRun, limit: args.limit };

  const order = ['categories', 'brands', 'warehouses', 'price-lists', 'products', 'prices', 'stock'];
  const scopes = args.scope === 'all' ? order : [args.scope];

  const summary = {};
  const t0 = Date.now();

  try {
    for (const s of scopes) {
      let r;
      switch (s) {
        case 'categories':  r = await syncCategories(ctx); break;
        case 'brands':      r = await syncBrands(ctx); break;
        case 'warehouses':  r = await syncWarehouses(ctx); break;
        case 'price-lists': r = await syncPriceLists(ctx); break;
        case 'products':    r = await syncProducts(ctx); break;
        case 'prices':      r = await syncPrices(ctx); break;
        case 'stock':       r = await syncStock(ctx); break;
        default:
          console.error(`Scope desconocido: ${s}`);
          process.exit(1);
      }
      summary[s] = r;
    }
  } finally {
    await source.destroy();
    await target.destroy();
  }

  const dt = Date.now() - t0;
  console.log(`\n──────────────────────────────────────────`);
  console.log(`✓ Sync completo en ${dt}ms`);
  for (const [k, v] of Object.entries(summary)) {
    console.log(`  ${k.padEnd(12)}: ${v.upserted} upserted / ${v.source} source${v.skipped ? ` (skip ${v.skipped})` : ''}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\nFATAL:', e);
    process.exit(1);
  });
}

module.exports = { main };
