/* eslint-disable no-console */
/**
 * **WMS-REC.8 (ADR-053) — Smoke HTTP E2E del reclamo diferenciado de faltantes.**
 *
 * Ejercita los ENDPOINTS REALES (`POST`/`GET`), no un espejo de la lógica en JS. Es una
 * regla que costó: el smoke de WMS-REC.4 (`test-newdb-receiving-auditor`) reimplementaba
 * `computeVerdict` e insertaba con knex, y daba **17/17 verde con la ruta principal
 * caída** (500 en toda captura por leer `products.category`). Acá knex se usa **sólo**
 * para sembrar lo que no tiene endpoint (el proveedor de prueba) y para verificar
 * invariantes de SCHEMA que no se ven por HTTP (RLS forzado, UNIQUE del dedup).
 *
 * Recorre lo que hace la gente:
 *
 *   login → vale manual de PROVEEDOR (4 renglones: faltante · ok · sobrante · dañado)
 *        → cerrar  ⇒ 2 reclamos (ok y sobrante NO generan)
 *        → capturar la cantidad del dañado (el andén no la tiene)
 *        → el fill rate del proveedor SE MUEVE (`/commercial/replenishment/suppliers`)
 *        → reclamar → 409 al reclamar dos veces → descartar sin motivo 400
 *        → descartar con motivo ⇒ el fill rate SUBE (descartado no penaliza)
 *        → aceptar ⇒ sigue penalizando
 *   vale de TRASPASO desde un documento REAL del ERP (TI###)
 *        → responsable = sucursal, SIN deducir cuál · monto real del renglón
 *        → no contamina el scorecard de ningún proveedor
 *   crosswalk TI### → almacén capturado a mano ⇒ los reclamos huérfanos quedan con dueño
 *
 * Auto-contenido e idempotente: almacén y proveedor con timestamp, el stock que mueve
 * cae en ese almacén desechable, y al final el proveedor de prueba se da de baja y el
 * crosswalk sintético se borra.
 *
 * Requiere: API en :3334 con el código de commercial-receiving ACTUALIZADO.
 * Correr: node database/tests/http-receiving-claims-test.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const BASE = 'http://127.0.0.1:3334/api';
const SUPEROOT_PASS = process.env.SUPEROOT_INITIAL_PASSWORD || 'superoot';

let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (_) { /* respuesta sin cuerpo */ }
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

const N = (v) => Number(v ?? 0) || 0;
/** Compara dinero/tasas con tolerancia (los numeric llegan como string). */
const near = (a, b, tol = 0.005) => Math.abs(N(a) - N(b)) <= tol;

(async () => {
  const stamp = Date.now().toString().slice(-8);
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
  const tenant = await knex('identity.tenants').where({ slug: 'mega_dulces' }).first('id');
  const TENANT = tenant?.id;
  const SUP_CODE = `TSTRCL${stamp}`;
  const TI_FAKE = 'TI99'; // código de traspaso sintético para el crosswalk (TI000..TI008 son reales)
  let supplierId = null;
  let whId = null;

  try {
    // ── 1. Login ──────────────────────────────────────────────────────────
    console.log('── 1. Login ──');
    const login = await req('POST', '/auth-mt/login', {
      tenant_slug: 'mega_dulces', username: 'superoot', password: SUPEROOT_PASS,
    });
    const token = login.body?.access_token;
    check('JWT recibido', !!token, login.status);
    if (!token) process.exit(1);
    check('tenant mega_dulces resuelto', !!TENANT, TENANT);

    // ── 2. Setup ──────────────────────────────────────────────────────────
    console.log('\n── 2. Setup (almacén desechable + proveedor de prueba + productos) ──');
    const wh = await req('POST', '/commercial/warehouses', {
      code: `TST-RCL-${stamp}`, name: `Test reclamos ${stamp}`, type: 'cedis',
    }, token);
    whId = wh.body?.id;
    check('almacén de prueba creado', !!whId, { status: wh.status, body: wh.body });
    if (!whId) process.exit(1);

    // `catalog.suppliers` no tiene endpoint de alta (verificado): se siembra con knex.
    // Es SETUP, no lógica — todo lo que se afirma abajo pasa por HTTP.
    const [sup] = await knex('catalog.suppliers')
      .insert({ tenant_id: TENANT, code: SUP_CODE, name: `PROVEEDOR TEST ${stamp}`, lead_time_days: 5 })
      .returning('id');
    supplierId = sup?.id || sup;
    check('proveedor de prueba sembrado', !!supplierId, SUP_CODE);

    const stock = await req('GET', '/commercial/inventory/stock?pageSize=10', null, token);
    const prods = ((stock.body?.data || stock.body || [])).map((r) => r.product_id).filter(Boolean);
    const uniq = Array.from(new Set(prods));
    check('4 productos de muestra obtenidos', uniq.length >= 4, { status: stock.status, n: uniq.length });
    if (uniq.length < 4) process.exit(1);
    const [pA, pB, pC, pD] = uniq;

    // ── 3. Vale manual de PROVEEDOR: 4 renglones, 4 desenlaces ────────────
    console.log('\n── 3. Vale de proveedor: faltante · ok · sobrante · dañado ──');
    const open = await req('POST', '/commercial/receiving/sessions', {
      warehouse_id: whId, supplier_code: SUP_CODE, source_kind: 'manual',
      notes: `smoke reclamos ${stamp}`,
    }, token);
    const sid = open.body?.id;
    const folio = open.body?.folio;
    check('vale abierto', !!sid, { status: open.status, body: open.body?.message });
    check('origen clasificado como proveedor', open.body?.origin?.kind === 'supplier', open.body?.origin);
    if (!sid) process.exit(1);

    for (const [pid, qty] of [[pA, 100], [pB, 100], [pC, 100], [pD, 50]]) {
      const r = await req('POST', `/commercial/receiving/sessions/${sid}/add-line`, { product_id: pid, expected_qty: qty }, token);
      check(`renglón esperado ${qty}`, r.status === 201 || r.status === 200, { status: r.status, msg: r.body?.message });
    }
    let detail = (await req('GET', `/commercial/receiving/sessions/${sid}`, null, token)).body;
    const lineOf = (pid) => (detail.lines || []).find((l) => l.product_id === pid);

    // faltante 40 · ok · sobrante 20 · dañado (llegó completo pero no sirve)
    await req('POST', `/commercial/receiving/sessions/${sid}/lines/${lineOf(pA).id}`, { received_qty: 60 }, token);
    await req('POST', `/commercial/receiving/sessions/${sid}/lines/${lineOf(pB).id}`, { received_qty: 100 }, token);
    await req('POST', `/commercial/receiving/sessions/${sid}/lines/${lineOf(pC).id}`, { received_qty: 120 }, token);
    const dSet = await req('POST', `/commercial/receiving/sessions/${sid}/lines/${lineOf(pD).id}`,
      { received_qty: 50, discrepancy_kind: 'dañado', notes: 'tarima mojada' }, token);
    detail = dSet.body;
    check('discrepancias tipificadas antes de cerrar',
      lineOf(pA).discrepancy_kind === 'faltante' && lineOf(pB).discrepancy_kind === 'ok'
      && lineOf(pC).discrepancy_kind === 'sobrante' && lineOf(pD).discrepancy_kind === 'dañado',
      (detail.lines || []).map((l) => l.discrepancy_kind));

    // ── 4. El cierre levanta los reclamos ─────────────────────────────────
    console.log('\n── 4. Cerrar el vale levanta el reclamo (y no bloquea) ──');
    const close = await req('POST', `/commercial/receiving/sessions/${sid}/close`, {}, token);
    check('el faltante NO bloquea el cierre', close.status === 200 || close.status === 201,
      { status: close.status, msg: close.body?.message });
    check('el vale quedó cerrado', close.body?.status === 'closed', close.body?.status);
    check('el cierre informa 2 reclamos (faltante + dañado)', N(close.body?.claims?.raised) === 2, close.body?.claims);

    const listed = await req('GET', `/commercial/receiving/claims?search=${folio}&pageSize=50`, null, token);
    const mine = (listed.body?.data || []).filter((c) => c.folio === folio);
    check('la bandeja devuelve exactamente 2 reclamos del vale', mine.length === 2, mine.map((m) => m.kind));
    const cFalt = mine.find((c) => c.kind === 'faltante');
    const cDan = mine.find((c) => c.kind === 'dañado');
    check('ok y sobrante NO generan reclamo',
      !mine.some((c) => ['ok', 'sobrante'].includes(c.kind)), mine.map((m) => m.kind));
    check('el faltante reclama 40 (expected − received)', N(cFalt?.qty_claimed) === 40, cFalt?.qty_claimed);
    check('responsable = proveedor, con su id del catálogo',
      cFalt?.responsible_kind === 'supplier' && cFalt?.supplier_id === supplierId,
      { kind: cFalt?.responsible_kind, sup: cFalt?.supplier_id });
    check('vale manual: el label cae al código, no a un nombre inventado',
      cFalt?.responsible_label === SUP_CODE, cFalt?.responsible_label);
    check('sin renglón del ERP no hay monto: null y sin_dato, NO $0',
      cFalt?.amount === null && cFalt?.amount_source === 'sin_dato',
      { amount: cFalt?.amount, src: cFalt?.amount_source });
    check('el dañado nace SIN cantidad (nadie la capturó todavía)', cDan?.qty_claimed === null, cDan?.qty_claimed);
    check('KPI needs_qty y open_without_amount lo dicen',
      N(listed.body?.kpis?.needs_qty) >= 1 && N(listed.body?.kpis?.open_without_amount) >= 2,
      listed.body?.kpis);
    check('la antigüedad se mide en días desde el cierre', N(cFalt?.age_days) === 0, cFalt?.age_days);

    // ── 5. La cantidad del dañado se captura en la bandeja ────────────────
    console.log('\n── 5. Capturar la cantidad del dañado (fuera del andén) ──');
    const tooMuch = await req('POST', `/commercial/receiving/claims/${cDan.id}/qty`, { qty_claimed: 999 }, token);
    check('no se puede reclamar más de lo que traía el renglón', tooMuch.status === 400, tooMuch.status);
    const setQty = await req('POST', `/commercial/receiving/claims/${cDan.id}/qty`, { qty_claimed: 10 }, token);
    check('cantidad del dañado capturada', N(setQty.body?.qty_claimed) === 10, { status: setQty.status, q: setQty.body?.qty_claimed });
    check('sin costo del documento el monto sigue en null', setQty.body?.amount === null, setQty.body?.amount);

    // ── 6. Le pega al proveedor: el fill rate que YA existe ────────────────
    console.log('\n── 6. El reclamo mueve el fill rate de /compras/proveedores ──');
    const supRow = async () => {
      const r = await req('GET', `/commercial/replenishment/suppliers?search=PROVEEDOR TEST ${stamp}`, null, token);
      return (r.body || []).find((s) => s.id === supplierId);
    };
    let sr = await supRow();
    // ord = 100+100+100+50 = 350 · penalizado = 40 (faltante) + 10 (dañado) = 50 → 300/350
    check('fill rate por evidencia de recepción ≈ 0.857', near(sr?.fill_rate_auto, 300 / 350), sr?.fill_rate_auto);
    check('la evidencia se declara como recepción', sr?.fill_evidence === 'recv', sr?.fill_evidence);
    check('cuenta los 4 renglones del vale', N(sr?.fill_receptions) === 4, sr?.fill_receptions);
    check('el scorecard muestra 2 reclamos abiertos', N(sr?.claims_open) === 2, sr?.claims_open);

    const bySup = await req('GET', '/commercial/receiving/claims/by-supplier', null, token);
    const agg = (bySup.body || []).find((s) => s.supplier_id === supplierId);
    check('agregado por proveedor: 2 abiertos', N(agg?.claims_open) === 2, agg);

    // ── 7. Seguimiento: reclamar, descartar, aceptar ───────────────────────
    console.log('\n── 7. Seguimiento con quién y por qué ──');
    const claimed = await req('POST', `/commercial/receiving/claims/${cFalt.id}/claim`, { channel: 'whatsapp', note: 'se le avisó al vendedor' }, token);
    check('reclamo pasado al responsable', claimed.body?.status === 'claimed', { status: claimed.status, s: claimed.body?.status });
    check('queda quién lo reclamó', claimed.body?.claimed_by_username === 'superoot', claimed.body?.claimed_by_username);
    const twice = await req('POST', `/commercial/receiving/claims/${cFalt.id}/claim`, {}, token);
    check('no se reclama dos veces (409)', twice.status === 409, twice.status);

    const noNote = await req('POST', `/commercial/receiving/claims/${cFalt.id}/resolve`, { resolution: 'discarded' }, token);
    check('descartar sin motivo se rechaza (400)', noNote.status === 400, noNote.status);
    const disc = await req('POST', `/commercial/receiving/claims/${cFalt.id}/resolve`,
      { resolution: 'discarded', note: 'error de conteo: la tarima estaba en el otro andén' }, token);
    check('descartado con motivo', disc.body?.status === 'discarded', { status: disc.status, s: disc.body?.status });
    check('queda quién lo cerró', disc.body?.resolved_by_username === 'superoot', disc.body?.resolved_by_username);
    const reResolve = await req('POST', `/commercial/receiving/claims/${cFalt.id}/resolve`, { resolution: 'accepted' }, token);
    check('un reclamo cerrado no se re-cierra (409)', reResolve.status === 409, reResolve.status);

    sr = await supRow();
    // Descartado deja de penalizar: sólo queda el dañado (10) → 340/350
    check('descartado NO penaliza el fill rate', near(sr?.fill_rate_auto, 340 / 350), sr?.fill_rate_auto);
    check('y sale de los abiertos del scorecard', N(sr?.claims_open) === 1, sr?.claims_open);

    const acc = await req('POST', `/commercial/receiving/claims/${cDan.id}/resolve`, { resolution: 'accepted', note: 'el proveedor lo reconoció' }, token);
    check('aceptado', acc.body?.status === 'accepted', { status: acc.status, s: acc.body?.status });
    sr = await supRow();
    check('aceptado SÍ sigue penalizando', near(sr?.fill_rate_auto, 340 / 350), sr?.fill_rate_auto);

    // ── 8. Traspaso desde un documento REAL del ERP ───────────────────────
    console.log('\n── 8. Traspaso: responsable sin deducir la sucursal + monto real ──');
    const erpDoc = await knex('analytics.erp_goods_receipts as r')
      .where({ 'r.tenant_id': TENANT })
      .whereRaw(`r.proveedor_code ~* '^TI[0-9]'`)
      .whereExists(function () {
        this.select(1).from('analytics.erp_goods_receipt_lines as l')
          .whereRaw('l.tenant_id = r.tenant_id AND l.sucursal = r.sucursal AND l.folio = r.folio')
          .whereNotNull('l.sku').where('l.cantidad', '>', 1).where('l.importe', '>', 0);
      })
      .first('r.sucursal', 'r.folio', 'r.proveedor_code', 'r.proveedor_nombre');

    if (!erpDoc) {
      console.log('  SKIP  sin documento de traspaso en el espejo del ERP (feed no cargado en esta DB)');
    } else {
      const tOpen = await req('POST', '/commercial/receiving/sessions', {
        source_kind: 'erp_receipt', erp_sucursal: erpDoc.sucursal, erp_folio: erpDoc.folio,
        warehouse_id: whId, force: true, // force: el folio ya se recibió antes (guard de WMS-REC)
      }, token);
      const tid = tOpen.body?.id;
      check('vale de traspaso abierto desde el ERP', !!tid, { status: tOpen.status, msg: tOpen.body?.message });
      check('origen clasificado como traspaso', tOpen.body?.origin?.kind === 'transfer', tOpen.body?.origin);
      check('el nombre es el DEL DOCUMENTO, no una sucursal deducida',
        tOpen.body?.origin?.name === erpDoc.proveedor_nombre, tOpen.body?.origin?.name);

      const tLine = (tOpen.body?.lines || []).find((l) => N(l.expected_qty) > 1);
      check('renglón esperado del documento', !!tLine, (tOpen.body?.lines || []).length);
      const esperado = N(tLine.expected_qty);
      const recibido = Math.floor(esperado / 2);
      await req('POST', `/commercial/receiving/sessions/${tid}/lines/${tLine.id}`, { received_qty: recibido }, token);
      const tClose = await req('POST', `/commercial/receiving/sessions/${tid}/close`, {}, token);
      check('traspaso cerrado con su reclamo', N(tClose.body?.claims?.raised) >= 1, { status: tClose.status, c: tClose.body?.claims });

      const tFolio = tClose.body?.folio;
      const tList = await req('GET', `/commercial/receiving/claims?search=${tFolio}&pageSize=50`, null, token);
      const tc = (tList.body?.data || []).find((c) => c.folio === tFolio);
      check('responsable = sucursal (branch)', tc?.responsible_kind === 'branch', tc?.responsible_kind);
      check('sin proveedor del catálogo (no es compra)', tc?.supplier_id === null, tc?.supplier_id);
      check('el label es el nombre del documento', tc?.responsible_label === erpDoc.proveedor_nombre, tc?.responsible_label);
      check('NO se deduce la sucursal: queda sin dueño hasta que alguien lo capture',
        tc?.responsible_warehouse_id === null, tc?.responsible_warehouse_id);
      // El monto sale de importe/cantidad del renglón del ERP, en la unidad del documento.
      const erpLine = await knex('analytics.erp_goods_receipt_lines')
        .where({ tenant_id: TENANT, sucursal: erpDoc.sucursal, folio: erpDoc.folio, sku: tLine.expected_sku })
        .first(knex.raw('SUM(importe) AS imp'), knex.raw('SUM(cantidad) AS cant'), knex.raw(`MIN(TRIM(unidad)) AS unidad`));
      const costEsperado = Math.round((N(erpLine.imp) / N(erpLine.cant)) * 10000) / 10000;
      check('unit_cost = importe/cantidad del documento (sin factor de caja)',
        near(tc?.unit_cost, costEsperado, 0.0001), { got: tc?.unit_cost, exp: costEsperado });
      check('la unidad es la DEL DOCUMENTO', tc?.qty_unit === erpLine.unidad, { got: tc?.qty_unit, exp: erpLine.unidad });
      check('monto = cantidad reclamada × costo unitario',
        near(tc?.amount, (esperado - recibido) * costEsperado, 0.02),
        { got: tc?.amount, exp: (esperado - recibido) * costEsperado });
      check('amount_source declara que el monto viene del documento', tc?.amount_source === 'erp_line', tc?.amount_source);

      const bySup2 = await req('GET', '/commercial/receiving/claims/by-supplier', null, token);
      check('un traspaso NO contamina el scorecard de proveedores',
        !(bySup2.body || []).some((s) => s.supplier_id === null), (bySup2.body || []).length);
      check('KPI de traspasos sin dueño', N(tList.body?.kpis?.transfer_without_owner) >= 1, tList.body?.kpis);
    }

    // ── 9. Crosswalk TI### → almacén, capturado a mano ────────────────────
    console.log('\n── 9. El dueño del traspaso se captura, no se deduce ──');
    const fOpen = await req('POST', '/commercial/receiving/sessions', {
      warehouse_id: whId, supplier_code: TI_FAKE, source_kind: 'manual',
    }, token);
    const fid = fOpen.body?.id;
    check('vale de traspaso sintético abierto', !!fid, { status: fOpen.status, msg: fOpen.body?.message });
    check(`${TI_FAKE} se clasifica como traspaso`, fOpen.body?.origin?.kind === 'transfer', fOpen.body?.origin);
    await req('POST', `/commercial/receiving/sessions/${fid}/add-line`, { product_id: pA, expected_qty: 30 }, token);
    const fDet = (await req('GET', `/commercial/receiving/sessions/${fid}`, null, token)).body;
    await req('POST', `/commercial/receiving/sessions/${fid}/lines/${fDet.lines[0].id}`, { received_qty: 20 }, token);
    const fClose = await req('POST', `/commercial/receiving/sessions/${fid}/close`, {}, token);
    check('reclamo de traspaso levantado', N(fClose.body?.claims?.raised) === 1, fClose.body?.claims);

    const pend = await req('GET', '/commercial/receiving/claims/transfer-origins', null, token);
    const pendRow = (pend.body?.pending || []).find((p) => p.code === TI_FAKE);
    check('el código sin dueño aparece para capturarlo', !!pendRow, pend.body?.pending);

    const setOrigin = await req('POST', '/commercial/receiving/claims/transfer-origins',
      { code: TI_FAKE, warehouse_id: whId, note: `smoke ${stamp}` }, token);
    check('crosswalk capturado', setOrigin.status === 201 || setOrigin.status === 200, setOrigin.status);
    check('los reclamos huérfanos de ese código quedan con dueño', N(setOrigin.body?.claims_reassigned) >= 1, setOrigin.body);

    const fList = await req('GET', `/commercial/receiving/claims?search=${fClose.body?.folio}&pageSize=10`, null, token);
    const fc = (fList.body?.data || [])[0];
    check('el reclamo ya apunta al almacén que embarcó', fc?.responsible_warehouse_id === whId, fc?.responsible_warehouse_id);
    check('y muestra su código de almacén', fc?.responsible_warehouse_code === `TST-RCL-${stamp}`, fc?.responsible_warehouse_code);

    const after = await req('GET', '/commercial/receiving/claims/transfer-origins', null, token);
    check('el código pasa de pendiente a mapeado',
      (after.body?.mapped || []).some((m) => m.code === TI_FAKE)
      && !(after.body?.pending || []).some((p) => p.code === TI_FAKE),
      { mapped: (after.body?.mapped || []).map((m) => m.code), pending: (after.body?.pending || []).map((p) => p.code) });

    // ── 10. Filtros de la bandeja ─────────────────────────────────────────
    console.log('\n── 10. Filtros ──');
    const onlyBranch = await req('GET', '/commercial/receiving/claims?responsible_kind=branch&pageSize=100', null, token);
    check('filtro por responsable devuelve sólo traspasos',
      (onlyBranch.body?.data || []).every((c) => c.responsible_kind === 'branch'),
      (onlyBranch.body?.data || []).map((c) => c.responsible_kind).slice(0, 5));
    const onlyOpen = await req('GET', '/commercial/receiving/claims?status=abiertos&pageSize=100', null, token);
    check('filtro "abiertos" excluye los cerrados',
      (onlyOpen.body?.data || []).every((c) => ['open', 'claimed'].includes(c.status)),
      (onlyOpen.body?.data || []).map((c) => c.status).slice(0, 5));
    check('los KPIs del encabezado no cambian con el filtro de estado',
      N(onlyOpen.body?.kpis?.open_count) === N((await req('GET', '/commercial/receiving/claims?status=discarded&pageSize=1', null, token)).body?.kpis?.open_count),
      onlyOpen.body?.kpis?.open_count);

    // ── 11. Invariantes de schema (no se ven por HTTP) ────────────────────
    console.log('\n── 11. Schema: RLS forzado, grants y el dedup del reclamo ──');
    const rls = await knex.raw(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
                                 WHERE relname IN ('receiving_claims','erp_transfer_origin')`);
    check('RLS habilitado Y forzado en las 2 tablas nuevas',
      rls.rows.length === 2 && rls.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity), rls.rows);
    const grants = await knex.raw(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
                                    WHERE grantee='app_runtime' AND table_name IN ('receiving_claims','erp_transfer_origin')`);
    check('app_runtime tiene los 4 privilegios en cada tabla', grants.rows.length === 8, grants.rows.length);
    const fks = await knex.raw(`SELECT conname FROM pg_constraint
                                 WHERE conrelid='commercial.receiving_claims'::regclass AND contype='f'`);
    check('FKs compuestas (tenant_id, …) presentes', fks.rows.length >= 6, fks.rows.map((f) => f.conname));
    let dupBlocked = false;
    try {
      await knex('commercial.receiving_claims').insert({
        tenant_id: TENANT, session_id: fid, receiving_line_id: fDet.lines[0].id, warehouse_id: whId,
        folio: 'DUP', kind: 'faltante', responsible_kind: 'branch',
        dedup_key: `recv-line:${fDet.lines[0].id}`,
      });
    } catch (e) { dupBlocked = /unique|duplicate/i.test(e.message); }
    check('el UNIQUE del dedup_key impide dos reclamos del mismo renglón', dupBlocked, 'no falló el insert duplicado');

  } catch (e) {
    check('excepción no esperada', false, e.message);
  } finally {
    // Limpieza: el proveedor de prueba se BORRA (no se da de baja: `listSuppliers` no
    // filtra `deleted_at`, así que un soft-delete seguiría ensuciando /compras/proveedores
    // una fila por corrida). La FK del reclamo es ON DELETE SET NULL, así que los reclamos
    // de la corrida sobreviven sin proveedor — son data de prueba. El crosswalk sintético
    // también se borra. El almacén desechable y los reclamos quedan como historia, igual
    // que en el smoke de lotes.
    try {
      if (supplierId) await knex('catalog.suppliers').where({ id: supplierId }).del();
      await knex('commercial.erp_transfer_origin').where({ tenant_id: TENANT, code: TI_FAKE }).del();
    } catch (e) { console.log(`  (limpieza parcial: ${e.message})`); }
    await knex.destroy();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`WMS-REC.8 reclamos: ${pass}/${pass + fail} OK`);
  if (fail) console.log(`Fallos: ${failures.join(' · ')}`);
  process.exit(fail ? 1 : 0);
})();
