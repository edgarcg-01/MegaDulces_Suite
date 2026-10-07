/* eslint-disable no-console */
/**
 * Upsert de precios que NO pisa lo que no le mandaron.
 *
 * `POST /commercial/product-prices/bulk-upsert` es el único camino de escritura
 * de precios (lo usa la celda editable de /comercial/pricing, que manda sólo
 * `{ product_id, price }`). Antes metía `min_qty ?? 1` y `tax_rate ?? 0.16` en el
 * MERGE, así que editar un precio borraba el quiebre por volumen del SKU — y con
 * `resolvePriceForQty` eligiendo el precio MÁS BAJO con `min_qty <= qty`, el
 * precio de mayoreo quedaba disponible comprando 1 pieza.
 *
 * `upsert()` de acá es ESPEJO de `CommercialPricingService.bulkUpsertPrices`.
 * Si uno cambia, cambian los dos (hay un tripwire de fuente al final que falla
 * si el MERGE del service vuelve a listar min_qty/tax_rate sin condición).
 *
 * Todo corre en UNA transacción con ROLLBACK: no deja rastro en la DB.
 */
const fs = require('fs');
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);

const SERVICE_TS = path.resolve(__dirname, '../../libs/commercial/src/lib/commercial-pricing/commercial-pricing.service.ts');
const COMPONENT_TS = path.resolve(__dirname, '../../apps/view/src/app/modules/comercial/pages/comercial-pricing.component.ts');
const OPTIONAL = ['tax_rate', 'min_qty'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

/** Espejo del upsert nuevo: cada grupo mergea SÓLO los campos que trajo. */
async function upsert(trx, priceListId, items) {
  const groups = new Map();
  for (const it of items) {
    const key = OPTIONAL.filter((f) => it[f] !== undefined).join(',');
    if (groups.has(key)) groups.get(key).push(it); else groups.set(key, [it]);
  }
  let upserted = 0;
  for (const [key, group] of groups) {
    const present = key ? key.split(',') : [];
    const rows = group.map((it) => {
      const row = {
        tenant_id: trx.raw('public.current_tenant_id()'),
        price_list_id: priceListId,
        product_id: it.product_id,
        price: it.price,
        updated_at: trx.fn.now(),
      };
      for (const f of present) row[f] = it[f];
      return row;
    });
    const merge = {
      price: trx.raw('EXCLUDED.price'),
      updated_at: trx.fn.now(),
      deleted_at: null,
      deleted_by: null,
    };
    for (const f of present) merge[f] = trx.raw('EXCLUDED.' + f);
    const inserted = await trx('commercial.product_prices')
      .insert(rows)
      .onConflict(['tenant_id', 'price_list_id', 'product_id'])
      .merge(merge)
      .returning('id');
    upserted += inserted.length;
  }
  return upserted;
}

/** El upsert VIEJO, sólo como control: demuestra qué se está evitando. */
function legacyUpsert(trx, priceListId, it) {
  return trx('commercial.product_prices')
    .insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      price_list_id: priceListId,
      product_id: it.product_id,
      price: it.price,
      tax_rate: it.tax_rate ?? 0.16,
      min_qty: it.min_qty ?? 1,
      updated_at: trx.fn.now(),
    })
    .onConflict(['tenant_id', 'price_list_id', 'product_id'])
    .merge(['price', 'tax_rate', 'min_qty', 'updated_at'])
    .returning('id');
}

const read = (trx, id) =>
  trx('commercial.product_prices').where({ id }).first('price', 'tax_rate', 'min_qty', 'deleted_at');

(async () => {
  let rolledBack = false;
  try {
    // ── 0. La exposición existe en data real ────────────────────────────────
    const exp = await knex('commercial.product_prices')
      .whereNull('deleted_at')
      .select(
        knex.raw('count(*)::int total'),
        knex.raw('count(*) FILTER (WHERE min_qty > 1)::int min_gt1'),
        knex.raw('count(*) FILTER (WHERE tax_rate <> 0.16)::int tax_ne_default'),
      )
      .first();
    console.log(`  data real: ${exp.total} precios · ${exp.min_gt1} con min_qty>1 · ${exp.tax_ne_default} con tax_rate<>0.16`);
    ok(exp.min_gt1 > 0, `hay ${exp.min_gt1} precios con quiebre por volumen que un upsert podría borrar`);

    await knex.transaction(async (trx) => {
      // RLS forzado: sin el GUC, `current_tenant_id()` tira y no se ve ninguna fila.
      await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);

      // Víctima: un precio real con min_qty > 1.
      const victim = await trx('commercial.product_prices')
        .whereNull('deleted_at').where('min_qty', '>', 1)
        .first('id', 'price_list_id', 'product_id', 'price', 'tax_rate', 'min_qty');
      ok(!!victim, 'hay un precio con min_qty>1 para probar');
      if (!victim) throw new Error('sin fila con min_qty>1');
      const before = { price: Number(victim.price), tax_rate: Number(victim.tax_rate), min_qty: Number(victim.min_qty) };
      console.log(`  víctima: min_qty=${before.min_qty} tax_rate=${before.tax_rate} price=$${before.price}`);

      // ── 1. Control: el upsert viejo pisa min_qty ──────────────────────────
      await legacyUpsert(trx, victim.price_list_id, { product_id: victim.product_id, price: before.price + 1 });
      let row = await read(trx, victim.id);
      ok(Number(row.min_qty) === 1, `control: el upsert VIEJO tiró min_qty ${before.min_qty}→1 (el bug)`);

      // Restaurar y probar el nuevo.
      await trx('commercial.product_prices').where({ id: victim.id })
        .update({ price: before.price, tax_rate: before.tax_rate, min_qty: before.min_qty });

      // ── 2. El upsert nuevo cambia precio y NADA más ───────────────────────
      const nuevo = Math.round((before.price + 1.23) * 100) / 100;
      const n = await upsert(trx, victim.price_list_id, [{ product_id: victim.product_id, price: nuevo }]);
      ok(n === 1, 'upsert price-only afecta 1 fila');
      row = await read(trx, victim.id);
      ok(Number(row.price) === nuevo, `price se actualizó a $${nuevo}`);
      ok(Number(row.min_qty) === before.min_qty, `min_qty intacto (${before.min_qty})`);
      ok(Number(row.tax_rate) === before.tax_rate, `tax_rate intacto (${before.tax_rate})`);

      // ── 3. …pero min_qty/tax_rate SIGUEN siendo escribibles cuando se mandan ─
      await upsert(trx, victim.price_list_id, [
        { product_id: victim.product_id, price: nuevo, min_qty: before.min_qty + 7, tax_rate: 0 },
      ]);
      row = await read(trx, victim.id);
      ok(Number(row.min_qty) === before.min_qty + 7, `min_qty explícito sí escribe (${before.min_qty + 7})`);
      ok(Number(row.tax_rate) === 0, 'tax_rate explícito sí escribe (0)');

      // ── 4. Quitar un precio y volver a ponerlo lo revive ──────────────────
      await trx('commercial.product_prices').where({ id: victim.id }).update({ deleted_at: trx.fn.now() });
      await upsert(trx, victim.price_list_id, [{ product_id: victim.product_id, price: nuevo }]);
      row = await read(trx, victim.id);
      ok(row.deleted_at === null, 'upsert después de borrar limpia deleted_at (la fila vuelve a ser visible)');

      // ── 5. Fila nueva sin campos opcionales → DEFAULT de la columna ───────
      const virgen = await trx('catalog.products as p')
        .leftJoin('commercial.product_prices as pp', function () {
          this.on('pp.product_id', '=', 'p.id').andOnVal('pp.price_list_id', victim.price_list_id);
        })
        .whereNull('p.deleted_at').whereNull('pp.id')
        .first('p.id');
      ok(!!virgen, 'hay un producto sin precio en esta lista para probar el insert');
      if (virgen) {
        await upsert(trx, victim.price_list_id, [{ product_id: virgen.id, price: 9.99 }]);
        const fresh = await trx('commercial.product_prices')
          .where({ price_list_id: victim.price_list_id, product_id: virgen.id })
          .first('price', 'tax_rate', 'min_qty');
        ok(Number(fresh.min_qty) === 1, 'fila nueva toma min_qty=1 del DEFAULT');
        ok(Number(fresh.tax_rate) === 0.16, 'fila nueva toma tax_rate=0.16 del DEFAULT');
      }

      // Nada de esto queda.
      rolledBack = true;
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    ok(rolledBack, 'transacción revertida: la DB queda como estaba');

    // ── 6. Tripwire de fuente ───────────────────────────────────────────────
    const svc = fs.readFileSync(SERVICE_TS, 'utf8');
    const from = svc.indexOf('async bulkUpsertPrices');
    const cut = svc.slice(from, svc.indexOf('async deletePrice', from));
    ok(!/\.merge\(\[[^\]]*min_qty/.test(cut), 'el MERGE del service no lista min_qty sin condición');
    ok(!/\.merge\(\[[^\]]*tax_rate/.test(cut), 'el MERGE del service no lista tax_rate sin condición');
    ok(/deleted_at: null/.test(cut), 'el MERGE del service limpia deleted_at');
    const cmp = fs.readFileSync(COMPONENT_TS, 'utf8');
    ok(
      /bulkUpsertPrices\(\{[^}]*items: \[\{ product_id: row\.product_id, price: rounded \}\]/.test(cmp),
      'la celda de /comercial/pricing sigue mandando sólo product_id+price (el caso que el fix protege)',
    );

    console.log(`\nPricing upsert preserve: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
