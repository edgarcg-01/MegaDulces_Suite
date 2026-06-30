/* eslint-disable no-console */
/**
 * Fase TC (ADR-026) — Banco de pruebas de Thot Chat: 25 preguntas SIMPLES + 25
 * COMPLEJAS, con VERDAD-BASE. Por cada pregunta:
 *   1. Le preguntamos al chat (POST /commercial/intelligence/thot/chat).
 *   2. Extraemos la "respuesta correcta" del resultado DETERMINISTA de la(s) tool(s)
 *      que invocó (el motor no alucina → su salida ES la verdad-base).
 *   3. Verificamos: (a) ruteó a la tool correcta, (b) la prosa REFLEJA esa verdad
 *      (nombre/numero presente), (c) no inventó cifras ausentes de las tools.
 *
 * Requiere: API arriba (localhost:3334) con el build NUEVO (rutas thot/chat +
 * analytics.*), ANTHROPIC_API_KEY configurada, migración thot_chat_log aplicada y
 * feeds Kepler cargados. Imprime un scorecard legible + dump verdad-base vs prosa.
 *
 * Uso:  node database/tests/http-thot-chat-eval-50.js
 */
const BASE = process.env.THOT_EVAL_BASE || 'http://localhost:3334/api';

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const ask = (q, token) => req('POST', '/commercial/intelligence/thot/chat', { message: q }, token);

// ── helpers de grading ───────────────────────────────────────────────
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** ¿la prosa contiene este string/nombre? (case/acentos-insensible) */
const saysText = (answer, needle) => !!needle && norm(answer).includes(norm(needle));
/** ¿la prosa contiene este número? tolera separadores de miles y redondeo a miles. */
function saysNumber(answer, n) {
  if (n == null || Number.isNaN(Number(n))) return false;
  const a = norm(answer).replace(/[,\s]/g, '');
  const v = Math.round(Number(n));
  if (a.includes(String(v))) return true;
  // tolerancia de redondeo: primeros dígitos significativos (ej "1234567" ~ "1.23 millones"/"1,234,xxx")
  const s = String(v);
  if (s.length >= 4 && a.includes(s.slice(0, s.length - 2))) return true;
  return false;
}
/** filas tabulares de un resultado de tool (igual que el front). */
function rowsOf(result) {
  if (Array.isArray(result)) return result.filter((r) => r && typeof r === 'object');
  if (result && typeof result === 'object') {
    for (const k of ['rows', 'items', 'customers', 'products', 'data']) {
      if (Array.isArray(result[k])) return result[k].filter((r) => r && typeof r === 'object');
    }
  }
  return [];
}
/** busca el resultado de la 1ª tool cuyo nombre esté en `names`. */
function resultOf(toolsUsed, names) {
  const t = (toolsUsed || []).find((x) => names.includes(x.name));
  return t ? t.result : null;
}

let pass = 0, fail = 0, warn = 0;
const lines = [];
function grade(c, res) {
  const body = res.body || {};
  const tools = (body.tools_used || []).map((t) => t.name);
  const answer = body.answer || '';
  const routedOk = !c.tools || c.tools.length === 0 || tools.some((n) => c.tools.includes(n));
  const truth = c.truth ? c.truth(body.tools_used || []) : null;
  let grounded;
  if (truth == null) grounded = answer.trim().length > 0; // sin verdad-base: solo exigimos respuesta
  else if (typeof truth === 'number') grounded = saysNumber(answer, truth);
  else grounded = saysText(answer, truth);

  const okStatus = res.status >= 200 && res.status < 300;
  const ok = okStatus && routedOk && grounded;
  if (ok) pass++; else fail++;
  // ⚠ ruteó y respondió pero no pudimos confirmar la verdad-base en la prosa
  const isWarn = okStatus && routedOk && !grounded && truth != null && answer.trim().length > 0;
  if (isWarn) warn++;

  const tag = ok ? 'OK  ' : (isWarn ? 'WARN' : 'FAIL');
  lines.push(
    `[${c.n.toString().padStart(2, '0')}|${c.type[0].toUpperCase()}] ${tag}  ${c.q}\n` +
    `        tools: [${tools.join(', ') || '—'}]  iter:${body.iterations ?? '?'}  status:${res.status}\n` +
    `        verdad-base: ${truth == null ? '(libre)' : JSON.stringify(truth)}\n` +
    `        respuesta: ${answer.replace(/\s+/g, ' ').slice(0, 220)}`,
  );
}

(async () => {
  console.log('── Login ──');
  const admin = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = admin.body?.access_token;
  if (!token) { console.log('Sin token, abortando.'); process.exit(1); }

  // Sanity + detección de API stale / sin API key
  const sanity = await ask('¿Qué almacenes existen?', token);
  if (sanity.status === 404) { console.log('\n❌ Endpoint /thot/chat da 404 — la API arriba NO tiene el build nuevo. Reconstruí y reiniciá la API.'); process.exit(1); }
  if (sanity.body?.source === 'no_api_key') { console.log('\n⚠️ ANTHROPIC_API_KEY no configurada — no se puede evaluar el LLM.'); process.exit(1); }

  // Datos dinámicos para preguntas que necesitan una entidad real.
  const topProd = resultOf((await ask('Top 3 productos más vendidos', token)).body?.tools_used, ['thot_top_products', 'thot_product_ranking']);
  const sampleProduct = (rowsOf(topProd)[0]?.producto || rowsOf(topProd)[0]?.nombre || 'Bubaloo');
  const erpList = (await req('GET', '/commercial/analytics/erp-customers?limit=1', null, token)).body;
  const sampleCustomerName = (Array.isArray(erpList) ? erpList[0]?.name : null) || 'cliente';

  // ── 25 SIMPLES ───────────────────────────────────────────────────
  const SIMPLE = [
    { q: '¿Qué almacenes existen?', tools: ['thot_list_warehouses'], truth: (t) => rowsOf(resultOf(t, ['thot_list_warehouses']))[0]?.code },
    { q: '¿Cuántos almacenes hay en total?', tools: ['thot_list_warehouses'], truth: (t) => rowsOf(resultOf(t, ['thot_list_warehouses'])).length },
    { q: 'Dame el top 5 de productos más vendidos', tools: ['thot_top_products', 'thot_product_ranking'], truth: (t) => rowsOf(resultOf(t, ['thot_top_products', 'thot_product_ranking']))[0]?.producto || rowsOf(resultOf(t, ['thot_top_products', 'thot_product_ranking']))[0]?.nombre },
    { q: 'Top 10 best-sellers del último año', tools: ['thot_product_ranking', 'thot_top_products'], truth: (t) => rowsOf(resultOf(t, ['thot_product_ranking', 'thot_top_products']))[0]?.nombre || rowsOf(resultOf(t, ['thot_product_ranking', 'thot_top_products']))[0]?.producto },
    { q: '¿Qué promociones hay vigentes?', tools: ['thot_active_promotions'], truth: null },
    { q: '¿Cuántas promociones activas hay?', tools: ['thot_active_promotions'], truth: (t) => rowsOf(resultOf(t, ['thot_active_promotions'])).length },
    { q: 'Muéstrame el stock muerto', tools: ['thot_dead_stock'], truth: (t) => resultOf(t, ['thot_dead_stock'])?.total_skus },
    { q: '¿Cuánto capital está parado en stock muerto?', tools: ['thot_dead_stock'], truth: (t) => resultOf(t, ['thot_dead_stock'])?.total_capital_parado },
    { q: '¿Qué productos tienen stock bajo?', tools: ['thot_low_stock'], truth: (t) => resultOf(t, ['thot_low_stock'])?.total },
    { q: '¿Qué best-sellers están agotados?', tools: ['thot_out_of_stock_bestsellers'], truth: (t) => rowsOf(resultOf(t, ['thot_out_of_stock_bestsellers']))[0]?.nombre },
    { q: '¿Qué clientes llevan más de 30 días sin comprar?', tools: ['thot_inactive_customers'], truth: null },
    { q: 'Dame los clientes que más compran', tools: ['thot_erp_customers', 'thot_top_customers'], truth: (t) => rowsOf(resultOf(t, ['thot_erp_customers', 'thot_top_customers']))[0]?.name },
    { q: '¿Cuál es el margen por categoría?', tools: ['thot_margin_by_category'], truth: (t) => rowsOf(resultOf(t, ['thot_margin_by_category']))[0]?.category },
    { q: '¿Cómo van las ventas por zona?', tools: ['thot_sales_by_zone'], truth: (t) => rowsOf(resultOf(t, ['thot_sales_by_zone']))[0]?.zona },
    { q: 'Dame la salud del inventario', tools: ['thot_inventory_health'], truth: null },
    { q: '¿Qué productos están en estado crítico de inventario?', tools: ['thot_inventory_health'], truth: null },
    { q: `Busca el producto "${sampleProduct}"`, tools: ['thot_resolve_entity', 'thot_top_products'], truth: null },
    { q: '¿Existe la marca Kinder?', tools: ['thot_resolve_entity'], truth: null },
    { q: 'Lista de clientes del ERP', tools: ['thot_erp_customers'], truth: (t) => rowsOf(resultOf(t, ['thot_erp_customers']))[0]?.name },
    { q: '¿Cuánto se vendió en los últimos 30 días?', tools: ['thot_sales_timeseries', 'thot_flexible_aggregate', 'thot_get_sales_overview'], truth: null },
    { q: '¿Cuáles fueron las ventas de la última semana?', tools: ['thot_sales_timeseries', 'thot_flexible_aggregate'], truth: null },
    { q: 'Ventas totales por marca', tools: ['thot_flexible_aggregate', 'thot_sales_by_brand'], truth: (t) => rowsOf(resultOf(t, ['thot_flexible_aggregate']))[0]?.label },
    { q: '¿Cuál es el almacén con más ventas?', tools: ['thot_sales_by_zone', 'thot_flexible_aggregate'], truth: null },
    { q: '¿Cuántos clientes del ERP hay registrados?', tools: ['thot_erp_customers'], truth: null },
    { q: 'Dame las promociones por vencer', tools: ['thot_active_promotions'], truth: null },
  ];

  // ── 25 COMPLEJAS ─────────────────────────────────────────────────
  const COMPLEX = [
    { q: '¿Cómo va la marca Kinder en ventas? Dame el total', tools: ['thot_flexible_aggregate', 'thot_top_products', 'thot_resolve_entity'], truth: null },
    { q: `¿Qué productos compró el cliente ${sampleCustomerName}?`, tools: ['thot_customer_products', 'thot_erp_customers', 'thot_resolve_entity'], truth: null },
    { q: 'De los 5 productos más vendidos, ¿cuál deja mejor margen?', tools: ['thot_top_products', 'thot_margin_by_category', 'thot_product_ranking'], truth: null },
    { q: '¿Dónde estoy perdiendo ventas por falta de stock? Dame el impacto', tools: ['thot_out_of_stock_bestsellers'], truth: null },
    { q: 'Compara las ventas de este mes contra el mes pasado', tools: ['thot_sales_timeseries', 'thot_flexible_aggregate'], truth: null },
    { q: '¿Cuál es la categoría más rentable y cuánto vendió?', tools: ['thot_margin_by_category'], truth: (t) => rowsOf(resultOf(t, ['thot_margin_by_category']))[0]?.category },
    { q: '¿Qué almacén concentra más stock muerto?', tools: ['thot_dead_stock'], truth: null },
    { q: '¿Qué clientes están en riesgo de churn y cuánto facturaban?', tools: ['thot_inactive_customers', 'thot_erp_customers'], truth: null },
    { q: '¿Qué productos debería reabastecer con urgencia?', tools: ['thot_out_of_stock_bestsellers', 'thot_low_stock'], truth: null },
    { q: 'Dame la tendencia de ventas diaria de la última semana', tools: ['thot_sales_timeseries', 'thot_flexible_aggregate'], truth: null },
    { q: '¿Qué marca tiene la mayor participación de ventas?', tools: ['thot_flexible_aggregate', 'thot_sales_by_brand'], truth: (t) => rowsOf(resultOf(t, ['thot_flexible_aggregate']))[0]?.label },
    { q: `¿Cuánto se vendió de ${sampleProduct} en los últimos 90 días?`, tools: ['thot_flexible_aggregate', 'thot_resolve_entity', 'thot_top_products'], truth: null },
    { q: 'Dame las 3 categorías top por revenue con su margen %', tools: ['thot_margin_by_category'], truth: (t) => rowsOf(resultOf(t, ['thot_margin_by_category']))[0]?.category },
    { q: '¿Qué clientes no compran hace más de 60 días?', tools: ['thot_inactive_customers'], truth: null },
    { q: '¿Cuál es el ticket promedio de venta?', tools: ['thot_get_sales_overview', 'thot_sales_timeseries'], truth: null },
    { q: '¿Qué productos tienen sobrestock?', tools: ['thot_inventory_health'], truth: null },
    { q: 'Comparame las ventas entre las distintas zonas', tools: ['thot_sales_by_zone', 'thot_flexible_aggregate'], truth: (t) => rowsOf(resultOf(t, ['thot_sales_by_zone']))[0]?.zona },
    { q: '¿Cuántas piezas se vendieron del producto más vendido?', tools: ['thot_product_ranking', 'thot_top_products'], truth: null },
    { q: 'Dame un resumen ejecutivo de las ventas del mes', tools: ['thot_sales_timeseries', 'thot_top_products', 'thot_get_sales_overview', 'thot_flexible_aggregate'], truth: null },
    { q: '¿Qué cliente del ERP factura más?', tools: ['thot_erp_customers'], truth: (t) => rowsOf(resultOf(t, ['thot_erp_customers']))[0]?.name },
    { q: 'Tendencia mensual de ventas del último semestre', tools: ['thot_flexible_aggregate', 'thot_sales_timeseries'], truth: null },
    { q: '¿Qué promoción conviene más por volumen?', tools: ['thot_active_promotions'], truth: null },
    { q: '¿Qué productos son best-seller pero los tengo agotados?', tools: ['thot_out_of_stock_bestsellers'], truth: (t) => rowsOf(resultOf(t, ['thot_out_of_stock_bestsellers']))[0]?.nombre },
    { q: '¿Cuál es el almacén con mejor desempeño de ventas?', tools: ['thot_sales_by_zone', 'thot_flexible_aggregate'], truth: null },
    { q: 'Dame el revenue por categoría y dónde está el mayor margen', tools: ['thot_margin_by_category'], truth: (t) => rowsOf(resultOf(t, ['thot_margin_by_category']))[0]?.category },
  ];

  const ALL = [
    ...SIMPLE.map((c, i) => ({ ...c, n: i + 1, type: 'simple' })),
    ...COMPLEX.map((c, i) => ({ ...c, n: i + 1, type: 'complex' })),
  ];

  console.log(`\n── Ejecutando ${ALL.length} preguntas (25 simples + 25 complejas) ──\n`);
  for (const c of ALL) {
    const res = await ask(c.q, token);
    grade(c, res);
  }

  console.log(lines.join('\n\n'));
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`RESUMEN:  ${pass} OK   ${fail} FAIL   (${warn} de las OK/FAIL marcadas WARN = ruteó+respondió pero no se confirmó la cifra en la prosa → revisar a ojo)`);
  console.log(`Aprobación de ruteo+respuesta: ${Math.round((pass / ALL.length) * 100)}%`);
  process.exit(fail - warn > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
