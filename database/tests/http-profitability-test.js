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
 *   · El costo sale del FACT (`sales_daily.cost`), no de `catalog.cost_base`.
 *     Los testigos son SKUs cuyo costo de catalogo esta capturado por CAJA: con
 *     el calculo viejo salian a -665% de margen y movian el total 8.6 pp.
 *   · El KPI de inventario CUADRA con la suma de la tabla (total = in_scope +
 *     stock muerto). Antes diferian en $23M sin explicacion visible.
 *   · Las bandas se mueven con el objetivo. Estaban clavadas en 10/15/25.
 *   · Lo que no tiene fuente se declara (`levers_source_empty`), no se dibuja
 *     como un cero.
 *
 * Read-only: no escribe nada.
 */
const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK ', m); } else { fail++; console.log('  XX ', m); } };
// Presupuesto de latencia. La primera version tardaba 53 SEGUNDOS por
// subconsultas correlacionadas (una por producto); pre-agregarlas como tablas
// derivadas la dejo en ~0.4 s de SQL. Esta asercion existe para que no vuelva
// en silencio: es la clase de regresion que nadie nota hasta que molesta.
const MAX_MS = 6000;
const timed = async (p, t) => {
  const t0 = Date.now();
  const r = await req(p, t);
  return Object.assign({}, r, { ms: Date.now() - t0 });
};
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
    console.log(`     cobertura ${Number(o.coverage.revenue_pct).toFixed(2)}% de la venta · ${o.coverage.skus_with_cost}/${o.coverage.skus_total} SKUs · canales ${o.coverage.channels.map((c) => c.channel).join('+')} · datos al ${o.data_as_of}`);
    console.log(`     inventario total ${money(o.inventory.total)} = en tabla ${money(o.inventory.in_scope)} + sin venta ${money(o.inventory.no_sales)} · sin verificar ${money(o.inventory.unverified)}`);
    console.log(`     costo en conflicto: ${o.cost_quality.conflict_skus} SKUs (${money(o.cost_quality.conflict_revenue)} de venta)`);
    console.log('     bandas:', o.bands.map((b) => `${b.label}=${b.skus}`).join(' '));
    ok(o.revenue > 0 && o.margin_pct > 0, 'overview trae cifras');
    ok(Math.abs(o.bands.reduce((a, b) => a + b.skus, 0) - o.skus) < 1, 'bandas suman los SKUs del universo');

    // El margen sale del fact. Con `cost_base` daba 13.05% y la banda "bajo
    // costo" tenia 60 SKUs que en realidad vendian bien.
    ok(o.margin_pct > 5 && o.margin_pct < 25, `margen en rango creible (${Number(o.margin_pct).toFixed(2)}%)`);
    ok(o.coverage.channels.length > 0, 'la cobertura declara de que canales viene la venta');
    ok(!!o.data_as_of, 'declara hasta que dia llega el fact');
    // La cobertura vieja siempre daba 100%: era un adorno, no una medida.
    ok(o.coverage.revenue_total >= o.coverage.revenue_with_cost, 'cobertura: la venta total incluye la venta con costo');

    // El KPI y la tabla miden universos distintos a proposito; que lo digan.
    ok(Math.abs(o.inventory.total - (o.inventory.in_scope + o.inventory.no_sales)) < 1,
      'inventario: total = en-tabla + stock muerto');
    ok(o.cost_quality.conflict_skus >= 0 && typeof o.cost_quality.note === 'string',
      'declara los SKUs cuyo costo de catalogo contradice al del PdV');
    ok(typeof o.levers_source_empty === 'boolean', 'declara si la fuente de ajustes esta vacia');
  }

  // Las bandas se derivan del objetivo — antes estaban clavadas en 10/15/25.
  const ov20 = await req('/commercial/profitability/overview?window=30d&target=20', t);
  if (ov20.status === 200 && ov.status === 200) {
    const meta15 = o.bands.find((b) => b.key === 'meta')?.skus ?? 0;
    const meta20 = ov20.j.bands.find((b) => b.key === 'meta')?.skus ?? 0;
    console.log(`     banda "meta" con objetivo 15% = ${meta15} SKUs · con 20% = ${meta20}`);
    ok(meta15 !== meta20, 'las bandas se mueven con el objetivo');
    ok(ov20.j.bands.some((b) => b.label.includes('20')), 'la etiqueta de la banda refleja el objetivo');
  }

  // Testigos: SKUs con el costo de catalogo capturado por CAJA. Con el calculo
  // viejo salian entre -765% y -2370%. Ahora tienen que ser margenes de verdad.
  const wit = await req('/commercial/profitability/breakdown?level=sku&window=30d&pageSize=500&search=BUBBULUBU', t);
  if (wit.status === 200 && wit.j.data.length) {
    const r0 = wit.j.data.find((r) => r.sku === '78210') ?? wit.j.data[0];
    console.log(`     testigo ${r0.sku} ${r0.name}: margen ${Number(r0.margin_pct).toFixed(1)}%`);
    ok(Number(r0.margin_pct) > -50, 'el testigo de costo-por-caja ya no da margen imposible');
    ok(r0.promo_benefit === null || typeof r0.promo_benefit === 'number', 'la promo viaja como valor crudo (promo_benefit)');
    ok(!('promo_pct' in r0), 'ya no se publica promo_pct: la unidad no esta confirmada');
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
    ok(g.margin_negotiated_pct >= g.margin_pct && g.margin_negotiated_pct < 100, 'negociado mejora el bruto y sigue siendo un % posible');
    // Cascada ciega != cascada en cero. Si la fuente esta vacia hay que decirlo.
    if (g.levers_source_empty) {
      console.log('     AVISO: erp_purchase_adjustments VACIA — las 4 palancas por categoria no se estan midiendo');
      ok(g.levers.filter((l) => l.key !== 'descuento_pago').every((l) => l.amount === 0),
        'con la fuente vacia las palancas por categoria quedan en cero y el flag lo explica');
    }
    ok(g.levers.some((l) => l.key === 'apoyo_marca'), 'apoyo_marca es una palanca propia (no se pierde en el doctype)');
    ok(g.levers.every((l) => l.key !== 'factura_duplicada'), 'factura_duplicada NO entra a las palancas');
    ok(g.non_margin.error_captura.amount >= 0 && g.non_margin.operacional.amount >= 0, 'lo no-margen se reporta aparte');
  }

  // El filtro por banda tiene que devolver SOLO lo que promete. `every()` sobre
  // una lista vacia es true, asi que se prueba con una banda que si tiene filas.
  for (const [band, test] of [['negativo', (r) => r.margin_pct < 0], ['critico', (r) => r.margin_pct >= 0 && r.margin_pct < 10]]) {
    const flt = await req(`/commercial/profitability/breakdown?level=sku&window=30d&band=${band}&pageSize=5`, t);
    const n = flt.j?.pagination?.total ?? 0;
    console.log(`     banda ${band}: ${n} SKUs`);
    ok(flt.status === 200 && flt.j.data.every(test), `filtro band=${band} devuelve solo esa banda (${n} filas)`);
  }

  // Margen UNITARIO: el numero del mostrador. Solo existe a nivel producto y su
  // porcentaje tiene que ser EL MISMO que el de la fila: dos porcentajes distintos
  // en el mismo renglon matan la confianza en la tabla.
  const um = await req('/commercial/profitability/breakdown?level=sku&window=30d&pageSize=50&sort=margin_unit&dir=desc', t);
  if (um.status === 200 && um.j.data.length) {
    const top = um.j.data[0];
    console.log(`     top por unidad: ${top.sku} ${String(top.name).slice(0, 26)} · gana ${money(top.margin_unit)} ${top.unit_kind === 'weight' ? 'por kilo' : 'por unidad'} (${money(top.price_unit)} − ${money(top.cost_unit)})${top.margin_box !== null ? ` · caja de ${top.box_factor}: ${money(top.margin_box)}` : ''}`);
    const conMargen = um.j.data.filter((r) => r.margin_unit !== null);
    ok(conMargen.length > 0, `nivel producto trae margen unitario (${conMargen.length}/${um.j.data.length} filas)`);
    ok(conMargen.every((r) => Math.abs(r.margin_unit - (r.price_unit - r.cost_unit)) < 0.01),
      'margen unitario = precio unitario − costo unitario');
    ok(conMargen.every((r) => r.margin_unit_pct === null || Math.abs(r.margin_unit_pct - r.margin_pct) < 0.05),
      'el % unitario coincide con el % de la fila (mismo denominador)');
    ok(conMargen.every((r) => r.unit_kind === 'piece' || r.unit_kind === 'weight'),
      'la unidad se rotula piece/weight, nunca se inventa');
    // La caja sale del resolvedor canonico: nunca derivada, nunca si es dudosa.
    ok(um.j.data.every((r) => r.margin_box === null || (r.box_factor > 1 && Math.abs(r.margin_box - r.margin_unit * r.box_factor) < 0.01)),
      'la equivalencia por caja sale del factor canonico y solo si es > 1');
    ok(um.j.data.every((r, i, a) => i === 0 || (a[i - 1].margin_unit ?? -Infinity) >= (r.margin_unit ?? -Infinity)),
      'sort=margin_unit ordena de verdad');
  }

  // El margen unitario NO existe en los agregados: promediar el precio de un
  // paquete con el de un kilo no significa nada, y publicarlo seria inventarlo.
  for (const lvl of ['supplier', 'brand']) {
    const r = await req(`/commercial/profitability/breakdown?level=${lvl}&window=30d&pageSize=5`, t);
    ok(r.status === 200 && r.j.data.every((x) => x.margin_unit === null),
      `${lvl}: sin margen unitario (no se promedian unidades distintas)`);
  }
  // Y ordenar por una columna que ese nivel no tiene no puede reventar el SQL.
  const badSort = await req('/commercial/profitability/breakdown?level=supplier&window=30d&pageSize=3&sort=margin_unit', t);
  ok(badSort.status === 200, 'sort=margin_unit en un agregado degrada, no revienta');

  // El inventario de la tabla tiene que cuadrar con la parte "en tabla" del KPI.
  const bdInv = await req('/commercial/profitability/breakdown?level=sku&window=30d&pageSize=1', t);
  if (bdInv.status === 200 && ov.status === 200) {
    const dif = Math.abs(Number(bdInv.j.totals.inventory_value) - Number(o.inventory.in_scope));
    console.log(`     inventario tabla ${money(bdInv.j.totals.inventory_value)} vs KPI en-tabla ${money(o.inventory.in_scope)} (dif ${money(dif)})`);
    ok(dif < 1, 'el inventario del desglose cuadra con el KPI');
    ok(Math.abs(Number(bdInv.j.totals.revenue_costed) - Number(o.revenue)) < 1, 'la venta con costo cuadra entre desglose y overview');
  }

  // Latencia real del endpoint. El nivel producto es el peor caso.
  for (const lvl of ['sku', 'supplier']) {
    const r = await timed(`/commercial/profitability/breakdown?level=${lvl}&window=365d&pageSize=50`, t);
    console.log(`     breakdown ${lvl.padEnd(9)} ${String(r.ms).padStart(6)} ms`);
    ok(r.status === 200 && r.ms < MAX_MS, `breakdown ${lvl} responde en < ${MAX_MS} ms (${r.ms} ms)`);
  }
  const ovt = await timed('/commercial/profitability/overview?window=365d', t);
  console.log(`     overview            ${String(ovt.ms).padStart(6)} ms`);
  ok(ovt.ms < MAX_MS, `overview responde en < ${MAX_MS} ms (${ovt.ms} ms)`);

  console.log(`\nProfitability smoke: ${pass} OK / ${fail} XX`);
  process.exit(fail === 0 ? 0 : 1);
})();
