/* eslint-disable no-console */
/**
 * Thot T.1 — construye el feature store desde el ERP `Mega_Dulces`:
 *   - intelligence.product_affinity : market-basket (folios) → pares dirigidos A→B con lift.
 *   - intelligence.zone_demand      : demanda por zona (units/revenue/demand_index).
 *
 * Lee ERP por conexión directa (DATABASE_URL_REMOTE_SNAPSHOT → db Mega_Dulces),
 * mapea SKU(articulo)→product_id contra catalog.products, y refresca las tablas
 * (DELETE+INSERT por tenant, idempotente). Corre donde el ERP sea alcanzable.
 *
 * Uso: node database/scripts/thot-build-features.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const Knex = require('knex');

const T = '00000000-0000-0000-0000-00000000d01c';
const MIN_CO = 15; // mínimo de folios compartidos para considerar un par
const TOP_PER_A = 25; // top afinidades por producto

function erpConn() {
  const u = new URL(process.env.DATABASE_URL_REMOTE_SNAPSHOT);
  u.pathname = '/Mega_Dulces';
  return u.toString();
}

(async () => {
  const erp = Knex({ client: 'pg', connection: erpConn(), pool: { min: 0, max: 1 } });
  const app = Knex({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 2 } });
  try {
    // ── SKU → product_id (solo comerciales: excluye promo/descarte/no-vendible) ──
    const prods = (
      await app.raw(
        `select p.id, coalesce(p.sku, p.articulo) as sku
           from catalog.products p
           left join catalog.brands b on b.id=p.brand_id and b.tenant_id=p.tenant_id
          where p.tenant_id=? and p.deleted_at is null and coalesce(p.sku,p.articulo) is not null
            and (b.is_commercial = true or b.is_commercial is null)
            and p.nombre not ilike '%GRATIS%'`,
        [T],
      )
    ).rows;
    const skuToId = new Map(prods.map((p) => [String(p.sku).trim(), p.id]));
    console.log(`catalog.products mapeables: ${skuToId.size}`);

    // ── ZONE DEMAND ──
    const zrows = (
      await erp.raw(
        `select zona, producto_id, sum(cantidad)::numeric units, sum(venta_diaria)::numeric revenue
           from public.ventas where fecha is not null and zona is not null and producto_id is not null
          group by zona, producto_id`,
      )
    ).rows;
    // normalizar por zona + rank
    const byZona = new Map();
    for (const r of zrows) {
      const pid = skuToId.get(String(r.producto_id).trim());
      if (!pid) continue;
      if (!byZona.has(r.zona)) byZona.set(r.zona, []);
      byZona.get(r.zona).push({ pid, units: Number(r.units) || 0, revenue: Number(r.revenue) || 0 });
    }
    const zoneInserts = [];
    for (const [zona, arr] of byZona) {
      const maxU = Math.max(...arr.map((x) => x.units), 1);
      arr.sort((a, b) => b.units - a.units);
      arr.forEach((x, i) => {
        zoneInserts.push({
          tenant_id: T, zona, product_id: x.pid,
          units: x.units.toFixed(2), revenue: x.revenue.toFixed(2),
          demand_index: Math.min(1, x.units / maxU).toFixed(4), rank: i + 1,
        });
      });
    }

    // ── AFFINITY (market-basket) ──
    console.log('Computando market-basket (puede tardar)...');
    await erp.raw(`drop table if exists _baskets`);
    await erp.raw(`create temp table _baskets as
      select distinct fecha, folio, tercero_id, producto_id
        from public.ventas
       where folio is not null and fecha is not null and producto_id is not null`);
    await erp.raw(`create index on _baskets (fecha, folio, tercero_id)`);
    const pairs = (
      await erp.raw(
        `with total as (select count(*) n from (select distinct fecha,folio,tercero_id from _baskets) t),
              freq  as (select producto_id, count(*) c from _baskets group by producto_id),
              pr    as (select a.producto_id pa, b.producto_id pb, count(*) co
                          from _baskets a join _baskets b
                            on a.fecha=b.fecha and a.folio=b.folio and a.tercero_id=b.tercero_id
                           and a.producto_id < b.producto_id
                         group by 1,2 having count(*) >= ?)
         select pr.pa, pr.pb, pr.co, fa.c freq_a, fb.c freq_b, (select n from total) n
           from pr join freq fa on fa.producto_id=pr.pa join freq fb on fb.producto_id=pr.pb`,
        [MIN_CO],
      )
    ).rows;
    console.log(`pares con co>=${MIN_CO}: ${pairs.length}`);

    // expandir a dirigido A→B y B→A, mapear, top-N por A
    const byA = new Map();
    const push = (a, b, co, freqA, n, freqB) => {
      const ida = skuToId.get(String(a).trim()), idb = skuToId.get(String(b).trim());
      if (!ida || !idb) return;
      const lift = (co * n) / (freqA * freqB);
      const row = {
        tenant_id: T, product_a: ida, product_b: idb, co_count: co,
        support: (co / n).toFixed(6), confidence: (co / freqA).toFixed(6), lift: lift.toFixed(4),
      };
      if (!byA.has(ida)) byA.set(ida, []);
      byA.get(ida).push(row);
    };
    for (const p of pairs) {
      push(p.pa, p.pb, Number(p.co), Number(p.freq_a), Number(p.n), Number(p.freq_b));
      push(p.pb, p.pa, Number(p.co), Number(p.freq_b), Number(p.n), Number(p.freq_a));
    }
    const affInserts = [];
    for (const [, rows] of byA) {
      rows.sort((x, y) => Number(y.lift) - Number(x.lift));
      affInserts.push(...rows.slice(0, TOP_PER_A));
    }

    // ── escribir (refresh por tenant) ──
    await app.transaction(async (trx) => {
      await trx('intelligence.zone_demand').where({ tenant_id: T }).del();
      if (zoneInserts.length) await trx.batchInsert('intelligence.zone_demand', zoneInserts, 1000);
      await trx('intelligence.product_affinity').where({ tenant_id: T }).del();
      if (affInserts.length) await trx.batchInsert('intelligence.product_affinity', affInserts, 1000);
    });
    console.log(`zone_demand: ${zoneInserts.length} filas (${byZona.size} zonas)`);
    console.log(`product_affinity: ${affInserts.length} filas dirigidas`);
    console.log('OK.');
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await erp.destroy();
    await app.destroy();
  }
})();
