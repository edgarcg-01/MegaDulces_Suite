/* eslint-disable no-console */
/**
 * CANDADO — /comercial/pricing: el costo con que se juzga un precio (PR.2).
 *
 * Edgar, 2026-09-14: *"ahora /comercial/pricing"*.
 *
 * ── El veredicto de la revisión: esta pantalla está SANA, y el candado existe para que no la
 *    "arreglen" ──────────────────────────────────────────────────────────────────────────────
 *
 * `/comercial/pricing` publica **Costo**, **Margen** y las alarmas `below_cost` / `thin` / `no_cost`
 * a partir de `catalog.products.cost_base`. En `/comercial/products` se midió que ese campo difiere
 * del árbitro (`analytics.v_erp_unit_cost`) en **5,382 de 11,239 productos (48%)**, así que la
 * conclusión obvia era cambiarle la fuente.
 *
 * ⛔ **Sería un error, y está medido.** La divergencia está DOMINADA por la unidad, no por el costo:
 *
 * ```text
 *   productos sin alarma hoy que el árbitro marcaría bajo costo ...... 534
 *     de esos, TRAMPA DE UNIDAD (árbitro > 3x el catálogo) ........... 488
 *     conmensurables ................................................  46
 *
 *   los "peores" del listado crudo eran todos granel o multipack:
 *     95751 PISTACHO CRUDO 10KG   catálogo $230.00   árbitro $2,300.00  = 10x
 *     18022 CAJETA ENVINADA 25KG  catálogo $ 38.28   árbitro $1,963.58  = 51x
 *     92130 CONTENEDOR 8X8 /100   catálogo $ 67.01   árbitro $  184.27  (el /100 del nombre)
 * ```
 *
 * Es el mismo hueco que VA.4 ya declaró como `costo_arbitro_no_conmensurable_reabasto`: el árbitro
 * está en la unidad NATIVA del almacén y el precio de lista está por unidad de venta. Cambiar la
 * fuente de la alarma habría producido **488 falsos positivos**.
 *
 * ── Y lo que queda cuando se compara peras con peras ────────────────────────────────────────
 *
 * Apretando a la banda donde los dos costos SÍ comparten unidad (razón 0.80–1.25):
 *
 * ```text
 *   productos conmensurables ................................ 8,073
 *   bajo costo según el árbitro .............................   108
 *   que la pantalla NO ve hoy ...............................     3   (margen -0.8%, -0.1%, 0.0%)
 *   falsas alarmas de hoy (dice bajo costo y el árbitro no) ..    13
 * ```
 *
 * Tres casos invisibles sobre 8,073, todos rozando el costo. La alarma **funciona**.
 *
 * ⛔ Este candado NO mide si `cost_base` es el costo "correcto" — mide si la alarma que se construye
 * con él coincide con el árbitro DONDE SON COMPARABLES. Son preguntas distintas.
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

// Baselines MEDIDOS contra prod el 2026-09-14.
const MAX_INVISIBLES = 25;   // medido: 3
const MAX_FALSAS = 60;       // medido: 13

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n ?? 0).toLocaleString('en-US');

const BASE = `
  WITH arb AS (
    SELECT product_id,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_unitario)::numeric, 4) AS a
      FROM analytics.v_erp_unit_cost WHERE tenant_id = $1 AND costo_unitario > 0 GROUP BY 1),
  x AS (
    SELECT p.sku, pp.price, p.cost_base::numeric AS cb, arb.a,
           CASE WHEN p.cost_base::numeric > 0 THEN arb.a / p.cost_base::numeric END AS razon
      FROM commercial.product_prices pp
      JOIN commercial.price_lists pl
        ON pl.id = pp.price_list_id AND pl.tenant_id = pp.tenant_id AND pl.code = 'BASE-MXN'
      JOIN catalog.products p
        ON p.id = pp.product_id AND p.tenant_id = pp.tenant_id AND p.deleted_at IS NULL
      LEFT JOIN arb ON arb.product_id = p.id
     WHERE pp.tenant_id = $1 AND pp.deleted_at IS NULL AND pp.price > 0.05)`;

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '600s'`);
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  console.log('\n=== CANDADO: /comercial/pricing — el costo que juzga el precio (PR.2) ===\n');

  if (!(await q(`SELECT to_regclass('analytics.v_erp_unit_cost') t`))[0].t) {
    nomedido('todo el candado', 'analytics.v_erp_unit_cost no existe en esta DB');
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(0);
  }

  // ── 1. ⭐⭐ La alarma coincide con el árbitro DONDE SON COMPARABLES ────────────────────────
  console.log('── 1. ⭐⭐ `below_cost` contra el árbitro, sólo en lo conmensurable ──');
  const [a] = await q(`${BASE}
    SELECT count(*) FILTER (WHERE razon BETWEEN 0.80 AND 1.25)::int AS conmensurables,
           count(*) FILTER (WHERE razon BETWEEN 0.80 AND 1.25 AND price < a)::int AS bajo_costo,
           count(*) FILTER (WHERE razon BETWEEN 0.80 AND 1.25 AND price < a
                              AND NOT (cb > 0 AND price < cb))::int AS invisibles,
           count(*) FILTER (WHERE razon BETWEEN 0.80 AND 1.25 AND cb > 0 AND price < cb
                              AND NOT price < a)::int AS falsas
      FROM x`, [T]);
  console.log(`     ${N(a.conmensurables)} conmensurables · bajo costo ${N(a.bajo_costo)}`
    + ` · INVISIBLES para la pantalla ${N(a.invisibles)} · falsas alarmas ${N(a.falsas)}`);
  check('⭐⭐ la alarma no deja pasar productos vendidos bajo costo',
    Number(a.invisibles) <= MAX_INVISIBLES,
    `${N(a.invisibles)} invisibles contra un baseline de ${MAX_INVISIBLES}`);
  check('y no grita en falso más de lo medido',
    Number(a.falsas) <= MAX_FALSAS,
    `${N(a.falsas)} falsas alarmas contra ${MAX_FALSAS}`);

  // ── 2. ⛔ LA TRAMPA: por qué NO se cambia la fuente del costo ─────────────────────────────
  console.log('\n── 2. ⛔ Por qué NO se cambia `cost_base` por el árbitro ──');
  const [t] = await q(`${BASE}
    SELECT count(*) FILTER (WHERE razon > 3)::int AS trampa_unidad,
           count(*) FILTER (WHERE razon IS NOT NULL)::int AS con_razon,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY razon)::numeric, 3) AS mediana
      FROM x`, [T]);
  console.log(`     razón árbitro/catálogo: mediana ${t.mediana} sobre ${N(t.con_razon)} productos`
    + ` · con razón > 3x (unidad cruzada): ${N(t.trampa_unidad)}`);
  check('⭐ la razón mediana sigue pegada a 1: los dos costos SON el mismo, salvo por la unidad',
    Math.abs(Number(t.mediana) - 1) <= 0.10,
    `mediana ${t.mediana}. Si se despega, o el árbitro cambió de unidad o el catálogo dejó de `
    + 'seguirlo, y la comparación de este candado deja de significar lo que dice');
  check('⛔ y la trampa de unidad SIGUE EXISTIENDO (por eso no se cambia la fuente)',
    Number(t.trampa_unidad) > 50,
    `sólo ${N(t.trampa_unidad)} productos con razón > 3x. Si de verdad bajó a cero, la unidad se `
    + 'volvió conmensurable y ENTONCES sí conviene cablear el árbitro a la alarma — pero eso se '
    + 'decide con un antes/después del conteo de alarmas, no cambiando el campo y viendo qué pasa');

  // ── 3. Los escalones de volumen ──────────────────────────────────────────────────────────
  console.log('\n── 3. Los escalones de volumen que publica la pantalla ──');
  const [v] = await q(`
    WITH t AS (
      SELECT product_id, min_qty, price,
             min(price) OVER (PARTITION BY product_id ORDER BY min_qty
                              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS mejor_previo
        FROM analytics.product_volume_tiers WHERE tenant_id = $1)
    SELECT count(*)::int AS escalones,
           count(*) FILTER (WHERE min_qty <= 1)::int AS umbral_invalido,
           count(*) FILTER (WHERE price <= 0)::int AS precio_cero,
           count(*) FILTER (WHERE mejor_previo IS NOT NULL AND price >= mejor_previo)::int AS redundantes
      FROM t`, [T]);
  console.log(`     ${N(v.escalones)} escalones · umbral <= 1: ${N(v.umbral_invalido)}`
    + ` · precio 0: ${N(v.precio_cero)} · redundantes: ${N(v.redundantes)}`);
  check('ningún escalón con umbral <= 1 (sería el precio normal con otro nombre)',
    Number(v.umbral_invalido) === 0, `${N(v.umbral_invalido)}`);
  check('ningún escalón en cero', Number(v.precio_cero) === 0, `${N(v.precio_cero)}`);

  // ── 4. ⚠️ Lo que esta pantalla SÍ colapsa, declarado ──────────────────────────────────────
  console.log('\n── 4. ⚠️ Lo que esta pantalla colapsa y no declara ──');
  const [p] = await q(`
    WITH t AS (
      SELECT btrim(c1) AS sku, btrim(c2) AS present, c3::int AS tier,
             count(DISTINCT c7)::int AS n, min(c7::numeric) mn, max(c7::numeric) mx
        FROM kepler_ods.kdpv_prod_util WHERE btrim(sucursal::text) <> '00'
       GROUP BY 1, 2, 3)
    SELECT count(*)::int AS grupos, count(*) FILTER (WHERE n > 1)::int AS difieren,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (mx - mn) / NULLIF(mn, 0))
                 FILTER (WHERE n > 1)::numeric * 100, 1) AS brecha_mediana_pct
      FROM t`);
  console.log(`     ${N(p.difieren)} de ${N(p.grupos)} grupos (sku × presentación × escalón) tienen`);
  console.log(`     PRECIO DISTINTO entre plazas (brecha mediana ${p.brecha_mediana_pct}%), y`);
  console.log('     `analytics.product_volume_tiers` publica una MODA sin decirlo. Es el mismo');
  console.log('     defecto que NORM.3 le quitó a la etiqueta el 2026-09-11 y que acá sigue.');
  console.log('     ⬜ DECLARADO, no FAIL: arreglarlo es cambiar el grano de la vista, y sus');
  console.log('        consumidores esperan grano producto. Pide su propia medición.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
