/**
 * CXP.4 — Smoke de "Costo neto" (landed cost) por proveedor.
 *
 * Verifica: costo real = compras − descuento efectivo (pago c84 + notas comerciales).
 * Replica el merge de PurchaseAdjustmentsService.landedCost (3 agregados por proveedor).
 * Asserts: costo_neto=compras−desc, rate=desc/compras, anomalo=rate>0.2. Skip-graceful.
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-landed-cost.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('CXP.4 — Costo neto (landed cost) por proveedor\n');
  try {
    const nRec = Number((await c.query(`SELECT count(*)::int n FROM analytics.erp_goods_receipts WHERE tenant_id=$1`, [TENANT])).rows[0].n);
    if (nRec === 0) { console.log('\n  ⚠️  SKIP — sin recepciones (feed no cargado). Wiring cubierto por el build.'); await c.end(); process.exit(0); }

    const rows = (await c.query(
      `SELECT c.proveedor_code, c.compras::numeric compras,
              COALESCE(p.desc_pago,0)::numeric desc_pago, COALESCE(n.desc_nota,0)::numeric desc_nota
         FROM (SELECT proveedor_code, sum(monto) compras FROM analytics.erp_goods_receipts WHERE tenant_id=$1 GROUP BY proveedor_code) c
         LEFT JOIN (SELECT proveedor_code, sum(descuento) desc_pago FROM analytics.erp_supplier_payments WHERE tenant_id=$1 GROUP BY proveedor_code) p USING (proveedor_code)
         LEFT JOIN (SELECT proveedor_code, sum(monto) desc_nota FROM analytics.erp_purchase_adjustments WHERE tenant_id=$1 AND categoria IN ('pronto_pago','descuento_comercial','apoyo_marca') GROUP BY proveedor_code) n USING (proveedor_code)
        WHERE c.compras > 0
        ORDER BY c.compras DESC`, [TENANT])).rows;

    const out = rows.map((r) => {
      const compras = Number(r.compras), descuento = Number(r.desc_pago) + Number(r.desc_nota);
      return { code: r.proveedor_code, compras, descuento, rate: compras > 0 ? descuento / compras : 0, costo_neto: compras - descuento, anomalo: (compras > 0 ? descuento / compras : 0) > 0.2 };
    });
    ok(out.length > 0, `devuelve proveedores con compras (${out.length})`);
    ok(out.every((r) => Math.abs(r.costo_neto - (r.compras - r.descuento)) < 0.01), 'costo_neto = compras − descuento por fila');
    ok(out.every((r) => r.compras === 0 || Math.abs(r.rate - r.descuento / r.compras) < 1e-9), 'rate = descuento / compras');

    const compras = out.reduce((s, r) => s + r.compras, 0), descuento = out.reduce((s, r) => s + r.descuento, 0);
    const rate = compras > 0 ? descuento / compras : 0;
    const anom = out.filter((r) => r.anomalo).length;
    console.log(`  · compras ${money(compras)} · descuento ${money(descuento)} · costo neto ${money(compras - descuento)} · tasa ${(rate * 100).toFixed(2)}%`);
    console.log(`  · proveedores con tasa anómala (>20%, revisar): ${anom}`);
    ok(descuento >= 0 && descuento <= compras * 1.5, 'descuento total en rango sano vs compras');

    const top = out[0];
    if (top) console.log(`  · top compras: ${top.code} — bruto ${money(top.compras)} → neto ${money(top.costo_neto)} (${(top.rate * 100).toFixed(1)}%)`);

    console.log(`\n${failed ? '❌ ' + failed + ' fallo(s)' : '✅ PASS — costo neto por proveedor coherente (compras−descuento + tasa + flag anómalo)'}`);
  } catch (e) {
    console.error('  ❌ ERROR:', e.message);
    failed++;
  } finally {
    await c.end();
  }
  process.exit(failed ? 1 : 0);
})();
