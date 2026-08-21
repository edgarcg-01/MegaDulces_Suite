/* eslint-disable no-console */
/**
 * Mayoreo REAL desde Kepler — `kepler_ods.kdpv_prod_util` → quiebres por cantidad.
 *
 * **DRY-RUN ÚNICAMENTE.** `--apply` bloqueado hasta que el diff esté aprobado.
 *
 * ── Qué es la fuente (decodificada 2026-08-21, prod) ────────────────────────
 *   c1 = SKU · c2 = PRESENTACIÓN · c3 = tier 0..3 · c4 = mínimo · c5 = máximo · c7 = precio
 *   7 sucursales (00–06), ~42k filas cada una, ~9,490 SKUs, 12 presentaciones.
 *   Los tramos son monótonos (23,140/23,194 pares bajan o quedan igual al subir
 *   el tier; los que suben son inofensivos: el resolver toma el mas barato aplicable).
 *
 * ── Reglas de consolidación (decisión Edgar 2026-08-21) ─────────────────────
 *   · Sucursal: **moda de retail 01–06**, CEDIS (00) solo como fallback — misma
 *     regla que `repoint-catalog-prices` para el precio base, porque el CEDIS
 *     cotiza mayoreo más alto. 40,840/42,416 combos son idénticos en las 7; los
 *     1,576 que difieren promedian 12.33% de diferencia.
 *   · Presentación: se convierte a la unidad base con la escalera de `kdii`
 *     (abajo). Todo sale del ODS; nada se adivina ni se toma de fuentes .245.
 *
 * ── Unidad: la escalera de `kdii` ──────────────────────────────────────────
 *   `c4` vale 3/6/10 igual para PZA, PAQ y CJA → el mínimo está en unidades de
 *   ESA presentación. La equivalencia vive en `kepler_ods.kdii`, que trae una
 *   escalera de unidades por SKU:
 *
 *     c11        unidad BASE (la que se cobra)          factor 1
 *     c80 / c81  unidad alterna 1 + equivalencia en c11  ej. CJA = 20 PAQ
 *     c83 / c84  unidad alterna 2 + equivalencia en c11  ej. CJA = 96 PZA
 *
 *   Convierte: `precio_base = c7 / factor` y `minimo_base = c4 * factor`.
 *   Resuelve **17,209 de 18,402** combos SKU×presentación (93.5%); 1,193 quedan
 *   sin equivalencia y se REPORTAN, no se adivinan.
 *
 *   Verificado contra la propia data:
 *     · `catalog.products.factor_sale` YA sale de esta escalera (5,731 = c81,
 *       1,615 = c84, solo 351 de otra parte) → es la misma verdad que ya usamos.
 *     · `precio_alterna ≈ precio_base × factor` en 9,940 de 17,904 pares al 2%,
 *       ratio promedio **0.9658**: la presentación grande sale ~3.4% más barata
 *       por unidad. Eso ES el mayoreo, no un error de captura.
 *     · El intento anterior fallaba por usar `factor_sale` (UN factor por
 *       producto) para DOS presentaciones distintas → ratio 3.62. Con la
 *       escalera cada presentación trae el suyo.
 *
 *   La unidad operativa es `c11`, no la pieza: el precio que ya cobramos
 *   (BASE-MXN ← `kdii.c90`) cuadra con el tier base en unidad `c11` (ratio
 *   1.0502 = margen mostrador) y NO cuadra dividido por el factor (266 de
 *   7,855). `catalog.products.unit_sale` dice PZA donde Kepler dice PAQ en
 *   5,906 de 8,708 productos: está mal etiquetado, pero no cambia lo que se
 *   cobra — por eso la conversión va a `c11` y no a `unit_sale`.
 *
 *   node database/importers/kepler/import-volume-tiers.js            # dry-run
 *   node database/importers/kepler/import-volume-tiers.js --json     # + JSON
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DB = process.env.DATABASE_URL_NEW || process.env.DST_URL;
const JSON_OUT = process.argv.includes('--json');
const QTYS = [1, 3, 6, 10, 50];

if (process.argv.includes('--apply')) {
  console.error(
    '❌ --apply bloqueado: falta el OK sobre el diff. La unidad ya está resuelta (escalera kdii),\n' +
      '   pero esto cambia lo que se le cobra al cliente — se aplica cuando el diff esté aprobado.',
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
const num = (n) => Number(n).toLocaleString('es-MX');

/** Tiers convertidos a la unidad base, deduplicados: por cada mínimo, el más barato. */
function normalize(rows) {
  const best = new Map();
  for (const r of rows) {
    const min = Math.max(1, Math.round(Number(r.min_unit)));
    const price = Number(r.price_unit);
    const prev = best.get(min);
    if (!prev || price < Number(prev.price)) best.set(min, { ...r, min_qty: min, price });
  }
  return [...best.values()].sort((a, b) => a.min_qty - b.min_qty);
}

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

    const SRC = `
      WITH ladder AS (
        SELECT btrim(c1) AS sku,
               mode() WITHIN GROUP (ORDER BY btrim(c11)) AS u_base,
               mode() WITHIN GROUP (ORDER BY btrim(c80)) AS u_alt1,
               mode() WITHIN GROUP (ORDER BY c81)        AS f_alt1,
               mode() WITHIN GROUP (ORDER BY btrim(c83)) AS u_alt2,
               mode() WITHIN GROUP (ORDER BY c84)        AS f_alt2
          FROM kepler_ods.kdii WHERE sucursal <> '00' GROUP BY 1
      ), retail AS (
        SELECT btrim(c1) AS sku, btrim(c2) AS present, c3::int AS tier,
               mode() WITHIN GROUP (ORDER BY c7::numeric) AS price,
               mode() WITHIN GROUP (ORDER BY c4::numeric) AS min_qty
          FROM kepler_ods.kdpv_prod_util WHERE sucursal <> '00' GROUP BY 1,2,3
      ), cedis AS (
        SELECT btrim(c1) AS sku, btrim(c2) AS present, c3::int AS tier,
               c7::numeric AS price, c4::numeric AS min_qty
          FROM kepler_ods.kdpv_prod_util WHERE sucursal = '00'
      ), src AS (
        SELECT sku, present, tier, price, min_qty, 'retail' AS origen FROM retail
        UNION ALL
        SELECT k.sku, k.present, k.tier, k.price, k.min_qty, 'cedis' FROM cedis k
         WHERE NOT EXISTS (SELECT 1 FROM retail r
                            WHERE r.sku = k.sku AND r.present = k.present AND r.tier = k.tier)
      ), conv AS (
        SELECT s.*, l.u_base,
               CASE WHEN s.present = l.u_base                    THEN 1
                    WHEN s.present = l.u_alt1 AND l.f_alt1 > 0   THEN l.f_alt1
                    WHEN s.present = l.u_alt2 AND l.f_alt2 > 0   THEN l.f_alt2 END AS factor
          FROM src s JOIN ladder l ON l.sku = s.sku
      )`;

    const src = (
      await c.query(
        `${SRC}
         SELECT p.id AS product_id, p.sku, p.nombre, COALESCE(p.sales_units_30d,0)::int AS rot,
                v.present, v.u_base, v.tier, v.origen, v.factor,
                (v.price / v.factor)     AS price_unit,
                (v.min_qty * v.factor)   AS min_unit
           FROM conv v
           JOIN catalog.products p ON btrim(p.sku) = v.sku AND p.deleted_at IS NULL
          WHERE v.factor IS NOT NULL AND v.price > 0`,
      )
    ).rows;

    const gap = (
      await c.query(
        `${SRC} SELECT count(*)::int sin_equiv, count(DISTINCT sku)::int skus FROM conv WHERE factor IS NULL`,
      )
    ).rows[0];

    const cur = (
      await c.query(
        `SELECT pp.product_id, pp.price, pp.min_qty, pl.code
           FROM commercial.product_prices pp
           JOIN commercial.price_lists pl ON pl.id = pp.price_list_id
          WHERE pp.tenant_id = $1 AND pp.deleted_at IS NULL`,
        [M],
      )
    ).rows;

    const raw = new Map();
    for (const r of src) {
      if (!raw.has(r.product_id)) raw.set(r.product_id, []);
      raw.get(r.product_id).push(r);
    }
    const byProdNew = new Map();
    for (const [pid, rows] of raw) byProdNew.set(pid, normalize(rows));

    const byProdCur = new Map();
    for (const r of cur) {
      if (!byProdCur.has(r.product_id)) byProdCur.set(r.product_id, []);
      byProdCur.get(r.product_id).push(r);
    }

    const orig = src.reduce((m, r) => ((m[r.origen] = (m[r.origen] || 0) + 1), m), {});
    const viaBase = src.filter((r) => Number(r.factor) === 1).length;
    console.log(`Candidatos:        ${num(byProdNew.size)} productos · ${num(src.length)} filas → ${num([...byProdNew.values()].reduce((a, t) => a + t.length, 0))} tiers tras dedupe`);
    console.log(`Conversión:        ${num(viaBase)} en unidad base (factor 1) · ${num(src.length - viaBase)} convertidos por la escalera`);
    console.log(`Origen del tier:   retail ${num(orig.retail || 0)} · CEDIS fallback ${num(orig.cedis || 0)}`);
    console.log(`Sin equivalencia:  ${num(gap.sin_equiv)} filas · ${num(gap.skus)} SKUs (se descartan, no se adivinan)`);
    console.log(`Con precio hoy:    ${num(byProdCur.size)} productos · ${num(cur.length)} filas`);

    let noMono = 0;
    for (const tiers of byProdNew.values())
      for (let i = 1; i < tiers.length; i++) if (Number(tiers[i].price) > Number(tiers[i - 1].price)) noMono++;
    console.log(`No monotonos:      ${noMono} escalones cuyo precio sube al subir el minimo`);
    console.log('                   (inofensivo: el resolver toma el mas barato aplicable, ese escalon nunca gana)');

    // Corte anti-outlier: hay SKUs de servicio con rotacion imposible (99997
    // ETIQUETAS CODIGO DE BARRAS = 106,425,000 u/30d) que por si solos deciden
    // cualquier promedio ponderado. Se reporta con y sin ellos.
    const rots = [...byProdNew.values()].map((t) => Number(t[0].rot) || 0).sort((a, b) => a - b);
    const ROT_CAP = rots.length ? rots[Math.floor(rots.length * 0.999)] : Infinity;
    console.log(`Corte rotacion:    p99.9 = ${num(ROT_CAP)} u/30d (arriba de eso sale del ponderado)`);

    console.log('  qty   comparables      baja      sube     igual   sin precio hoy   d prom   d pond.   d pond. s/outlier');
    const detalle = [];
    for (const qty of QTYS) {
      let comparables = 0, baja = 0, sube = 0, igual = 0, nuevos = 0, sumPct = 0, sumRot = 0, sumRotPct = 0;
      let trimRot = 0, trimRotPct = 0;
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
        if (rot <= ROT_CAP) { trimRot += rot; trimRotPct += rot * d; }
        if (Math.abs(d) < 0.01) igual++;
        else if (n < o) baja++;
        else sube++;
      }
      const avg = comparables ? sumPct / comparables : 0;
      const wavg = sumRot ? sumRotPct / sumRot : 0;
      const twavg = trimRot ? trimRotPct / trimRot : 0;
      console.log(
        `  ${String(qty).padStart(3)}   ${String(comparables).padStart(11)}   ${String(baja).padStart(7)}   ${String(sube).padStart(7)}   ${String(igual).padStart(7)}   ${String(nuevos).padStart(14)}   ${pct(avg).padStart(6)}   ${pct(wavg).padStart(9)}   ${pct(twavg).padStart(13)}`,
      );
      detalle.push({ qty, comparables, baja, sube, igual, nuevos, delta_prom: avg, delta_ponderado: wavg, delta_ponderado_trim: twavg });
    }

    // ── Lo que hoy no existe: una escalera de verdad ────────────────────────
    let conEscalera = 0, sinEscaleraHoy = 0, sumDesc = 0;
    for (const [pid, tiers] of byProdNew) {
      const p1 = resolve(tiers, 1), p50 = resolve(tiers, 50);
      if (!p50) continue;
      const base1 = p1 ? Number(p1.price) : (byProdCur.has(pid) ? Number(resolve(byProdCur.get(pid), 1)?.price ?? NaN) : NaN);
      if (!isFinite(base1)) continue;
      if (Number(p50.price) < base1) { conEscalera++; sumDesc += ((base1 - Number(p50.price)) / base1) * 100; }
      const cd = byProdCur.get(pid);
      if (cd) {
        const c1 = resolve(cd, 1), c50 = resolve(cd, 50);
        if (c1 && c50 && Number(c50.price) >= Number(c1.price)) sinEscaleraHoy++;
      }
    }
    console.log('\n── Escalera de volumen ──\n');
    console.log(`  Hoy sin descuento por cantidad:  ${num(sinEscaleraHoy)} productos (el más barato ya aplica desde 1)`);
    console.log(`  Con kdpv tendrían descuento:     ${num(conEscalera)} productos · ${(conEscalera ? sumDesc / conEscalera : 0).toFixed(1)}% promedio a qty 50`);

    // Quien mueve el promedio ponderado (rotacion x delta) a una qty dada.
    const drv = (process.argv.find((a) => a.startsWith('--drivers=')) || '').split('=')[1];
    if (drv) {
      const qty = Number(drv);
      const rows = [];
      let sumRot = 0;
      for (const [pid, tiers] of byProdNew) {
        const nw = resolve(tiers, qty);
        const cd = byProdCur.get(pid);
        const old2 = cd ? resolve(cd, qty) : null;
        if (!nw || !old2) continue;
        const o = Number(old2.price), n = Number(nw.price);
        const rot = Number(tiers[0].rot) || 0;
        sumRot += rot;
        rows.push({ sku: tiers[0].sku, nombre: tiers[0].nombre, rot, o, n, d: ((n - o) / o) * 100, min: nw.min_qty, lista: old2.code });
      }
      rows.sort((a, b) => Math.abs(b.rot * b.d) - Math.abs(a.rot * a.d));
      console.log(`
-- Quien mueve el ponderado a qty=${qty} (suma rotacion ${num(sumRot)}) --
`);
      for (const r of rows.slice(0, 12)) {
        console.log(
          `  ${String(r.rot).padStart(7)} u/30d  ${r.sku}  ${(r.nombre || '').slice(0, 30).padEnd(30)} hoy ${money(r.o).padStart(9)} (${String(r.lista).padEnd(9)}) -> ${money(r.n).padStart(9)} min ${String(r.min).padStart(4)}  ${pct(r.d).padStart(8)}  aporta ${((r.rot * r.d) / sumRot).toFixed(1)} pp`,
        );
      }
    }

    console.log('\n── Top 10 por rotación con cambio a qty=10 ──\n');
    const impact = [];
    for (const [pid, tiers] of byProdNew) {
      const nw = resolve(tiers, 10);
      const cd = byProdCur.get(pid);
      const old = cd ? resolve(cd, 10) : null;
      if (!nw || !old) continue;
      const o = Number(old.price), n = Number(nw.price);
      if (Math.abs(n - o) < 0.01) continue;
      impact.push({ nombre: tiers[0].nombre, sku: tiers[0].sku, u: tiers[0].u_base, rot: Number(tiers[0].rot) || 0, old: o, nuevo: n, lista: old.code, d: ((n - o) / o) * 100 });
    }
    impact.sort((a, b) => b.rot - a.rot);
    for (const r of impact.slice(0, 10)) {
      console.log(
        `  ${String(r.rot).padStart(6)} u/30d  ${r.sku}  ${(r.nombre || '').slice(0, 36).padEnd(36)} ${String(r.u).padEnd(4)} hoy ${money(r.old).padStart(9)} (${r.lista})  →  ${money(r.nuevo).padStart(9)}  ${pct(r.d)}`,
      );
    }

    console.log('\n  NADA se escribió. --apply se habilita cuando el diff esté aprobado.\n');
    if (JSON_OUT)
      console.log('\nJSON', JSON.stringify({ candidatos: byProdNew.size, filas: src.length, sinEquiv: gap, noMono, detalle, conEscalera, sinEscaleraHoy }, null, 2));
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
