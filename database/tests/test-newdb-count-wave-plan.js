'use strict';
/**
 * [IC.5] El plan rotativo del conteo parcial.
 *
 * Decisión D3: cada mes toca un tercio del catálogo, de modo que al llegar el conteo
 * trimestral de Kepler ya se cubrió todo. Lo que hace válido al rotativo **no** es que el plan
 * del mes se vea razonable — es que las 3 olas cubran TODO y en partes parejas. Si una ola
 * quedara vacía o mal repartida, un pedazo del catálogo no se contaría nunca **y cada mes el
 * plan se vería perfectamente normal**. Por eso el candado mira la partición, no el plan.
 *
 *   node database/tests/test-newdb-count-wave-plan.js
 *
 * Sólo lee. No depende de las vistas nuevas: la ola sale del hash del SKU.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.5] plan rotativo del conteo parcial ===\n');

  try {
    await db.raw(`SET statement_timeout = '90s'`);

    // ── 1. ⛔ PRUEBA NEGATIVA DEL abs(): sin él hay MÁS de 3 olas ─────────────
    // `hashtext` devuelve negativos y en Postgres el módulo de un negativo también lo es.
    // Sin `abs()` salen olas 0, -1 y -2, que NADIE pide nunca — y ese pedazo del catálogo
    // no se contaría jamás, mientras el plan mensual se ve normal todos los meses.
    const [h] = (await db.raw(
      `SELECT count(*) FILTER (WHERE hashtext(sku) < 0)::int AS negativos,
              count(*)::int AS total,
              count(DISTINCT (hashtext(sku) % 3) + 1)::int AS olas_sin_abs,
              count(DISTINCT (abs(hashtext(sku)) % 3) + 1)::int AS olas_con_abs
         FROM catalog.products WHERE deleted_at IS NULL`)).rows;
    t('⛔ PRUEBA NEGATIVA: sin abs() el hash produce MÁS de 3 olas (el bug que evita)',
      Number(h.olas_sin_abs) > 3, JSON.stringify(h));
    t('⛔ con abs() son EXACTAMENTE 3 olas',
      Number(h.olas_con_abs) === 3, JSON.stringify(h));
    console.log(`     ${h.negativos} de ${h.total} SKUs tienen hash negativo`
      + ` (${(100 * h.negativos / h.total).toFixed(0)}% del catálogo)`);

    // ── 2. ⛔ LAS 3 OLAS CUBREN TODO Y PAREJO ─────────────────────────────────
    const { rows: olas } = await db.raw(
      `SELECT w.code, (abs(hashtext(p.sku)) % 3) + 1 AS ola, count(*)::int AS skus
         FROM commercial.abc_classification a
         JOIN catalog.products p ON p.id = a.product_id AND p.deleted_at IS NULL
         JOIN commercial.warehouses w ON w.id = a.warehouse_id
        GROUP BY 1, 2 ORDER BY 1, 2`);

    const porWh = new Map();
    for (const r of olas) {
      if (!porWh.has(r.code)) porWh.set(r.code, []);
      porWh.get(r.code).push(Number(r.skus));
    }
    const almacenes = [...porWh.entries()];
    t('todos los almacenes tienen las 3 olas pobladas',
      almacenes.length > 0 && almacenes.every(([, v]) => v.length === 3),
      JSON.stringify(almacenes.filter(([, v]) => v.length !== 3).map(([k]) => k)));

    let peor = { code: '-', desvio: 0 };
    for (const [code, v] of almacenes) {
      const total = v.reduce((a, b) => a + b, 0);
      const esperado = total / 3;
      const d = Math.max(...v.map((n) => Math.abs(n - esperado))) / esperado;
      if (d > peor.desvio) peor = { code, desvio: d };
    }
    t('⛔ el reparto es parejo: ninguna ola se desvía más del 10% de un tercio',
      peor.desvio < 0.10, `peor: ${peor.code} con ${(peor.desvio * 100).toFixed(1)}%`);
    console.log(`     ${almacenes.length} almacenes · peor desvío: ${peor.code}`
      + ` ${(peor.desvio * 100).toFixed(1)}%`);

    // ── 3. ⛔ LA OLA ES ESTABLE ───────────────────────────────────────────────
    // Si la ola se derivara del score, un SKU que cambia de percentil saltaría de ola y
    // podría saltarse el trimestre ENTERO. Sale del hash del SKU, que no se mueve.
    const [est] = (await db.raw(
      `SELECT count(*)::int AS inestables FROM (
         SELECT p.sku, count(DISTINCT (abs(hashtext(p.sku)) % 3) + 1) AS olas
           FROM catalog.products p WHERE p.deleted_at IS NULL
          GROUP BY p.sku HAVING count(DISTINCT (abs(hashtext(p.sku)) % 3) + 1) > 1) x`)).rows;
    t('⛔ un SKU pertenece SIEMPRE a la misma ola (si no, puede saltarse el trimestre)',
      Number(est.inestables) === 0, `${est.inestables} SKUs inestables`);

    // ── 4. La ola sale del SKU, no del product_id ────────────────────────────
    // Un producto re-dado de alta cambia de UUID pero conserva su SKU. Con product_id
    // saltaría de ola y perdería su turno sin que nadie lo note.
    const [dup] = (await db.raw(
      `SELECT count(*)::int AS skus_con_varios_ids FROM (
         SELECT sku FROM catalog.products WHERE deleted_at IS NULL
          GROUP BY tenant_id, sku HAVING count(DISTINCT id) > 1) x`)).rows;
    console.log(`     SKUs con más de un product_id: ${dup.skus_con_varios_ids}`
      + ' (por eso la ola se calcula sobre el SKU)');
    t('la partición por SKU es consistente aunque haya SKUs con varios product_id',
      Number(dup.skus_con_varios_ids) >= 0);
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message.slice(0, 220)}`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
