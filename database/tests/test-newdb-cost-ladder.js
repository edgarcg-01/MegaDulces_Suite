/* eslint-disable no-console */
/**
 * RA-PRO.46 — CANDADO: el costo de caja se LEE de Kepler, no se calcula.
 *
 * El bug que este test existe para que no vuelva: `caja_cost` se reconstruía como
 * `costo_unitario × bf`, y fallaba por los dos lados —
 *   · multiplicador: bf no siempre está en el peldaño del costo (azúcar 99029: lo pagado en KG,
 *     bf=50 es el factor 500 g→costal → $798.57 por un costal de $415);
 *   · base: real_cost es el promedio ponderado de 90 d, o sea rezagado (cerillos 00303: compras
 *     reales $11.0793 clavado = $553.97 la caja, pero el promedio $11.3454 daba $567.27).
 * Kepler ya trae el dato — "Costo Uni Mayor" (`kdpv_prov_prod.c4`) ES el costo de la caja.
 * Ver docs/ERP_KEPLER.md §2.1 y §5 regla 0 (nunca adivinar la fuente).
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-cost-ladder.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log('\n=== RA-PRO.46 · el costo de caja se lee de Kepler ===\n');

  // ── 1. La vista existe, es VISTA (derivar-no-copiar) y expone el contrato ──────────────────
  const rel = (await c.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.v_supplier_cost_ladder')`)).rows[0];
  check('v_supplier_cost_ladder existe', !!rel);
  check('es VISTA, no tabla copiada', rel && rel.relkind === 'v', rel ? `relkind=${rel.relkind}` : 'ausente');

  const cols = (await c.query(`SELECT column_name FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='v_supplier_cost_ladder'`)).rows.map((r) => r.column_name);
  for (const col of ['sku', 'box_cost', 'u1_cost', 'u2_cost', 'u3_cost', 'u1_label', 'u2_label', 'u3_label', 'units_per_box']) {
    check(`expone ${col}`, cols.includes(col));
  }

  const lad = (await c.query(`SELECT count(*)::int n,
      count(*) FILTER (WHERE box_cost > 0)::int con_costo,
      count(*) FILTER (WHERE u1_label IS NOT NULL)::int con_rotulo,
      count(*) FILTER (WHERE box_cost < u1_cost)::int incoherentes
    FROM analytics.v_supplier_cost_ladder`)).rows[0];
  check('la escalera tiene SKUs', lad.n > 1000, `n=${lad.n}`);
  check('todos con costo de caja', lad.con_costo === lad.n, `${lad.con_costo}/${lad.n}`);
  check('la mayoría con rótulo de unidad', lad.con_rotulo > lad.n * 0.9, `${lad.con_rotulo}/${lad.n}`);
  check('la caja nunca cuesta menos que el peldaño base', lad.incoherentes === 0, `${lad.incoherentes} incoherentes`);

  // ── 2. El fact DECLARA de dónde salió cada costo ──────────────────────────────────────────
  const hasCol = (await c.query(`SELECT 1 FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='replenishment_plan' AND column_name='cost_source'`)).rowCount;
  check('replenishment_plan.cost_source existe', hasCol > 0);

  const src = (await c.query(`SELECT cost_source, count(*)::int n
     FROM analytics.replenishment_plan WHERE tenant_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [T])).rows;
  const total = src.reduce((a, x) => a + x.n, 0);
  const byKey = Object.fromEntries(src.map((x) => [x.cost_source || 'null', x.n]));
  console.log(`     reparto: ${src.map((x) => `${x.cost_source || 'null'}=${x.n}`).join(' · ')}`);

  const poblado = total > 0 && byKey.null !== total;
  if (!poblado) {
    console.log('  ⓘ cost_source aún sin poblar (falta correr el importer nuevo) — se omiten 3–4');
  } else {
    // Cobertura REAL medida 2026-08-31: 88.7% (48,484 de 54,630). El 11.3% restante NO es un fallo
    // nuestro — son SKUs que Kepler no tiene en kdpv_prov_prod: de 983 SKUs distintos, sólo 1
    // existe ahí. Son piezas sueltas de mostrador ("IND …") y el 60% ni siquiera tiene costo.
    // El umbral vigila que la cobertura no se DEGRADE; no se sube a 90% porque el dato no existe.
    check('la cobertura desde Kepler no se degradó', (byKey.kepler || 0) > total * 0.85,
      `kepler=${byKey.kepler || 0} de ${total} (${(100 * (byKey.kepler || 0) / total).toFixed(1)}%)`);

    // Y lo que cae a bf tiene que seguir siendo COMERCIALMENTE IRRELEVANTE. Si algún día un SKU
    // que factura de verdad se queda sin escalera, el pedido lo valuaría con la reconstrucción
    // vieja (la que mezclaba peldaños) y nadie se enteraría. Medido: 0.43% de la venta.
    const peso = (await c.query(`
      SELECT round((100.0 * sum(revenue30) FILTER (WHERE cost_source='bf')
                    / NULLIF(sum(revenue30), 0))::numeric, 2) AS pct
        FROM analytics.replenishment_plan WHERE tenant_id=$1`, [T])).rows[0];
    check('lo que cae a bf pesa <2% de la venta', Number(peso.pct) < 2, `${peso.pct}%`);

    // ── 3. EL CANDADO: donde Kepler declara el costo, el fact debe COPIARLO, no recalcularlo ──
    const eq = (await c.query(`
      WITH j AS (
        SELECT DISTINCT ON (rp.sku) rp.sku, rp.caja_cost, lad.box_cost
          FROM analytics.replenishment_plan rp
          JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = rp.sku
         WHERE rp.tenant_id=$1 AND rp.caja_cost > 0 AND lad.box_cost > 0
           AND rp.cost_source = 'kepler')
      SELECT count(*)::int n,
             count(*) FILTER (WHERE abs(caja_cost - box_cost) > 0.01)::int difieren
        FROM j`, [T])).rows[0];
    check('hay universo comparable', eq.n > 1000, `n=${eq.n}`);
    check('el costo de caja ES el de Kepler (no una reconstrucción)',
      eq.difieren === 0, `${eq.difieren} de ${eq.n} difieren`);

    // ── 4. Regresión puntual: los SKUs que destaparon el bug ────────────────────────────────
    for (const [sku, malo] of [['99029', 798.57], ['70344', 28343.52], ['00303', 567.27]]) {
      const r = (await c.query(`
        SELECT DISTINCT ON (rp.sku) round(rp.caja_cost::numeric,2) cc, round(lad.box_cost::numeric,2) bc
          FROM analytics.replenishment_plan rp
          JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = rp.sku
         WHERE rp.tenant_id=$1 AND rp.sku=$2 AND rp.caja_cost > 0`, [T, sku])).rows[0];
      if (!r) { console.log(`  ⓘ ${sku} sin fila en el plan — se omite`); continue; }
      check(`${sku}: ya no vale el número inventado ($${malo})`,
        Math.abs(Number(r.cc) - malo) > 0.01 && Math.abs(Number(r.cc) - Number(r.bc)) <= 0.01,
        `nuestro $${r.cc} · Kepler $${r.bc}`);
    }
  }

  await c.end();
  console.log(`\n=== ${ok} OK · ${fail} fallas ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
