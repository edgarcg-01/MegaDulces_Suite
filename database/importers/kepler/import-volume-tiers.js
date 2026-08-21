/* eslint-disable no-console */
/**
 * Mayoreo REAL desde Kepler — `kepler_ods.kdpv_prod_util` → quiebres por cantidad.
 *
 * **DRY-RUN ÚNICAMENTE.** `--apply` está bloqueado a propósito: ver "Unidad" abajo.
 *
 * ── Qué es la fuente (decodificada 2026-08-21, prod) ────────────────────────
 *   c1 = SKU · c2 = PRESENTACIÓN · c3 = tier 0..3 · c4 = mínimo · c5 = máximo · c7 = precio
 *   7 sucursales (00–06), ~42k filas cada una, ~9,490 SKUs, 12 presentaciones.
 *   Los tramos son monótonos (23,140/23,194 pares bajan o quedan igual al subir
 *   el tier; 54 suben → esos el resolver los cobraría al revés).
 *
 * ── Reglas de consolidación (decisión Edgar 2026-08-21) ─────────────────────
 *   · Sucursal: **moda de retail 01–06**, CEDIS (00) solo como fallback — misma
 *     regla que `repoint-catalog-prices` para el precio base, porque el CEDIS
 *     cotiza mayoreo más alto. 40,840/42,416 combos son idénticos en las 7; los
 *     1,576 que difieren promedian 12.33% de diferencia.
 *   · Presentación: **solo la que es la unidad de venta del producto**
 *     (`c2 == unit_sale`, con KG↔KGS como alias). Nada de mezclar unidades.
 *
 * ── Unidad: por qué esto no puede aplicar todavía ───────────────────────────
 *   `c4` es 3/6/10 para PZA, PAQ y CJA por igual → el mínimo está en unidades de
 *   ESA presentación. Un tier "CJA min 3" son 3 cajas, y `order_lines.quantity`
 *   está en unidad de venta (PZA en 9,094 de 11,127 productos). Cargarlo crudo
 *   haría que pedir 3 PIEZAS active el precio de 3 CAJAS.
 *   Y la conversión no se puede derivar: de 1,087 pares (mismo SKU+tier con
 *   precio en PZA y en PAQ/CJA), solo **280 (26%)** cumplen
 *   `precio_PAQ ≈ precio_PZA × factor_sale`; el ratio promedio es 3.62, no el
 *   factor de caja. Por eso solo se carga la presentación que YA es la unidad de
 *   venta, y el resto queda reportado como hueco, no adivinado.
 *
 *   SRC/DST = la misma DB (kepler_ods vive en prod).
 *   node database/importers/kepler/import-volume-tiers.js            # dry-run
 *   node database/importers/kepler/import-volume-tiers.js --json     # + salida JSON
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DB = process.env.DATABASE_URL_NEW || process.env.DST_URL;
const JSON_OUT = process.argv.includes('--json');
const QTYS = [1, 3, 6, 10, 50];

if (process.argv.includes('--apply')) {
  console.error(
    '❌ --apply bloqueado. `c4` está en unidades de la presentación (3 CAJAS ≠ 3 piezas) y la\n' +
      '   conversión a pieza no se sostiene (solo 26% cuadra vs factor_sale). Aplicar así cobraría\n' +
      '   precio de volumen por cantidades que no lo ganaron. Decidir la unidad primero.',
  );
  process.exit(2);
}
if (!DB) {
  console.error('❌ falta DATABASE_URL_NEW (o DST_URL)');
  process.exit(1);
}

/** Misma regla que `resolvePriceForQty`: el precio MÁS BAJO con `min_qty <= qty`. */
function resolve(tiers, qty) {
  const applicable = tiers.filter((t) => Number(t.min_qty) <= qty);
  if (!applicable.length) return null;
  return applicable.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
}

const money = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

(async () => {
  const c = new Client({
    connectionString: DB,
    ssl: /rlwy|railway|proxy/i.test(DB) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000,
    statement_timeout: 300000,
  });
  await c.connect();
  try {
    console.log('\n=== Mayoreo kdpv_prod_util → quiebres por cantidad (DRY-RUN) ===\n');

    // ── Candidatos: moda retail 01–06, fallback CEDIS, solo unidad de venta ──
    const src = (
      await c.query(
        `WITH retail AS (
           SELECT btrim(c1) AS sku, c2 AS present, c3::int AS tier,
                  mode() WITHIN GROUP (ORDER BY c7::numeric) AS price,
                  mode() WITHIN GROUP (ORDER BY c4::numeric) AS min_qty,
                  mode() WITHIN GROUP (ORDER BY c5::numeric) AS max_qty
             FROM kepler_ods.kdpv_prod_util WHERE sucursal <> '00' GROUP BY 1,2,3
         ), cedis AS (
           SELECT btrim(c1) AS sku, c2 AS present, c3::int AS tier,
                  c7::numeric AS price, c4::numeric AS min_qty, c5::numeric AS max_qty
             FROM kepler_ods.kdpv_prod_util WHERE sucursal = '00'
         ), src AS (
           SELECT sku, present, tier, price, min_qty, max_qty, 'retail' AS origen FROM retail
           UNION ALL
           SELECT k.sku, k.present, k.tier, k.price, k.min_qty, k.max_qty, 'cedis'
             FROM cedis k
            WHERE NOT EXISTS (SELECT 1 FROM retail r
                               WHERE r.sku = k.sku AND r.present = k.present AND r.tier = k.tier)
         )
         SELECT p.id AS product_id, p.sku, p.nombre, p.unit_sale, p.factor_sale,
                COALESCE(p.sales_units_30d, 0)::int AS rot,
                s.present, s.tier, s.price, s.min_qty, s.max_qty, s.origen
           FROM src s
           JOIN catalog.products p ON btrim(p.sku) = s.sku AND p.deleted_at IS NULL
          WHERE s.price > 0
            AND (s.present = p.unit_sale OR (s.present = 'KG' AND p.unit_sale = 'KGS'))`,
      )
    ).rows;

    // ── Estado actual: lo que el resolver cobra hoy ──────────────────────────
    const cur = (
      await c.query(
        `SELECT pp.product_id, pp.price, pp.min_qty, pl.code
           FROM commercial.product_prices pp
           JOIN commercial.price_lists pl ON pl.id = pp.price_list_id
          WHERE pp.tenant_id = $1 AND pp.deleted_at IS NULL`,
        [M],
      )
    ).rows;

    // ── Universo y cobertura ────────────────────────────────────────────────
    const kdpvSkus = Number(
      (await c.query(`SELECT count(DISTINCT btrim(c1))::int n FROM kepler_ods.kdpv_prod_util`)).rows[0].n,
    );
    const catalogo = Number(
      (await c.query(`SELECT count(*)::int n FROM catalog.products WHERE deleted_at IS NULL AND tenant_id=$1`, [M]))
        .rows[0].n,
    );

    const byProdNew = new Map();
    for (const r of src) {
      if (!byProdNew.has(r.product_id)) byProdNew.set(r.product_id, []);
      byProdNew.get(r.product_id).push(r);
    }
    const byProdCur = new Map();
    for (const r of cur) {
      if (!byProdCur.has(r.product_id)) byProdCur.set(r.product_id, []);
      byProdCur.get(r.product_id).push(r);
    }

    console.log(`Catálogo activo:            ${catalogo.toLocaleString('es-MX')} productos`);
    console.log(`SKUs en kdpv_prod_util:     ${kdpvSkus.toLocaleString('es-MX')}`);
    console.log(`Candidatos con unidad OK:   ${byProdNew.size.toLocaleString('es-MX')} productos · ${src.length.toLocaleString('es-MX')} tiers`);
    console.log(`Con precio hoy:             ${byProdCur.size.toLocaleString('es-MX')} productos · ${cur.length.toLocaleString('es-MX')} filas`);
    const orig = src.reduce((m, r) => ((m[r.origen] = (m[r.origen] || 0) + 1), m), {});
    console.log(`Origen del tier:            retail ${orig.retail || 0} · CEDIS fallback ${orig.cedis || 0}`);

    // ── No monótonos: el resolver los cobraría al revés ─────────────────────
    let noMono = 0;
    for (const tiers of byProdNew.values()) {
      const ord = [...tiers].sort((a, b) => a.tier - b.tier);
      for (let i = 1; i < ord.length; i++) if (Number(ord[i].price) > Number(ord[i - 1].price)) noMono++;
    }
    console.log(`Tiers no monótonos:         ${noMono} (precio sube al subir el tier)`);

    // ── Diff por cantidad: qué cobraría el resolver antes vs después ────────
    console.log('\n── Qué cobraría el motor (mismo criterio: más barato con mínimo cumplido) ──\n');
    console.log('  qty   comparables      baja      sube     igual   nuevo(sin precio hoy)   Δ prom   Δ pond. rotación');
    const detalle = [];
    for (const qty of QTYS) {
      let comparables = 0, baja = 0, sube = 0, igual = 0, nuevos = 0;
      let sumPct = 0, sumRot = 0, sumRotPct = 0;
      for (const [pid, tiers] of byProdNew) {
        const nw = resolve(tiers, qty);
        if (!nw) continue;
        const cd = byProdCur.get(pid);
        const old = cd ? resolve(cd, qty) : null;
        if (!old) { nuevos++; continue; }
        comparables++;
        const o = Number(old.price), n = Number(nw.price);
        const d = ((n - o) / o) * 100;
        sumPct += d;
        const rot = Number(tiers[0].rot) || 0;
        sumRot += rot; sumRotPct += rot * d;
        if (Math.abs(d) < 0.01) igual++;
        else if (n < o) baja++;
        else sube++;
      }
      const avg = comparables ? sumPct / comparables : 0;
      const wavg = sumRot ? sumRotPct / sumRot : 0;
      console.log(
        `  ${String(qty).padStart(3)}   ${String(comparables).padStart(11)}   ${String(baja).padStart(7)}   ${String(sube).padStart(7)}   ${String(igual).padStart(7)}   ${String(nuevos).padStart(21)}   ${pct(avg).padStart(6)}   ${pct(wavg).padStart(17)}`,
      );
      detalle.push({ qty, comparables, baja, sube, igual, nuevos, delta_prom: avg, delta_ponderado: wavg });
    }

    // ── Los que más pesan: mayor rotación con cambio de precio a qty=10 ─────
    console.log('\n── Top 10 por rotación con cambio a qty=10 ──\n');
    const impact = [];
    for (const [pid, tiers] of byProdNew) {
      const nw = resolve(tiers, 10);
      const cd = byProdCur.get(pid);
      const old = cd ? resolve(cd, 10) : null;
      if (!nw || !old) continue;
      const o = Number(old.price), n = Number(nw.price);
      if (Math.abs(n - o) < 0.01) continue;
      impact.push({ nombre: tiers[0].nombre, sku: tiers[0].sku, unit: tiers[0].unit_sale, rot: Number(tiers[0].rot) || 0, old: o, nuevo: n, lista: old.code, d: ((n - o) / o) * 100 });
    }
    impact.sort((a, b) => b.rot - a.rot);
    for (const r of impact.slice(0, 10)) {
      console.log(
        `  ${String(r.rot).padStart(6)} u/30d  ${r.sku}  ${(r.nombre || '').slice(0, 38).padEnd(38)} ${r.unit}  hoy ${money(r.old).padStart(9)} (${r.lista})  →  ${money(r.nuevo).padStart(9)}  ${pct(r.d)}`,
      );
    }

    // ── El hueco: productos que hoy cobran mayoreo y kdpv no puede reemplazar ─
    let huecoProd = 0, huecoRot = 0;
    for (const [pid, tiers] of byProdCur) {
      const hoy = resolve(tiers, 10);
      const hoy1 = resolve(tiers, 1);
      const tieneQuiebre = hoy && hoy1 && Number(hoy.price) < Number(hoy1.price);
      if (tieneQuiebre && !byProdNew.has(pid)) huecoProd++;
    }
    console.log(`\n── Hueco ──\n`);
    console.log(`  ${huecoProd.toLocaleString('es-MX')} productos tienen quiebre por volumen HOY y kdpv no aporta uno en su unidad de venta.`);
    console.log(`  Se quedarían con los tiers congelados (fuente catalogo_etiquetas, sin feed) o sin quiebre si se limpian.`);
    console.log(`\n  NADA se escribió. --apply está bloqueado hasta resolver la unidad de la presentación.\n`);

    if (JSON_OUT) console.log('\nJSON', JSON.stringify({ catalogo, kdpvSkus, candidatos: byProdNew.size, tiers: src.length, noMono, detalle, hueco: huecoProd }, null, 2));
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
