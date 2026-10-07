/* eslint-disable no-console */
/**
 * `[ETQ.NIV.1]` — **La etiqueta de anaquel no publica el precio de un NIVEL DE CLIENTE.**
 *
 * `kepler_ods.kdpv_prod_util` tiene DOS ejes: `c2` = presentacion y **`c3` = nivel de precio del
 * cliente** (0 = mostrador, 1-3 = negociados). El CTE `esc` de `analytics.v_label_presentations`
 * agrupaba sin `c3`, aplastaba los cuatro niveles y publicaba el mas barato. El SKU 83652
 * imprimia "MAYOREO 3+ PAQUETES $58.26" donde el mostrador cobra $71.15.
 *
 * ⭐ Este candado NO compara la vista contra una copia de su propia regla — ese error ya costo
 * dinero una vez (`test-newdb-fiq3-volume-pricing.js` estuvo verde todo el tiempo que la app
 * cobraba 23 % por debajo de Kepler). Arbitra contra **dos testigos independientes**: el nivel 0
 * de la ficha del propio Kepler, y lo que de verdad se cobro (`erp_sales_invoice_lines`).
 *
 * El bloque 5 es la **PRUEBA NEGATIVA**: reconstruye la regla vieja y exige que SI dispare.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const V = 'analytics.v_label_presentations';
const L = 'analytics.erp_sales_invoice_lines';
const SKU = '83652';
const PROFUNDOS = [58.26, 56.58, 54.66]; // los niveles 1/2/3 del caso canonico

let fail = 0;
let nomedido = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  XX '} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  -- NO MEDIDO — ${m}`); nomedido++; };
const hay = async (rel) => (await knex.raw('SELECT to_regclass(?) IS NOT NULL AS h', [rel])).rows[0].h;

(async () => {
  console.log('\n=== [ETQ.NIV.1] el mayoreo de la etiqueta contra el nivel de mostrador ===\n');

  console.log('0 · la vista declara de que nivel salio el numero');
  if (!(await hay(V))) { console.log(`\nSIN ${V}: nada que medir\n`); await knex.destroy(); process.exit(1); }
  const cols = (await knex.raw(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'analytics' AND table_name = 'v_label_presentations'`
  )).rows.map((r) => r.column_name);
  const declara = cols.includes('mayoreo_nivel');
  ok(declara, `${V}.mayoreo_nivel existe (sin el, la migracion [ETQ.NIV.1] no esta aplicada)`);
  const vere = cols.includes('mayoreo_veredicto');

  // ── 1 · Nada publicado por debajo del nivel 0 de SU MISMA plaza ────────────────────────
  // Testigo: el propio Kepler. El piso NO le exige umbral al nivel 0 — 133 grupos lo tienen
  // solo con umbral <= 1 y ahi se colaba el nivel de cliente.
  console.log('\n1 · ninguna etiqueta por debajo del nivel 0 de su plaza');
  const bajo = (await knex.raw(`
    WITH piso AS (
      SELECT btrim(u.sucursal) AS sucursal, btrim(u.c1) AS sku, upper(btrim(u.c2::text)) AS unidad,
             max(u.c7::numeric) AS p0
        FROM kepler_ods.kdpv_prod_util u
       WHERE u.c7::numeric > 0 AND u.c3::int = 0
       GROUP BY 1, 2, 3)
    SELECT count(*)::int AS n, count(DISTINCT v.sku)::int AS skus
      FROM ${V} v
      JOIN piso p ON p.sucursal = v.sucursal AND p.sku = v.sku AND p.unidad = v.unidad
     WHERE v.mayoreo_precio IS NOT NULL AND v.mayoreo_precio < p.p0 - 0.0001`)).rows[0];
  ok(Number(bajo.n) === 0,
    `0 grupos por debajo del nivel 0 (medido: ${bajo.n} en ${bajo.skus} SKUs)`);

  // ── 2 · Dentro de un grupo no se mezclan niveles ───────────────────────────────────────
  // Si el precio publicado no es el del nivel que la vista declara, el grupo mezclo niveles.
  console.log('\n2 · el precio publicado es el del nivel que la vista declara');
  if (!declara) {
    nm('sin mayoreo_nivel no se puede comprobar la coherencia');
  } else {
    const mezcla = (await knex.raw(`
      WITH niv AS (
        SELECT btrim(u.sucursal) AS sucursal, btrim(u.c1) AS sku, upper(btrim(u.c2::text)) AS unidad,
               u.c3::int AS nivel,
               (array_agg(u.c7::numeric ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1] AS precio
          FROM kepler_ods.kdpv_prod_util u
         WHERE u.c7::numeric > 0 AND floor(u.c4::numeric)::int > 1
         GROUP BY 1, 2, 3, 4)
      SELECT count(*)::int AS n
        FROM ${V} v
        JOIN niv n ON n.sucursal = v.sucursal AND n.sku = v.sku AND n.unidad = v.unidad
                  AND n.nivel = v.mayoreo_nivel
       WHERE v.mayoreo_precio IS NOT NULL
         AND round(v.mayoreo_precio, 2) <> round(n.precio, 2)`)).rows[0];
    ok(Number(mezcla.n) === 0,
      `0 grupos cuyo precio no es el de su nivel declarado (medido: ${mezcla.n})`);
  }

  // ── 3 · El caso canonico, contra lo COBRADO ────────────────────────────────────────────
  console.log(`\n3 · el caso canonico (SKU ${SKU}) contra lo que se cobro`);
  const filas = (await knex.raw(`
    SELECT sucursal, unidad, mayoreo_precio
      FROM ${V} WHERE sku = ? AND mayoreo_precio IS NOT NULL
     ORDER BY sucursal, unidad`, [SKU])).rows;
  if (filas.length === 0) {
    nm(`${SKU} no publica mayoreo en ninguna plaza`);
  } else {
    const profundo = filas.filter((r) =>
      PROFUNDOS.some((p) => Math.abs(Number(r.mayoreo_precio) - p) < 0.01));
    ok(profundo.length === 0,
      `ninguna plaza publica un nivel profundo (${PROFUNDOS.join(' / ')}); medido: ${profundo.length}`);

    if (!(await hay(L))) {
      nm('erp_sales_invoice_lines no existe: sin arbitro de dinero');
    } else {
      const cob = (await knex.raw(`
        SELECT round(min(precio_unitario), 2) AS minimo, count(*)::int AS n
          FROM ${L} WHERE sku = ? AND precio_unitario > 0 AND cantidad >= 3`, [SKU])).rows[0];
      if (!cob || Number(cob.n) === 0) {
        nm(`${SKU} sin renglones de venta de 3 o mas`);
      } else {
        // La CJA del 83652 son 10 paquetes: se compara en la misma unidad que el cobro.
        const masBarato = Math.min(...filas.map((r) =>
          Number(r.mayoreo_precio) / (String(r.unidad).toUpperCase() === 'CJA' ? 10 : 1)));
        console.log(`     menos que se cobro con 3+: $${Number(cob.minimo).toFixed(2)} (${cob.n} renglones)`);
        ok(masBarato >= Number(cob.minimo) - 0.01,
          `el mayoreo mas barato por paquete ($${masBarato.toFixed(2)}) no queda por debajo de lo cobrado ($${Number(cob.minimo).toFixed(2)})`);
      }
    }
  }

  // ── 4 · Lo que no se puede defender se DECLARA, no se publica ──────────────────────────
  console.log('\n4 · lo frenado se declara con su propio veredicto');
  if (!vere) {
    nm('la vista no tiene mayoreo_veredicto');
  } else {
    const fre = (await knex.raw(`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE mayoreo_precio IS NOT NULL)::int AS con_precio
        FROM ${V} WHERE mayoreo_veredicto = 'bajo_nivel_publico'`)).rows[0];
    ok(Number(fre.con_precio) === 0,
      `ningun 'bajo_nivel_publico' trae precio (medido: ${fre.con_precio} de ${fre.n})`);
  }

  // ── 5 · PRUEBA NEGATIVA ────────────────────────────────────────────────────────────────
  // La regla vieja (agrupar SIN c3) tiene que seguir regalando precio sobre los datos de hoy.
  // Si no dispara, este candado no distingue bien de mal y no prueba nada.
  console.log('\n5 · prueba negativa — la regla vieja DEBE regalar precio');
  const vieja = (await knex.raw(`
    WITH niv AS (
      SELECT btrim(u.sucursal) AS sucursal, btrim(u.c1) AS sku, upper(btrim(u.c2::text)) AS unidad,
             u.c3::int AS nivel,
             (array_agg(u.c7::numeric ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1] AS precio,
             (array_agg(floor(u.c4::numeric)::int ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1] AS desde
        FROM kepler_ods.kdpv_prod_util u
       WHERE u.c7::numeric > 0 AND floor(u.c4::numeric)::int > 1
       GROUP BY 1, 2, 3, 4)
    SELECT count(*)::int AS n, count(DISTINCT sku)::int AS skus FROM (
      SELECT sucursal, sku, unidad,
             (array_agg(precio ORDER BY desde, precio))[1] AS vieja,
             max(precio) FILTER (WHERE nivel = 0)          AS n0
        FROM niv GROUP BY 1, 2, 3) x
     WHERE n0 IS NOT NULL AND vieja < n0 - 0.0001`)).rows[0];
  ok(Number(vieja.n) > 0,
    `la regla vieja regala precio en ${vieja.n} grupos / ${vieja.skus} SKUs (debe ser > 0)`);

  console.log(`\n${fail === 0 ? 'VERDE' : 'ROJO'} — ${fail} fallas · ${nomedido} no medidos\n`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\nFATAL', e.message, '\n');
  await knex.destroy();
  process.exit(1);
});
