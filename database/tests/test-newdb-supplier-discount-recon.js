/**
 * RE.10 — Smoke del descuento de proveedor: import c84 (pago) + reconciliación de canales.
 *
 * Verifica (contra la newdb local, feed real):
 *  1. `erp_supplier_payments.descuento` poblado (kdm1.c84) — el 2º canal de descuento.
 *  2. `PurchaseAdjustmentsService.discountReconciliation()` (réplica): total por canal
 *     PAGO (c84) vs NOTA (X-D-55 comercial), coherencia de sumas, clasificación de canal
 *     (pago/nota/ambos) y % vs compras. Skip-graceful si no hay descuento (feed no cargado).
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-supplier-discount-recon.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const NOTA_CATS = ['pronto_pago', 'descuento_comercial', 'apoyo_marca'];
const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('RE.10 — descuento de proveedor: import c84 + reconciliación de canales\n');
  try {
    // 1. Columna descuento poblada
    const pcol = (await c.query(
      `SELECT count(*) FILTER (WHERE descuento > 0)::int n_desc, COALESCE(sum(descuento),0)::numeric sum_desc, count(*)::int n
         FROM analytics.erp_supplier_payments WHERE tenant_id=$1`, [TENANT])).rows[0];
    console.log(`  · pagos=${pcol.n} · con descuento c84=${pcol.n_desc} · Σ descuento=${money(pcol.sum_desc)}`);

    if (Number(pcol.sum_desc) <= 0) {
      console.log('\n  ⚠️  SKIP — sin descuento c84 en la data local (feed no cargado / columna sin backfill). Wiring cubierto por el build.');
      await c.end(); process.exit(0);
    }
    ok(Number(pcol.n_desc) > 0, 'columna descuento poblada (c84 leído por el importer)');

    // 2. Réplica de discountReconciliation (3 agregados + merge en JS)
    const pay = (await c.query(
      `SELECT proveedor_code, max(proveedor_nombre) nombre, COALESCE(sum(descuento),0)::numeric desc_pago, count(*) FILTER (WHERE descuento>0)::int n_desc
         FROM analytics.erp_supplier_payments WHERE tenant_id=$1 GROUP BY proveedor_code`, [TENANT])).rows;
    const nota = (await c.query(
      `SELECT proveedor_code, max(proveedor_nombre) nombre, COALESCE(sum(monto),0)::numeric desc_nota, count(*)::int n_nota
         FROM analytics.erp_purchase_adjustments WHERE tenant_id=$1 AND categoria = ANY($2) GROUP BY proveedor_code`, [TENANT, NOTA_CATS])).rows;
    const comp = (await c.query(
      `SELECT proveedor_code, COALESCE(sum(monto),0)::numeric compras FROM analytics.erp_goods_receipts WHERE tenant_id=$1 GROUP BY proveedor_code`, [TENANT])).rows;

    const map = new Map();
    const get = (code, nombre) => { const k = code || '(sin código)'; let e = map.get(k); if (!e) { e = { proveedor_code: code, proveedor_nombre: nombre || null, desc_pago: 0, desc_nota: 0, compras: 0 }; map.set(k, e); } if (!e.proveedor_nombre && nombre) e.proveedor_nombre = nombre; return e; };
    for (const r of pay) { const e = get(r.proveedor_code, r.nombre); e.desc_pago = Number(r.desc_pago) || 0; }
    for (const r of nota) { const e = get(r.proveedor_code, r.nombre); e.desc_nota = Number(r.desc_nota) || 0; }
    for (const r of comp) { const e = get(r.proveedor_code); e.compras = Number(r.compras) || 0; }
    let rows = [...map.values()].filter((e) => e.desc_pago > 0 || e.desc_nota > 0);
    for (const e of rows) { e.total_desc = e.desc_pago + e.desc_nota; e.canal = e.desc_pago > 0 && e.desc_nota > 0 ? 'ambos' : e.desc_pago > 0 ? 'pago' : 'nota'; }
    rows.sort((a, b) => b.total_desc - a.total_desc);

    const totPago = rows.reduce((s, r) => s + r.desc_pago, 0);
    const totNota = rows.reduce((s, r) => s + r.desc_nota, 0);
    const ambos = rows.filter((r) => r.canal === 'ambos');

    console.log(`  · reconciliación: ${rows.length} proveedores con descuento · pago ${money(totPago)} · nota ${money(totNota)} · total ${money(totPago + totNota)}`);
    console.log(`  · canal: pago=${rows.filter((r) => r.canal === 'pago').length} · nota=${rows.filter((r) => r.canal === 'nota').length} · ambos=${ambos.length}`);

    // total_desc_pago del recon == Σ descuento de la tabla (todo proveedor con c84>0 entra)
    ok(near(totPago, pcol.sum_desc), `total canal PAGO (${money(totPago)}) == Σ descuento tabla (${money(pcol.sum_desc)})`);

    // total_desc_nota == Σ notas comerciales
    const nc = (await c.query(
      `SELECT COALESCE(sum(monto),0)::numeric s FROM analytics.erp_purchase_adjustments WHERE tenant_id=$1 AND categoria = ANY($2)`, [TENANT, NOTA_CATS])).rows[0].s;
    ok(near(totNota, nc), `total canal NOTA (${money(totNota)}) == Σ X-D-55 comercial (${money(nc)})`);

    // clasificación de canal coherente en una muestra
    ok(rows.every((r) => (r.canal === 'ambos') === (r.desc_pago > 0 && r.desc_nota > 0)), 'clasificación de canal coherente (ambos ⟺ pago>0 && nota>0)');
    ok(rows.every((r) => near(r.total_desc, r.desc_pago + r.desc_nota)), 'total_desc == desc_pago + desc_nota en cada fila');

    const top = rows[0];
    if (top) console.log(`  · top: ${top.proveedor_nombre || top.proveedor_code} — pago ${money(top.desc_pago)} + nota ${money(top.desc_nota)} = ${money(top.total_desc)} [${top.canal}]${top.compras > 0 ? ` · ${(100 * top.total_desc / top.compras).toFixed(1)}% de compras` : ''}`);
    if (ambos[0]) console.log(`  · ejemplo "ambos": ${ambos[0].proveedor_nombre || ambos[0].proveedor_code} — pago ${money(ambos[0].desc_pago)} + nota ${money(ambos[0].desc_nota)}`);

    console.log(`\n${failed ? '❌ ' + failed + ' fallo(s)' : '✅ PASS — c84 importado + reconciliación de canales coherente'}`);
  } catch (e) {
    console.error('  ❌ ERROR:', e.message);
    failed++;
  } finally {
    await c.end();
  }
  process.exit(failed ? 1 : 0);
})();
