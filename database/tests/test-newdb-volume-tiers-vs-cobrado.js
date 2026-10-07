/**
 * `[PV.1]` — **El mayoreo que publicamos contra el que Kepler COBRA.**
 *
 * ── Por qué este candado y no el que ya había ───────────────────────────────────────────────
 * `test-newdb-fiq3-volume-pricing.js` dice textualmente que "replica EXACTAMENTE la selección
 * que hace `resolvePriceForQty`" y afirma que lo correcto es "el MEJOR (menor) tier". Compara
 * **nuestro SQL contra nuestro JS**: dos implementaciones de la misma regla, las dos de acuerdo,
 * las dos equivocadas. Estuvo verde todo el tiempo que la app cobró 23 % por debajo de Kepler.
 *
 * ⭐ Un candado que verifica una regla contra sí misma no es un candado. Éste arbitra contra
 * **dos testigos independientes**: el nivel 0 de la propia ficha de Kepler, y lo que de verdad
 * se le cobró a un cliente (`analytics.erp_sales_invoice_lines`).
 *
 * ── Lo que bloquea ──────────────────────────────────────────────────────────────────────────
 *  1. Publicar un precio de mayoreo **por debajo del nivel 0** de Kepler (regalar precio).
 *  2. Una escalera **no monótona**: que comprar más salga más caro.
 *  3. Publicar mayoreo **por debajo del costo de la ficha**.
 *  4. Que el caso canónico (SKU 83652) vuelva a publicar el nivel profundo.
 *
 * ⚠️ El bloque 5 es la **prueba negativa**: reconstruye la regla vieja (`min()` sobre todos los
 * niveles) y exige que SÍ dispare. Un candado que no se pone rojo ante el defecto que existe
 * para atrapar es una intención, no una compuerta.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

let fail = 0;
let nomedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚪ NO MEDIDO — ${m}`); nomedido++; };
const V = 'analytics.product_volume_tiers';
const L = 'analytics.erp_sales_invoice_lines';
const SKU_CANONICO = '83652';

const existe = async (rel) =>
  (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [rel])).rows[0].hay;

(async () => {
  console.log('\n=== [PV.1] el mayoreo publicado contra el que Kepler cobra ===\n');

  console.log('0 · los objetos');
  const hayV = await existe(V);
  ok(hayV, `${V} existe`);
  if (!hayV) { console.log('\n⛔ sin la vista no hay nada que medir\n'); await knex.destroy(); process.exit(1); }
  const hayL = await existe(L);

  // ── 1 · Ningún quiebre por debajo del NIVEL 0 de Kepler ────────────────────────────────
  // El nivel 0 es el precio del cliente sin nivel asignado. Publicar menos que eso es regalar.
  console.log('\n1 · ningun quiebre por debajo del nivel 0 de Kepler');
  const bajoT0 = (await knex.raw(`
    WITH t0 AS (
      SELECT btrim(p.c1::text) AS sku, btrim(p.c2::text) AS present,
             mode() WITHIN GROUP (ORDER BY p.c7) AS price,
             mode() WITHIN GROUP (ORDER BY p.c4) AS min_qty
        FROM kepler_ods.kdpv_prod_util p
       WHERE btrim(p.sucursal) <> '00' AND p.c3::int = 0 AND p.c7 > 0
       GROUP BY 1, 2
    ), lad AS (
      SELECT btrim(k.c1) AS sku,
             mode() WITHIN GROUP (ORDER BY btrim(k.c11)) AS u_base,
             mode() WITHIN GROUP (ORDER BY btrim(k.c80)) AS u_alt1,
             mode() WITHIN GROUP (ORDER BY k.c81)        AS f_alt1,
             mode() WITHIN GROUP (ORDER BY btrim(k.c83)) AS u_alt2,
             mode() WITHIN GROUP (ORDER BY k.c84)        AS f_alt2
        FROM kepler_ods.kdii k WHERE btrim(k.sucursal) <> '00' GROUP BY 1
    ), base AS (
      SELECT t0.sku,
             GREATEST(1::numeric, round(t0.min_qty * f.factor))::int AS min_qty,
             min(round(t0.price / f.factor, 4)) AS piso
        FROM t0 JOIN lad l ON l.sku = t0.sku
        CROSS JOIN LATERAL (SELECT CASE
                 WHEN t0.present = l.u_base THEN 1::numeric
                 WHEN t0.present = l.u_alt1 AND l.f_alt1 > 0 THEN l.f_alt1
                 WHEN t0.present = l.u_alt2 AND l.f_alt2 > 0 THEN l.f_alt2 END AS factor) f
       WHERE f.factor IS NOT NULL AND f.factor > 0
       GROUP BY 1, 2
    )
    SELECT count(*)::int AS n
      FROM ${V} v
      JOIN catalog.products pr ON pr.id = v.product_id
      JOIN base b ON b.sku = btrim(pr.sku::text) AND b.min_qty = v.min_qty
     WHERE v.price < b.piso - 0.0001`)).rows[0];
  ok(Number(bajoT0.n) === 0,
     `0 quiebres por debajo del nivel 0 (medido: ${bajoT0.n})`);

  // ── 2 · La escalera baja, nunca sube ──────────────────────────────────────────────────
  console.log('\n2 · la escalera es monotona');
  const noMono = (await knex.raw(`
    SELECT count(*)::int AS n FROM (
      SELECT product_id, price,
             lag(price) OVER (PARTITION BY product_id ORDER BY min_qty) AS prev
        FROM ${V}) x
     WHERE prev IS NOT NULL AND price > prev + 0.0001`)).rows[0];
  ok(Number(noMono.n) === 0,
     `0 quiebres que SUBEN al subir la cantidad (medido: ${noMono.n})`);

  // ── 3 · Nada de mayoreo por debajo del costo de la ficha ──────────────────────────────
  // Comparacion BRUTA (el precio lleva impuesto y el costo no): es una cota floja a proposito,
  // asi que lo que cae aca esta MUY abajo, no al borde.
  console.log('\n3 · ningun quiebre por debajo del costo de la ficha');
  if (!(await existe('analytics.v_kepler_standard_cost'))) {
    nm('v_kepler_standard_cost no existe en esta DB');
  } else {
    const bajoCosto = (await knex.raw(`
      WITH c AS (
        SELECT btrim(sku) AS sku, max(costo_estandar) AS costo
          FROM analytics.v_kepler_standard_cost
         WHERE costo_estandar > 0 GROUP BY 1)
      SELECT count(*)::int AS n, count(DISTINCT c.sku)::int AS skus
        FROM ${V} v
        JOIN catalog.products pr ON pr.id = v.product_id
        JOIN c ON c.sku = btrim(pr.sku::text)
       WHERE v.price < c.costo`)).rows[0];
    ok(Number(bajoCosto.n) === 0,
       `0 quiebres bajo el costo de la ficha (medido: ${bajoCosto.n} en ${bajoCosto.skus} SKUs)`);
  }

  // ── 4 · El caso canonico, contra lo COBRADO ───────────────────────────────────────────
  console.log(`\n4 · el caso canonico (SKU ${SKU_CANONICO}) contra lo que se cobro`);
  const pub = (await knex.raw(`
    SELECT v.min_qty, v.price FROM ${V} v
      JOIN catalog.products pr ON pr.id = v.product_id
     WHERE btrim(pr.sku::text) = ? ORDER BY v.min_qty`, [SKU_CANONICO])).rows;
  if (pub.length === 0) {
    nm(`${SKU_CANONICO} no publica quiebres (puede ser correcto si no tiene nivel 0)`);
  } else {
    console.log('     publica: ' + pub.map((r) => `${r.min_qty}→$${Number(r.price).toFixed(2)}`).join('  '));
    ok(!pub.some((r) => Number(r.price) < 60),
       `ningun quiebre por debajo de $60 (los niveles profundos eran 58.26 / 56.58 / 54.66)`);

    if (!hayL) { nm('erp_sales_invoice_lines no existe: no hay con que arbitrar'); }
    else {
      const cobrado = (await knex.raw(`
        SELECT min(precio_unitario) AS minimo, max(precio_unitario) AS maximo, count(*)::int AS n
          FROM ${L} WHERE sku = ? AND precio_unitario > 0`, [SKU_CANONICO])).rows[0];
      if (!cobrado || Number(cobrado.n) === 0) { nm(`${SKU_CANONICO} sin ventas con que arbitrar`); }
      else {
        console.log(`     cobrado de verdad: $${Number(cobrado.minimo).toFixed(2)} a $${Number(cobrado.maximo).toFixed(2)} en ${cobrado.n} renglones`);
        const masBarato = Math.min(...pub.map((r) => Number(r.price)));
        ok(masBarato >= Number(cobrado.minimo) - 0.01,
           `el quiebre mas barato ($${masBarato.toFixed(2)}) no esta por debajo de lo menos que se cobro ($${Number(cobrado.minimo).toFixed(2)})`);
      }
    }
  }

  // ── 5 · PRUEBA NEGATIVA ───────────────────────────────────────────────────────────────
  // Se reconstruye la regla VIEJA (min() sobre TODOS los niveles) y se exige que dispare el
  // bloque 1. Si esto no encuentra nada, el candado no sirve: no distingue bien de mal.
  console.log('\n5 · prueba negativa — la regla vieja DEBE disparar');
  const vieja = (await knex.raw(`
    WITH todos AS (
      SELECT btrim(p.c1::text) AS sku, btrim(p.c2::text) AS present, p.c3::int AS tier,
             mode() WITHIN GROUP (ORDER BY p.c7) AS price,
             mode() WITHIN GROUP (ORDER BY p.c4) AS min_qty
        FROM kepler_ods.kdpv_prod_util p
       WHERE btrim(p.sucursal) <> '00' AND p.c7 > 0
       GROUP BY 1, 2, 3)
    SELECT count(*)::int AS n, count(DISTINCT sku)::int AS skus
      FROM (SELECT sku, present, min_qty, min(price) AS barato, max(price) AS t0
              FROM todos GROUP BY 1, 2, 3 HAVING count(DISTINCT tier) > 1) x
     WHERE barato < t0 - 0.0001`)).rows[0];
  ok(Number(vieja.n) > 0,
     `la regla vieja regalaba precio en ${vieja.n} combinaciones / ${vieja.skus} SKUs (debe ser > 0, si no el candado no prueba nada)`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${fail} fallas · ${nomedido} no medidos\n`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\n💥', e.message, '\n');
  await knex.destroy();
  process.exit(1);
});
