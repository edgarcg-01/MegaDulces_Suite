/* eslint-disable no-console */
/**
 * MR — Motor de Rentabilidad. Smoke HTTP de la cascada de margen.
 *
 * Requiere API en localhost:3334 con ENABLE_MULTITENANT=true.
 *
 * Lo que verifica de verdad, mas alla de "200 OK":
 *   · Las bandas de salud SUMAN el universo de SKUs (son disjuntas: si se
 *     traslapan, los contadores mienten y el usuario deja de creerles).
 *   · El total del desglose CUADRA con el overview en los CUATRO niveles. Si el
 *     total de proveedor no coincide con la suma de sus SKUs, el tablero pierde
 *     credibilidad a la primera revision.
 *   · El filtro por banda devuelve solo lo que promete.
 *   · Las palancas del proveedor declaran `not_attributed` — lo que todavia no
 *     se puede repartir a SKU (ADR-046). Publicarlo como si fuera el margen
 *     integral seria mentir.
 *
 * Read-only: no escribe nada.
 */
const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK ', m); } else { fail++; console.log('  XX ', m); } };
const req = async (p, t) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${t}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.log(`     [${r.status}]`, JSON.stringify(j).slice(0, 300));
  return { status: r.status, j };
};
const money = (n) => '$' + Number(n).toLocaleString('es-MX', { maximumFractionDigits: 0 });
(async () => {
  const login = await fetch(`${BASE}/auth-mt/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' }),
  }).then((r) => r.json());
  const t = login.access_token;
  ok(!!t, 'login');
  if (!t) process.exit(1);

  const ov = await req('/commercial/profitability/overview?window=30d', t);
  ok(ov.status === 200, 'GET overview 200');
  const o = ov.j;
  if (ov.status === 200) {
    console.log(`     venta ${money(o.revenue)} · margen ${Number(o.margin_pct).toFixed(2)}% (${money(o.margin_amount)})`);
    console.log(`     brecha ${Number(o.gap_pp).toFixed(2)} pp = ${money(o.gap_amount)} · inventario ${money(o.inventory_value)} (${Number(o.inventory_days).toFixed(0)} d)`);
    console.log(`     cobertura ${Number(o.coverage.revenue_pct).toFixed(1)}% de la venta · ${o.coverage.skus_with_cost}/${o.coverage.skus_total} SKUs`);
    console.log('     bandas:', o.bands.map((b) => `${b.label}=${b.skus}`).join(' '));
    ok(o.revenue > 0 && o.margin_pct > 0, 'overview trae cifras');
    ok(Math.abs(o.bands.reduce((a, b) => a + b.skus, 0) - o.skus) < 1, 'bandas suman los SKUs del universo');
  }

  for (const lvl of ['supplier', 'brand', 'category', 'sku']) {
    const r = await req(`/commercial/profitability/breakdown?level=${lvl}&window=30d&pageSize=5`, t);
    ok(r.status === 200, `GET breakdown level=${lvl} 200`);
    if (r.status === 200) {
      const top = r.j.data[0];
      console.log(`     ${lvl}: ${r.j.pagination.total} filas · top "${top?.name}" ${money(top?.revenue)} margen ${top?.margin_pct === null ? '—' : Number(top.margin_pct).toFixed(1) + '%'}`);
      ok(Math.abs(Number(r.j.totals.margin_pct) - Number(o.margin_pct)) < 0.01, `${lvl}: total cuadra con overview`);
    }
  }

  const bd = await req('/commercial/profitability/breakdown?level=supplier&window=30d&pageSize=1&sort=gap_amount&dir=desc', t);
  const supId = bd.j?.data?.[0]?.id;
  ok(!!supId, 'hay proveedor para probar palancas');
  if (supId) {
    const lv = await req(`/commercial/profitability/supplier/${supId}/levers?window=365d`, t);
    ok(lv.status === 200, 'GET supplier levers 200');
    if (lv.status === 200) {
      const l = lv.j;
      console.log(`     ${l.supplier.name}: venta ${money(l.revenue)} · bruto ${Number(l.margin_gross_pct).toFixed(2)}% → negociado ${Number(l.margin_negotiated_pct).toFixed(2)}%`);
      for (const x of l.levers) console.log(`       ${x.label}: ${money(x.amount)} = ${x.pp === null ? '—' : Number(x.pp).toFixed(2) + ' pp'}`);
      console.log(`     no atribuible aún: ${l.not_attributed.length} componentes`);
      ok(Array.isArray(l.levers) && l.levers.length === 5, 'levers trae las 5 palancas por categoria');
      ok(Array.isArray(l.not_attributed) && l.not_attributed.length > 0, 'declara lo no atribuible');
    }
  }

  // Palancas: categoria real, y lo que NO es margen queda FUERA del negociado.
  const ov365 = await req('/commercial/profitability/overview?window=365d', t);
  if (ov365.status === 200) {
    const g = ov365.j;
    console.log('     palancas globales:');
    for (const lv of g.levers) console.log(`       ${lv.label.padEnd(38)} negociado ${money(lv.amount).padStart(12)}  tasa ${lv.rate === null ? '  —' : Number(lv.rate).toFixed(2) + '%'}  -> margen ${money(lv.margin_effect).padStart(11)}  ${lv.pp === null ? '' : '+' + Number(lv.pp).toFixed(2) + ' pp'}`);
    console.log(`     compras del periodo: ${money(g.purchases)} · negociado bruto ${money(g.levers_amount_total)} -> efecto en margen ${money(g.levers_margin_effect)}`);
    console.log(`     bruto ${Number(g.margin_pct).toFixed(2)}% -> negociado ${Number(g.margin_negotiated_pct).toFixed(2)}% (brecha restante ${Number(g.gap_pp_negotiated).toFixed(2)} pp)`);
    console.log(`     NO es margen: duplicadas ${money(g.non_margin.error_captura.amount)} · operacional ${money(g.non_margin.operacional.amount)}`);
    console.log(`     promociones vigentes: ${g.promotions.skus_con_promo} SKUs`);

    const efecto = g.levers.reduce((a, l) => a + Number(l.margin_effect), 0);
    ok(Math.abs(g.margin_negotiated_amount - (g.margin_amount + efecto)) < 1, 'negociado = bruto + efecto en margen de las palancas');
    ok(g.purchases > 0, 'hay compras del periodo como base de las tasas');
    // El descuento se gana sobre compras: su efecto en margen NO puede superar el monto negociado.
    ok(g.levers.every((l) => Math.abs(l.margin_effect) <= Math.abs(l.amount) + 1), 'el efecto en margen nunca excede lo negociado');
    ok(g.margin_negotiated_pct > g.margin_pct && g.margin_negotiated_pct < 100, 'negociado mejora el bruto y sigue siendo un % posible');
    ok(g.levers.some((l) => l.key === 'apoyo_marca'), 'apoyo_marca es una palanca propia (no se pierde en el doctype)');
    ok(g.levers.every((l) => l.key !== 'factura_duplicada'), 'factura_duplicada NO entra a las palancas');
    ok(g.non_margin.error_captura.amount >= 0 && g.non_margin.operacional.amount >= 0, 'lo no-margen se reporta aparte');
  }

  const flt = await req('/commercial/profitability/breakdown?level=sku&window=30d&band=negativo&pageSize=3', t);
  ok(flt.status === 200 && flt.j.data.every((r) => r.margin_pct < 0), 'filtro band=negativo devuelve solo margen negativo');
  console.log(`     SKUs bajo costo: ${flt.j?.pagination?.total}`);

  console.log(`\nProfitability smoke: ${pass} OK / ${fail} XX`);
  process.exit(fail === 0 ? 0 : 1);
})();
