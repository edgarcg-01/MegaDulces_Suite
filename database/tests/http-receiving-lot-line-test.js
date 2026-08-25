/* eslint-disable no-console */
/**
 * WMS-REC (ADR-044) — Smoke HTTP E2E de la **declaración de lotes por renglón**.
 *
 * Ejercita los ENDPOINTS REALES (no DB-direct, no mirror del motor). Esto es
 * deliberado: el smoke previo del auditor (`test-newdb-receiving-auditor`)
 * reimplementaba `computeVerdict` en JS e insertaba filas con knex, así que daba
 * 17/17 mientras `POST /commercial/receiving/evaluate` tiraba 500 en producción
 * (leía `products.category`, columna que no existe → 42703). Este test recorre el
 * camino que hace el operador:
 *
 *   login → abrir vale → agregar renglón esperado → recibir 100 pz
 *        → declarar 3 lotes del MISMO SKU (verde 40 / amarillo 35 / rojo 25)
 *        → cuadre declarado-vs-recibido
 *        → cerrar bloqueado por el retenido (409)
 *        → autorizar el rojo → stock completo → cerrar OK
 *
 * Auto-contenido e idempotente: crea su propio almacén (código con timestamp) y
 * su política de caducidad; el stock que mueve queda en ese almacén desechable,
 * así no contamina MD-CENTRAL ni los smokes de pedidos.
 *
 * Requiere: API en :3334 con el código de commercial-receiving ACTUALIZADO.
 *
 * Correr: node database/tests/http-receiving-lot-line-test.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const BASE = 'http://localhost:3334/api';
// Misma resolución que el seed 03: el password del superoot sale del env, con
// fallback al default de dev.
const SUPEROOT_PASS = process.env.SUPEROOT_INITIAL_PASSWORD || 'superoot';
let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* respuesta sin cuerpo */ }
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

const N = (v) => Number(v ?? 0) || 0;
/** ISO a N días de hoy (el motor compara contra CURRENT_DATE del server). */
function isoInDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

(async () => {
  const stamp = Date.now().toString().slice(-8);
  let sessionId = null;
  let policyId = null;

  try {
    // ── 1. Login ──────────────────────────────────────────────────────────
    console.log('── 1. Login ──');
    const login = await req('POST', '/auth-mt/login', {
      tenant_slug: 'mega_dulces', username: 'superoot', password: SUPEROOT_PASS,
    });
    const token = login.body?.access_token;
    check('JWT recibido', !!token, login.status);
    if (!token) process.exit(1);

    // ── 2. Setup: almacén desechable + producto con stock ─────────────────
    console.log('\n── 2. Setup ──');
    const wh = await req('POST', '/commercial/warehouses', {
      code: `TST-LOT-${stamp}`, name: `Test lotes ${stamp}`, type: 'cedis',
    }, token);
    const whId = wh.body?.id;
    check('almacén de prueba creado', !!whId, { status: wh.status, body: wh.body });
    if (!whId) process.exit(1);

    const anyStock = await req('GET', '/commercial/inventory/stock?pageSize=5', null, token);
    const productId = (anyStock.body?.data || anyStock.body || [])[0]?.product_id;
    check('product_id de muestra obtenido', !!productId, anyStock.status);
    if (!productId) process.exit(1);

    // Política determinista para ESTE producto: exige 180 días de vida útil y
    // NO permite recibir más viejo que lo existente. Es el motor, no el OCR.
    const pol = await req('POST', '/commercial/receiving/policy', {
      product_id: productId, min_shelf_life_days: 180, allow_older_than_existing: false,
    }, token);
    policyId = pol.body?.id;
    check('política de caducidad creada (180d, no-más-viejo)', !!policyId, { status: pol.status, body: pol.body });

    const stock0 = await req('GET', `/commercial/inventory/stock?warehouse_id=${whId}&product_id=${productId}`, null, token);
    const qty0 = N((stock0.body?.data || stock0.body || [])[0]?.quantity);
    console.log(`  (stock inicial en el almacén de prueba: ${qty0})`);

    // ── 3. Abrir vale + renglón esperado + recibir 100 ─────────────────────
    console.log('\n── 3. Vale de entrada: 100 pz recibidas ──');
    const open = await req('POST', '/commercial/receiving/sessions', {
      warehouse_id: whId, source_kind: 'manual', supplier_code: `PROV-${stamp}`,
    }, token);
    sessionId = open.body?.id;
    check('vale abierto con folio VE-', !!sessionId && /^VE-\d{4}-\d{5}$/.test(open.body?.folio || ''), open.body?.folio);

    const addLine = await req('POST', `/commercial/receiving/sessions/${sessionId}/add-line`, {
      product_id: productId, expected_qty: 100,
    }, token);
    const lineId = (addLine.body?.lines || []).find((l) => l.product_id === productId)?.id;
    check('renglón agregado (esperado 100)', !!lineId, addLine.status);
    if (!lineId) throw new Error('sin renglón');

    const setRecv = await req('POST', `/commercial/receiving/sessions/${sessionId}/lines/${lineId}`, {
      received_qty: 100,
    }, token);
    const lineAfterRecv = (setRecv.body?.lines || []).find((l) => l.id === lineId);
    check('recibido = 100', N(lineAfterRecv?.received_qty) === 100, lineAfterRecv?.received_qty);
    check('declarado = 0 (entró sin trazabilidad todavía)', N(lineAfterRecv?.declared_qty) === 0, lineAfterRecv?.declared_qty);
    check('progress.undeclared_units = 100', N(setRecv.body?.progress?.undeclared_units) === 100, setRecv.body?.progress);

    // ── 4. Declarar 3 lotes del MISMO renglón ─────────────────────────────
    console.log('\n── 4. Tres lotes del mismo SKU (amarillo / verde / rojo) ──');
    // El ORDEN importa y es parte del contrato: la regla `older_than_existing`
    // compara contra MIN(expiry) de lo que YA está en stock. Se declara en orden
    // ascendente de caducidad para aislar cada regla (si entrara primero el de 400d,
    // el de 200d sería legítimamente rojo por "más viejo que lo existente").

    // 4a. AMARILLO — 200 días: cumple el mínimo (180) pero < 1.5× (270) → near_min.
    //     Es el primero, así que no hay "existente" con qué compararlo.
    const yellow = await req('POST', '/commercial/receiving/evaluate', {
      warehouse_id: whId, product_id: productId, receiving_line_id: lineId,
      supplier_code: `PROV-${stamp}`, quantity: 35,
      confirmed_lot: `L-AMBAR-${stamp}`, confirmed_expiry: isoInDays(200),
    }, token);
    check('lote 1 → 200 (la ruta real NO tira 500: fix del lookup)', yellow.status === 200 || yellow.status === 201, { status: yellow.status, body: yellow.body });
    check('lote 1 veredicto amarillo (near_min_shelf_life)', yellow.body?.verdict === 'yellow' && yellow.body?.rule_broken === 'near_min_shelf_life', { verdict: yellow.body?.verdict, rule: yellow.body?.rule_broken });
    check('lote 1 escribió stock (amarillo entra)', !!yellow.body?.stock_movement_id, yellow.body?.stock_movement_id);
    check('lote 1 ligado al renglón', yellow.body?.receiving_line_id === lineId, yellow.body?.receiving_line_id);

    // 4b. VERDE — 400 días: sobre el mínimo, más NUEVO que lo existente (200d) → green
    const green = await req('POST', '/commercial/receiving/evaluate', {
      warehouse_id: whId, product_id: productId, receiving_line_id: lineId,
      supplier_code: `PROV-${stamp}`, quantity: 40,
      confirmed_lot: `L-VERDE-${stamp}`, confirmed_expiry: isoInDays(400),
    }, token);
    check('lote 2 veredicto verde', green.body?.verdict === 'green', { verdict: green.body?.verdict, rule: green.body?.rule_broken });
    check('lote 2 escribió stock', !!green.body?.stock_movement_id);

    // 4c. ROJO — 100 días: bajo el mínimo de 180 → bloquea
    const red = await req('POST', '/commercial/receiving/evaluate', {
      warehouse_id: whId, product_id: productId, receiving_line_id: lineId,
      supplier_code: `PROV-${stamp}`, quantity: 25,
      confirmed_lot: `L-ROJO-${stamp}`, confirmed_expiry: isoInDays(100),
    }, token);
    const redId = red.body?.id;
    check('lote 3 veredicto rojo (min_shelf_life)', red.body?.verdict === 'red' && red.body?.rule_broken === 'min_shelf_life', { verdict: red.body?.verdict, rule: red.body?.rule_broken });
    check('lote 3 queda pending_authorization', red.body?.status === 'pending_authorization', red.body?.status);
    check('lote 3 NO escribió stock', !red.body?.stock_movement_id, red.body?.stock_movement_id);

    // ── 5. Cuadre del renglón ──────────────────────────────────────────────
    console.log('\n── 5. Cuadre declarado vs recibido ──');
    const det = await req('GET', `/commercial/receiving/sessions/${sessionId}`, null, token);
    const line = (det.body?.lines || []).find((l) => l.id === lineId);
    check('declarado = 100 (40+35+25)', N(line?.declared_qty) === 100, line?.declared_qty);
    check('sin declarar = 0', N(det.body?.progress?.undeclared_units) === 0, det.body?.progress?.undeclared_units);
    check('retenidas = 25', N(line?.held_qty) === 25, line?.held_qty);
    check('holds = 1', N(line?.holds) === 1, line?.holds);

    const stock1 = await req('GET', `/commercial/inventory/stock?warehouse_id=${whId}&product_id=${productId}`, null, token);
    const qty1 = N((stock1.body?.data || stock1.body || [])[0]?.quantity);
    check('stock subió 75 (verde+amarillo), NO 100', qty1 - qty0 === 75, { qty0, qty1 });

    const caps = await req('GET', `/commercial/receiving/captures?receiving_line_id=${lineId}`, null, token);
    check('las 3 capturas del renglón se listan por receiving_line_id', (caps.body || []).length === 3, (caps.body || []).length);

    // ── 6. El retenido bloquea el cierre ──────────────────────────────────
    console.log('\n── 6. Guard de cierre ──');
    const closeBlocked = await req('POST', `/commercial/receiving/sessions/${sessionId}/close`, {}, token);
    check('cerrar con retenido → 409', closeBlocked.status === 409, { status: closeBlocked.status, msg: closeBlocked.body?.message });

    // ── 7. Autorizar el rojo → entra el resto → cerrar ────────────────────
    console.log('\n── 7. Autorización del retenido ──');
    const auth = await req('POST', `/commercial/receiving/captures/${redId}/authorize`, { notes: 'smoke' }, token);
    check('autorizar → status authorized', auth.body?.status === 'authorized', { status: auth.status, body: auth.body?.status });
    check('autorizar escribió el stock retenido', !!auth.body?.stock_movement_id);

    const reAuth = await req('POST', `/commercial/receiving/captures/${redId}/authorize`, {}, token);
    check('re-autorizar → 409 (claim atómico, no duplica stock)', reAuth.status === 409, reAuth.status);

    const stock2 = await req('GET', `/commercial/inventory/stock?warehouse_id=${whId}&product_id=${productId}`, null, token);
    const qty2 = N((stock2.body?.data || stock2.body || [])[0]?.quantity);
    check('stock total = +100 (sin duplicar)', qty2 - qty0 === 100, { qty0, qty2 });

    const lots = await req('GET', `/commercial/inventory/stock/${whId}/${productId}/lots`, null, token);
    const dated = (lots.body || []).filter((l) => l.expiry_date);
    check('3 lotes fechados en stock_lots', dated.length === 3, (lots.body || []).map((l) => l.lot_code));
    const invariant = (lots.body || []).reduce((a, l) => a + N(l.quantity), 0);
    check('invariante SUM(lotes) = stock.quantity', invariant === qty2, { invariant, qty2 });

    const closeOk = await req('POST', `/commercial/receiving/sessions/${sessionId}/close`, {}, token);
    check('cerrar sin retenidos → 200', closeOk.status === 200 || closeOk.status === 201, closeOk.status);
    check('vale cerrado', closeOk.body?.status === 'closed', closeOk.body?.status);
    sessionId = null; // ya cerrado, no cancelar en teardown

    // ── 8. Guards de integridad del renglón ───────────────────────────────
    console.log('\n── 8. Guards ──');
    const onClosed = await req('POST', '/commercial/receiving/evaluate', {
      warehouse_id: whId, product_id: productId, receiving_line_id: lineId,
      quantity: 5, confirmed_expiry: isoInDays(400),
    }, token);
    check('capturar en vale cerrado → 409', onClosed.status === 409, { status: onClosed.status, msg: onClosed.body?.message });

    const badLine = await req('POST', '/commercial/receiving/evaluate', {
      warehouse_id: whId, product_id: productId,
      receiving_line_id: '00000000-0000-0000-0000-000000000000',
      quantity: 5, confirmed_expiry: isoInDays(400),
    }, token);
    check('renglón inexistente → 404', badLine.status === 404, badLine.status);

    // ── 9. Scorecard del proveedor ────────────────────────────────────────
    console.log('\n── 9. Scorecard ──');
    const score = await req('GET', '/commercial/receiving/scorecard', null, token);
    const mine = (score.body || []).find((r) => r.supplier_code === `PROV-${stamp}`);
    check('proveedor en el scorecard con 3 recepciones', N(mine?.receptions) === 3, mine);
    check('2 no conformidades (amarillo + rojo)', N(mine?.nonconformities) === 2, mine?.nonconformities);
  } catch (e) {
    check(`excepción inesperada: ${e.message}`, false);
  } finally {
    // Teardown: si el vale quedó abierto, cancelarlo (deja el almacén de prueba,
    // que es desechable y no lo usa nadie más).
    if (sessionId) {
      const login2 = await req('POST', '/auth-mt/login', {
        tenant_slug: 'mega_dulces', username: 'superoot', password: SUPEROOT_PASS,
      });
      const t2 = login2.body?.access_token;
      if (t2) await req('POST', `/commercial/receiving/sessions/${sessionId}/cancel`, {}, t2);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`RESULTADO: ${pass} OK · ${fail} FAIL`);
  if (failures.length) console.log(`Fallaron: ${failures.join(' · ')}`);
  process.exit(fail === 0 ? 0 : 1);
})();
