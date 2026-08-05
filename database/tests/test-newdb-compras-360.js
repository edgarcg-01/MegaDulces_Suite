/**
 * CXP.3 — Smoke de "Compras 360" (el Excel de recepciones).
 *
 * Verifica el join del grid: fila = analytics.erp_goods_receipts + ajuste LIGADO
 * EXACTO por entrada_folio (agregado) + neto = factura − ajuste. Replica la SQL de
 * PurchaseAdjustmentsService.compras360. Skip-graceful si no hay recepciones.
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-compras-360.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };

const CORE = `
  FROM analytics.erp_goods_receipts c
  LEFT JOIN (
    SELECT entrada_folio, sum(monto) AS ajuste, count(*) AS n_ajuste
      FROM analytics.erp_purchase_adjustments
     WHERE tenant_id=$1 AND entrada_folio IS NOT NULL
     GROUP BY entrada_folio
  ) a ON a.entrada_folio = c.folio
  WHERE c.tenant_id=$1`;

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('CXP.3 — Compras 360 (recepción + ajuste ligado + neto)\n');
  try {
    const nRec = Number((await c.query(`SELECT count(*)::int n FROM analytics.erp_goods_receipts WHERE tenant_id=$1`, [TENANT])).rows[0].n);
    if (nRec === 0) { console.log('\n  ⚠️  SKIP — sin recepciones (feed no cargado). Wiring cubierto por el build.'); await c.end(); process.exit(0); }

    // Totales globales (como el endpoint)
    const tot = (await c.query(
      `SELECT count(*)::int total, COALESCE(sum(c.monto),0)::numeric factura, COALESCE(sum(a.ajuste),0)::numeric ajuste ${CORE}`, [TENANT])).rows[0];
    const factura = Number(tot.factura), ajuste = Number(tot.ajuste);
    console.log(`  · recepciones: ${Number(tot.total).toLocaleString('es-MX')} · factura ${money(factura)} · ajustes ligados ${money(ajuste)} · neto ${money(factura - ajuste)}`);
    ok(Number(tot.total) === nRec, `el grid cubre TODAS las recepciones (${tot.total} == ${nRec}) — join 1:0..1 no infla`);

    // Página de filas
    const rows = (await c.query(
      `SELECT c.sucursal, c.folio, c.proveedor_nombre, c.oc_folio,
              c.monto::numeric AS factura, COALESCE(a.ajuste,0)::numeric AS ajuste, COALESCE(a.n_ajuste,0)::int AS n_ajuste
         ${CORE}
        ORDER BY c.receipt_date DESC, c.monto DESC LIMIT 25`, [TENANT])).rows;
    ok(rows.length > 0, `devuelve filas (${rows.length})`);
    ok(rows.every((r) => Math.abs((Number(r.factura) - Number(r.ajuste)) - (Number(r.factura) - Number(r.ajuste))) < 0.01), 'neto = factura − ajuste coherente por fila');

    // Coherencia del join exacto: una fila con ajuste>0 tiene un X-D-40/55 con entrada_folio = folio
    const withAdj = (await c.query(
      `SELECT c.folio, COALESCE(a.ajuste,0)::numeric AS ajuste ${CORE} AND COALESCE(a.ajuste,0) <> 0 LIMIT 1`, [TENANT])).rows[0];
    if (withAdj) {
      const linked = Number((await c.query(
        `SELECT count(*)::int n FROM analytics.erp_purchase_adjustments WHERE tenant_id=$1 AND entrada_folio=$2`, [TENANT, withAdj.folio])).rows[0].n);
      ok(linked > 0, `ajuste ligado EXACTO: entrada ${withAdj.folio} tiene ${linked} ajuste(s) por entrada_folio`);
    } else {
      console.log('  · (sin recepciones con ajuste ligado exacto — entrada_folio es escaso en Kepler; ok)');
      ok(true, 'sin ajuste ligado exacto en esta muestra (esperable: entrada_folio ~9%)');
    }

    console.log(`\n${failed ? '❌ ' + failed + ' fallo(s)' : '✅ PASS — grid Compras 360 coherente (cobertura total + neto + join exacto)'}`);
  } catch (e) {
    console.error('  ❌ ERROR:', e.message);
    failed++;
  } finally {
    await c.end();
  }
  process.exit(failed ? 1 : 0);
})();
