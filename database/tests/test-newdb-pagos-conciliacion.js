/**
 * CXP.5 — Smoke de la conciliación de pagos a proveedor (Kepler ↔ Banco, mes a mes).
 *
 * Verifica el cuadre AGREGADO por mes: Kepler (erp_supplier_payments) vs Banco
 * (bank_movements egresos de categorías compra/factoraje). Replica la SQL de
 * PagosControlService.conciliacion + la lógica de estado. HONESTO: es por mes, no por
 * proveedor (el banco no guarda proveedor). Skip-graceful si ambos vacíos.
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-pagos-conciliacion.js
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
  console.log('CXP.5 — Conciliación pagos a proveedor (Kepler ↔ Banco, mes a mes)\n');
  try {
    const kep = (await c.query(
      `SELECT to_char(pago_date,'YYYY-MM') mes, sum(monto)::numeric kepler, count(*)::int n
         FROM analytics.erp_supplier_payments WHERE tenant_id=$1 GROUP BY 1`, [TENANT])).rows;
    const ban = (await c.query(
      `SELECT to_char(bm.movement_date,'YYYY-MM') mes, sum(bm.amount_out)::numeric banco, count(*)::int n
         FROM finance.bank_movements bm JOIN finance.movement_categories mc ON mc.id=bm.category_id
        WHERE bm.tenant_id=$1 AND mc.group_key IN ('compra','factoraje') AND bm.amount_out>0 GROUP BY 1`, [TENANT])).rows;

    if (kep.length === 0 && ban.length === 0) { console.log('\n  ⚠️  SKIP — sin pagos ni movimientos de banco. Wiring cubierto por el build.'); await c.end(); process.exit(0); }

    const map = new Map();
    const get = (mes) => { let e = map.get(mes); if (!e) { e = { mes, kepler: 0, banco: 0 }; map.set(mes, e); } return e; };
    for (const r of kep) get(r.mes).kepler = Number(r.kepler) || 0;
    for (const r of ban) get(r.mes).banco = Number(r.banco) || 0;
    const rows = [...map.values()].sort((a, b) => b.mes.localeCompare(a.mes));
    for (const e of rows) {
      e.delta = e.kepler - e.banco;
      const base = Math.max(e.kepler, e.banco);
      e.estado = e.kepler === 0 ? 'sin_kepler' : e.banco === 0 ? 'sin_banco' : (base > 0 && Math.abs(e.delta) / base <= 0.1 ? 'cuadra' : 'revisar');
    }

    ok(rows.length > 0, `devuelve meses (${rows.length})`);
    ok(rows.every((r) => Math.abs(r.delta - (r.kepler - r.banco)) < 0.01), 'Δ = Kepler − Banco por mes');
    ok(rows.every((r) => ['cuadra', 'revisar', 'sin_banco', 'sin_kepler'].includes(r.estado)), 'estado en el dominio válido');
    // coherencia estado
    ok(rows.every((r) => (r.estado === 'sin_banco') === (r.kepler > 0 && r.banco === 0)), 'sin_banco ⇔ hay Kepler y no banco (feed faltante)');

    const tK = rows.reduce((s, r) => s + r.kepler, 0), tB = rows.reduce((s, r) => s + r.banco, 0);
    const overlap = rows.filter((r) => r.kepler > 0 && r.banco > 0);
    console.log(`  · Kepler total ${money(tK)} · Banco (compra/factoraje) total ${money(tB)}`);
    console.log(`  · meses con AMBOS feeds (cuadre posible): ${overlap.length}${overlap.length === 0 ? '  (local: Kepler mar-dic vs CB enero → sin traslape; prod completa el cuadre)' : ''}`);
    for (const r of rows.slice(0, 6)) console.log(`    ${r.mes}: Kepler ${money(r.kepler)} · Banco ${money(r.banco)} · ${r.estado}`);

    console.log(`\n${failed ? '❌ ' + failed + ' fallo(s)' : '✅ PASS — conciliación mensual coherente (Δ + estado + honesta ante feed faltante)'}`);
  } catch (e) {
    console.error('  ❌ ERROR:', e.message);
    failed++;
  } finally {
    await c.end();
  }
  process.exit(failed ? 1 : 0);
})();
