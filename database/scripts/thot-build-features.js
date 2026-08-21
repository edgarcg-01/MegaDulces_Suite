/* eslint-disable no-console */
/**
 * Thot T.1 — construye el feature store de Thot:
 *   - intelligence.product_affinity : market-basket (tickets) → pares dirigidos A→B con lift.
 *   - intelligence.zone_demand      : demanda por zona (units/revenue/demand_index/rank).
 *
 * CANON.0.2 (2026-08-21) — REPUNTADO off `.245 Mega_Dulces` (era el ÚLTIMO lector de esa fuente).
 * Ahora lee TODO del mismo Postgres de prod (same-DB, sin egress externo):
 *   · affinity  ← `kepler_ods.kdm1`/`kdm2` (venta real U/D/10; basket = documento (suc,c4,c5,c6),
 *                 join verificado h.c1=d.c1 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6; sku=d.c8).
 *                 Ventana 180d, co>=15 (mismo umbral que la versión .245). Único uso del crudo ODS.
 *   · zone_demand ← prod-local `analytics.product_sales_monthly` (units por almacén×producto, ya
 *                 derivado de Kepler) + `zonaOf(code)` (mapa sucursal→ciudad, best-effort — el mapeo
 *                 cliente→zona real nunca existió; el peso de zona en el score es 0.5, opcional).
 *                 revenue = units × precio BASE-MXN (los lectores usan demand_index/rank, no revenue).
 *
 * Corre en el nightly (run-prod-feeds). DATABASE_URL_NEW debe apuntar a prod (tiene kepler_ods).
 *   node database/scripts/thot-build-features.js            # dry-run (cuenta + compara vs actual)
 *   node database/scripts/thot-build-features.js --apply    # refresca las 2 tablas (DELETE+INSERT/tenant)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const Knex = require('knex');

const T = '00000000-0000-0000-0000-00000000d01c';
const MIN_CO = 15; // mínimo de tickets compartidos para considerar un par
const TOP_PER_A = 25; // top afinidades por producto
const AFFINITY_DAYS = 365; // ventana del market-basket (1 año: cobertura ~= la histórica .245, aún fresca)
const ZONE_MONTHS = 12; // ventana de demanda por zona
const APPLY = process.argv.includes('--apply');

// Mapa sucursal(code de almacén) → ZONA (ciudad/plaza). Best-effort: reemplaza el `ventas.zona`
// enriquecido de .245 (que agrupaba por ciudad del cliente). Preserva EXACTO los strings de zona
// ya presentes en intelligence.zone_demand ('La Piedad'/'Morelia'/'Zamora'/'Yurecuaro'/'Desconocida')
// para no romper el match contra el ?zona= que pasa el caller. Derivado de commercial.warehouses.name:
//   02 La Piedad Abastos + 01 Padre Hidalgo (Santa Ana Pacueco, plaza La Piedad) + rutas 2x → La Piedad
//   03 8ESQ + 06 Canindo + MD-30/32 Morelia + rutas 50x (Canindo) → Morelia
//   04 Yurécuaro → Yurecuaro · 05 Zamora Centro → Zamora · 00 CEDIS / resto → Desconocida
function zonaOf(code) {
  const c = String(code || '').toUpperCase();
  if (c === '02' || c === '01' || c.startsWith('01-') || /^RUTA-2/.test(c)) return 'La Piedad';
  if (c === '03' || c === '06' || c === 'MD-30' || c === 'MD-32' || /^RUTA-(50|32)/.test(c)) return 'Morelia';
  if (c === '04') return 'Yurecuaro';
  if (c === '05') return 'Zamora';
  return 'Desconocida';
}

(async () => {
  const isLocal = /@(localhost|127\.0\.0\.1|192\.168\.|::1)/.test(process.env.DATABASE_URL_NEW || '');
  const app = Knex({
    client: 'pg',
    connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: isLocal ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });
  try {
    console.log(`\n=== Thot feature store (${APPLY ? 'APPLY' : 'DRY-RUN'}) — same-DB (kepler_ods + analytics) ===\n`);

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

    // ── ZONE DEMAND ← analytics.product_sales_monthly (prod-local) + precio BASE-MXN ──
    // units por (almacén→zona, producto) en los últimos ZONE_MONTHS meses. revenue = units × precio
    // base (proxy; los lectores usan demand_index/rank). El precio base sale de BASE-MXN si existe.
    const zrows = (
      await app.raw(
        `select w.code as wcode, psm.product_id, sum(psm.units)::numeric units,
                sum(psm.units * coalesce(pp.price, 0))::numeric revenue
           from analytics.product_sales_monthly psm
           join commercial.warehouses w on w.id = psm.warehouse_id and w.tenant_id = psm.tenant_id
           left join commercial.product_prices pp
             on pp.tenant_id = psm.tenant_id and pp.product_id = psm.product_id
            and pp.price_list_id = '00000000-0000-0000-0000-0000c0ffee02'
          where psm.tenant_id = ? and psm.month >= (date_trunc('month', current_date) - interval '${ZONE_MONTHS} months')
          group by w.code, psm.product_id`,
        [T],
      )
    ).rows;
    // Reagrupar por ZONA (varios almacenes caen en la misma zona) + rank + demand_index.
    const byZona = new Map();
    for (const r of zrows) {
      const zona = zonaOf(r.wcode);
      if (!byZona.has(zona)) byZona.set(zona, new Map());
      const m = byZona.get(zona);
      const prev = m.get(r.product_id) || { units: 0, revenue: 0 };
      prev.units += Number(r.units) || 0;
      prev.revenue += Number(r.revenue) || 0;
      m.set(r.product_id, prev);
    }
    const zoneInserts = [];
    for (const [zona, m] of byZona) {
      const arr = [...m.entries()].map(([pid, v]) => ({ pid, units: v.units, revenue: v.revenue }));
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
    console.log(`zone_demand: ${zoneInserts.length} filas (${byZona.size} zonas) desde product_sales_monthly`);

    // ── AFFINITY (market-basket) ← kepler_ods.kdm1/kdm2 (same-DB) ──
    console.log(`Computando market-basket ODS (${AFFINITY_DAYS}d, puede tardar)...`);
    await app.raw(`drop table if exists _bk`);
    // basket = documento de venta (suc,c4,c5,c6); línea = sku (d.c8). DISTINCT dedup multi-línea.
    await app.raw(`create temp table _bk as
      select distinct h.c1 as suc, h.c4, h.c5, h.c6, btrim(d.c8) as sku
        from kepler_ods.kdm2 d
        join kepler_ods.kdm1 h on h.c1=d.c1 and h.c4=d.c4 and h.c5=d.c5 and h.c6=d.c6
       where h.c2='U' and h.c3='D' and h.c4::text='10'
         and h.c9::date > current_date - ${AFFINITY_DAYS}
         and btrim(coalesce(d.c8,'')) <> ''`);
    await app.raw(`create index on _bk (suc,c4,c5,c6)`);
    const pairs = (
      await app.raw(
        `with total as (select count(*) n from (select distinct suc,c4,c5,c6 from _bk) t),
              freq  as (select sku, count(*) c from _bk group by sku),
              pr    as (select a.sku pa, b.sku pb, count(*) co
                          from _bk a join _bk b
                            on a.suc=b.suc and a.c4=b.c4 and a.c5=b.c5 and a.c6=b.c6
                           and a.sku < b.sku
                         group by 1,2 having count(*) >= ?)
         select pr.pa, pr.pb, pr.co, fa.c freq_a, fb.c freq_b, (select n from total) n
           from pr join freq fa on fa.sku=pr.pa join freq fb on fb.sku=pr.pb`,
        [MIN_CO],
      )
    ).rows;
    console.log(`pares con co>=${MIN_CO}: ${pairs.length}`);

    // expandir a dirigido A→B y B→A, mapear sku→product_id, top-N por A
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
    console.log(`product_affinity: ${affInserts.length} filas dirigidas`);

    if (!APPLY) {
      // Compara contra lo que hay hoy (parity check antes de aplicar).
      const cur = (await app.raw(
        `select (select count(*) from intelligence.zone_demand where tenant_id=?) zd,
                (select count(*) from intelligence.product_affinity where tenant_id=?) pa`, [T, T])).rows[0];
      console.log(`\n[DRY-RUN] actual: zone_demand=${cur.zd} product_affinity=${cur.pa} · nuevo: zone_demand=${zoneInserts.length} product_affinity=${affInserts.length}`);
      console.log('[DRY-RUN] nada escrito (usar --apply).');
      return;
    }

    // ── escribir (refresh por tenant) ──
    await app.transaction(async (trx) => {
      await trx('intelligence.zone_demand').where({ tenant_id: T }).del();
      if (zoneInserts.length) await trx.batchInsert('intelligence.zone_demand', zoneInserts, 1000);
      await trx('intelligence.product_affinity').where({ tenant_id: T }).del();
      if (affInserts.length) await trx.batchInsert('intelligence.product_affinity', affInserts, 1000);
    });
    console.log(`\n[APPLY] OK — zone_demand: ${zoneInserts.length} · product_affinity: ${affInserts.length}`);
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
})();
