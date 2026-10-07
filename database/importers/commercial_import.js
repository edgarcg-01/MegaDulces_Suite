#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Importer CLI para data comercial.
 *
 * Lee un archivo JSON (array de rows) y upsertea en la tabla correspondiente.
 * Idempotente por `code` (entidades) o `(price_list, product)` (precios) o
 * `(warehouse, product)` (stock).
 *
 * Uso:
 *   node database/importers/commercial_import.js \
 *     --file=<path> \
 *     --type=<customers|brands|products|prices|warehouses|stock> \
 *     --tenant-slug=<slug> \
 *     [--dry-run]
 *
 * Para prices/stock se requieren args adicionales — ver examples/ y --help.
 *
 * Conexión: usa DATABASE_URL_NEW (postgres superuser) porque algunas
 * operaciones (bulk insert con FK resolution) son más simples sin RLS.
 * Aún seteamos `app.tenant_id` para que WITH CHECK pase. NO usar app_runtime
 * acá — sería más estricto pero forzaría resolución manual de FKs cross-table.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const knexLib = require('knex');

// ───────────────────────── arg parsing ─────────────────────────

function parseArgs(argv) {
  const args = {};
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
  node commercial_import.js --type=<t> --file=<f> --tenant-slug=<s> [--dry-run]

Types:
  customers   — array of { code, name, legal_name?, rfc?, email?, phone?,
                billing_address?, shipping_address?, default_price_list_code?,
                credit_limit?, payment_terms_days?, active?, notes? }
  brands      — array of { nombre, activo?, orden? }
  products    — array of { brand_nombre, nombre, activo?, orden?, puntuacion? }
  warehouses  — array of { code, name, address?, is_default?, active? }
  prices      — requires --price-list-code=<code>
                array of { product_brand, product_nombre, price, tax_rate?, min_qty? }
  stock       — requires --warehouse-code=<code>
                array of { product_brand, product_nombre, quantity }

Flags:
  --dry-run   Valida + reporta, no escribe.
`);
}

// ───────────────────────── helpers ─────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_REGEX = /^[A-Z0-9_-]{2,50}$/;
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

function loadFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const raw = fs.readFileSync(abs, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('JSON debe ser un array de rows');
  return data;
}

async function resolveTenant(knex, slug) {
  const t = await knex('public.tenants').where({ slug, activo: true }).first();
  if (!t) throw new Error(`Tenant slug "${slug}" no encontrado o inactivo`);
  return t;
}

async function setCtx(trx, tenantId) {
  await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);
}

function summarize(results) {
  return {
    total: results.length,
    upserted: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok).length,
    errors: results
      .filter((r) => !r.ok)
      .slice(0, 10)
      .map((r) => ({ row: r.index, reason: r.reason })),
  };
}

// ───────────────────────── per-entity importers ─────────────────────────

const importers = {
  // ─── customers ───
  async customers({ knex, tenant, rows, dryRun, extra }) {
    const results = [];
    let priceListMap = {};

    if (!dryRun) {
      await knex.transaction(async (trx) => {
        await setCtx(trx, tenant.id);
        const pls = await trx('commercial.price_lists').select('id', 'code');
        priceListMap = Object.fromEntries(pls.map((p) => [p.code, p.id]));

        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          try {
            if (!CODE_REGEX.test(r.code || ''))
              throw new Error(`code inválido (regex [A-Z0-9_-]{2,50})`);
            if (!r.name || !r.name.trim())
              throw new Error('name requerido');
            if (r.rfc && !RFC_REGEX.test(String(r.rfc).toUpperCase()))
              throw new Error(`rfc formato MX inválido`);

            const default_price_list_id = r.default_price_list_code
              ? priceListMap[r.default_price_list_code]
              : null;
            if (r.default_price_list_code && !default_price_list_id)
              throw new Error(
                `price_list code "${r.default_price_list_code}" no existe`,
              );

            await trx('commercial.customers')
              .insert({
                tenant_id: trx.raw('public.current_tenant_id()'),
                code: r.code,
                name: r.name.trim(),
                legal_name: r.legal_name?.trim() || null,
                rfc: r.rfc ? String(r.rfc).toUpperCase() : null,
                email: r.email ? String(r.email).toLowerCase() : null,
                phone: r.phone || null,
                billing_address: r.billing_address
                  ? JSON.stringify(r.billing_address)
                  : null,
                shipping_address: r.shipping_address
                  ? JSON.stringify(r.shipping_address)
                  : null,
                default_price_list_id,
                credit_limit: r.credit_limit ?? 0,
                payment_terms_days: r.payment_terms_days ?? 0,
                active: r.active ?? true,
                notes: r.notes || null,
              })
              .onConflict(['tenant_id', 'code'])
              .merge([
                'name',
                'legal_name',
                'rfc',
                'email',
                'phone',
                'billing_address',
                'shipping_address',
                'default_price_list_id',
                'credit_limit',
                'payment_terms_days',
                'active',
                'notes',
                'updated_at',
              ]);
            results.push({ index: i, ok: true });
          } catch (e) {
            results.push({ index: i, ok: false, reason: e.message });
          }
        }
      });
    } else {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          if (!CODE_REGEX.test(r.code || '')) throw new Error('code inválido');
          if (!r.name?.trim()) throw new Error('name requerido');
          if (r.rfc && !RFC_REGEX.test(String(r.rfc).toUpperCase()))
            throw new Error('rfc inválido');
          results.push({ index: i, ok: true });
        } catch (e) {
          results.push({ index: i, ok: false, reason: e.message });
        }
      }
    }
    return results;
  },

  // ─── brands ───
  async brands({ knex, tenant, rows, dryRun }) {
    const results = [];

    const exec = async (trx) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          if (!r.nombre?.trim()) throw new Error('nombre requerido');
          if (!dryRun) {
            await trx('public.brands')
              .insert({
                tenant_id: trx.raw('public.current_tenant_id()'),
                nombre: r.nombre.trim(),
                activo: r.activo ?? true,
                orden: r.orden ?? 0,
              })
              .onConflict(['tenant_id', 'nombre'])
              .merge(['activo', 'orden', 'updated_at']);
          }
          results.push({ index: i, ok: true });
        } catch (e) {
          results.push({ index: i, ok: false, reason: e.message });
        }
      }
    };

    if (dryRun) await exec(null);
    else
      await knex.transaction(async (trx) => {
        await setCtx(trx, tenant.id);
        await exec(trx);
      });

    return results;
  },

  // ─── products ───
  async products({ knex, tenant, rows, dryRun }) {
    const results = [];

    await knex.transaction(async (trx) => {
      await setCtx(trx, tenant.id);
      const brands = await trx('public.brands').select('id', 'nombre');
      const brandMap = Object.fromEntries(brands.map((b) => [b.nombre, b.id]));

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          if (!r.brand_nombre) throw new Error('brand_nombre requerido');
          if (!r.nombre?.trim()) throw new Error('nombre requerido');
          const brandId = brandMap[r.brand_nombre];
          if (!brandId)
            throw new Error(`brand "${r.brand_nombre}" no existe (importar brands primero)`);

          if (!dryRun) {
            await trx('public.products')
              .insert({
                tenant_id: trx.raw('public.current_tenant_id()'),
                brand_id: brandId,
                nombre: r.nombre.trim(),
                activo: r.activo ?? true,
                orden: r.orden ?? 0,
                puntuacion: r.puntuacion ?? 0,
              })
              .onConflict(['tenant_id', 'brand_id', 'nombre'])
              .merge(['activo', 'orden', 'puntuacion', 'updated_at']);
          }
          results.push({ index: i, ok: true });
        } catch (e) {
          results.push({ index: i, ok: false, reason: e.message });
        }
      }
    });

    return results;
  },

  // ─── warehouses ───
  async warehouses({ knex, tenant, rows, dryRun }) {
    const results = [];
    const exec = async (trx) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          if (!CODE_REGEX.test(r.code || '')) throw new Error('code inválido');
          if (!r.name?.trim()) throw new Error('name requerido');
          if (!dryRun) {
            await trx('commercial.warehouses')
              .insert({
                tenant_id: trx.raw('public.current_tenant_id()'),
                code: r.code,
                name: r.name.trim(),
                address: r.address || null,
                is_default: r.is_default ?? false,
                active: r.active ?? true,
              })
              .onConflict(['tenant_id', 'code'])
              .merge(['name', 'address', 'is_default', 'active', 'updated_at']);
          }
          results.push({ index: i, ok: true });
        } catch (e) {
          results.push({ index: i, ok: false, reason: e.message });
        }
      }
    };

    if (dryRun) await exec(null);
    else
      await knex.transaction(async (trx) => {
        await setCtx(trx, tenant.id);
        await exec(trx);
      });
    return results;
  },

  // ─── prices ───
  async prices({ knex, tenant, rows, dryRun, extra }) {
    const priceListCode = extra.price_list_code;
    if (!priceListCode)
      throw new Error('--price-list-code=<code> requerido para type=prices');

    const results = [];
    await knex.transaction(async (trx) => {
      await setCtx(trx, tenant.id);

      const pl = await trx('commercial.price_lists')
        .where({ code: priceListCode })
        .whereNull('deleted_at')
        .first();
      if (!pl)
        throw new Error(`price_list code "${priceListCode}" no encontrada`);

      // Cargar productos para mapeo (brand_nombre + nombre → id)
      const products = await trx('public.products as p')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .select('p.id', 'p.nombre as product_nombre', 'b.nombre as brand_nombre');
      const prodMap = new Map();
      for (const p of products) {
        prodMap.set(`${p.brand_nombre}||${p.product_nombre}`, p.id);
      }

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          if (!r.product_brand) throw new Error('product_brand requerido');
          if (!r.product_nombre) throw new Error('product_nombre requerido');
          if (typeof r.price !== 'number' || r.price < 0)
            throw new Error('price debe ser número >= 0');
          const productId = prodMap.get(`${r.product_brand}||${r.product_nombre}`);
          if (!productId)
            throw new Error(
              `producto "${r.product_brand}/${r.product_nombre}" no existe`,
            );

          if (!dryRun) {
            await trx('commercial.product_prices')
              .insert({
                tenant_id: trx.raw('public.current_tenant_id()'),
                price_list_id: pl.id,
                product_id: productId,
                price: r.price,
                tax_rate: r.tax_rate ?? 0.16,
                min_qty: r.min_qty ?? 1,
              })
              .onConflict(['tenant_id', 'price_list_id', 'product_id'])
              .merge(['price', 'tax_rate', 'min_qty', 'updated_at']);
          }
          results.push({ index: i, ok: true });
        } catch (e) {
          results.push({ index: i, ok: false, reason: e.message });
        }
      }
    });
    return results;
  },

  // ─── stock (initial snapshot) ───
  async stock({ knex, tenant, rows, dryRun, extra }) {
    const warehouseCode = extra.warehouse_code;
    if (!warehouseCode)
      throw new Error('--warehouse-code=<code> requerido para type=stock');

    const results = [];
    await knex.transaction(async (trx) => {
      await setCtx(trx, tenant.id);

      const wh = await trx('commercial.warehouses')
        .where({ code: warehouseCode })
        .whereNull('deleted_at')
        .first();
      if (!wh)
        throw new Error(`warehouse code "${warehouseCode}" no encontrada`);

      const products = await trx('public.products as p')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .select('p.id', 'p.nombre as product_nombre', 'b.nombre as brand_nombre');
      const prodMap = new Map();
      for (const p of products) {
        prodMap.set(`${p.brand_nombre}||${p.product_nombre}`, p.id);
      }

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          if (!r.product_brand) throw new Error('product_brand requerido');
          if (!r.product_nombre) throw new Error('product_nombre requerido');
          if (typeof r.quantity !== 'number' || r.quantity < 0)
            throw new Error('quantity debe ser número >= 0');
          const productId = prodMap.get(`${r.product_brand}||${r.product_nombre}`);
          if (!productId)
            throw new Error(`producto "${r.product_brand}/${r.product_nombre}" no existe`);

          if (!dryRun) {
            // Insert stock + movement. UPSERT en stock.
            const existing = await trx('commercial.stock')
              .where({ warehouse_id: wh.id, product_id: productId })
              .forUpdate()
              .first();

            const qBefore = existing ? Number(existing.quantity) : 0;
            if (existing) {
              await trx('commercial.stock')
                .where({ id: existing.id })
                .update({ quantity: r.quantity, updated_at: trx.fn.now() });
            } else {
              await trx('commercial.stock').insert({
                tenant_id: trx.raw('public.current_tenant_id()'),
                warehouse_id: wh.id,
                product_id: productId,
                quantity: r.quantity,
                reserved_quantity: 0,
              });
            }

            // Movement como 'adjust' con la diferencia
            const delta = r.quantity - qBefore;
            if (delta !== 0) {
              await trx('commercial.stock_movements').insert({
                tenant_id: trx.raw('public.current_tenant_id()'),
                warehouse_id: wh.id,
                product_id: productId,
                movement_type: 'adjust',
                quantity: Math.abs(delta),
                quantity_before: qBefore,
                quantity_after: r.quantity,
                reference_type: 'import',
                notes: `Initial stock snapshot via importer (delta ${delta > 0 ? '+' : ''}${delta})`,
              });
            }
          }
          results.push({ index: i, ok: true });
        } catch (e) {
          results.push({ index: i, ok: false, reason: e.message });
        }
      }
    });
    return results;
  },
};

// ───────────────────────── main ─────────────────────────

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.type || !args.file || !args.tenant_slug) {
    console.error('Faltan args. Use --help para ver opciones.');
    printHelp();
    process.exit(1);
  }
  if (!importers[args.type]) {
    console.error(`Type inválido: ${args.type}. Use --help para ver válidos.`);
    process.exit(1);
  }

  const connStr =
    process.env.DATABASE_URL_NEW || process.env.DATABASE_URL_NEW_RUNTIME;
  if (!connStr) {
    console.error('DATABASE_URL_NEW no configurado en .env');
    process.exit(1);
  }

  const knex = knexLib({ client: 'pg', connection: connStr });

  try {
    const rows = loadFile(args.file);
    console.log(`Loaded ${rows.length} rows from ${args.file}`);

    const tenant = await resolveTenant(knex, args.tenant_slug);
    console.log(`Tenant: ${tenant.slug} (${tenant.id})`);

    if (args.dry_run) console.log('DRY-RUN mode — no se escribirá nada');

    const startedAt = Date.now();
    const results = await importers[args.type]({
      knex,
      tenant,
      rows,
      dryRun: !!args.dry_run,
      extra: args,
    });
    const elapsedMs = Date.now() - startedAt;
    const summary = summarize(results);

    console.log(`\n─── SUMMARY (${args.type}) ───`);
    console.log(`Total rows:  ${summary.total}`);
    console.log(`Upserted:    ${summary.upserted}`);
    console.log(`Skipped:     ${summary.skipped}`);
    console.log(`Elapsed:     ${elapsedMs}ms`);
    if (summary.errors.length) {
      console.log(`\nFirst errors (${summary.errors.length}):`);
      for (const e of summary.errors) {
        console.log(`  row ${e.row}: ${e.reason}`);
      }
    }

    await knex.destroy();
    process.exit(summary.skipped > 0 && !args.dry_run ? 2 : 0);
  } catch (e) {
    console.error('FATAL:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
