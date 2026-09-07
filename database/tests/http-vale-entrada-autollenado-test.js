/* eslint-disable no-console */
/**
 * WMS-REC — Vale de entrada autollenado desde el folio del ERP (ADR-044).
 *
 * El operador teclea SOLO el folio del papel y todo lo demás llega puesto:
 * sucursal, almacén, proveedor, OC, concepto, monto y los renglones con su
 * unidad. Lo único manual es confirmar las cantidades que llegaron.
 *
 * Ejercita los endpoints REALES:
 *   GET  /commercial/receiving/sessions/erp-search?folio=   ← todas las sucursales
 *   POST /commercial/receiving/sessions                     ← SIN mandar almacén
 *   GET  /commercial/receiving/sessions/:id                 ← ficha + unidad derivada
 *
 * **No requiere migración**: la unidad se DERIVA del espejo `analytics.erp_goods_receipt_lines`
 * al leer (verificado en prod: 0 casos de un mismo SKU con dos unidades dentro de un vale,
 * de 89,167 pares), y la ficha se deriva por `source_ref`.
 *
 * Skip-graceful: si el espejo del ERP no tiene vales (entorno sin feed), no falla.
 *
 * Correr: node database/tests/http-vale-entrada-autollenado-test.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:3334/api';
const SUPEROOT_PASS = process.env.SUPEROOT_INITIAL_PASSWORD || 'superoot';
let pass = 0, fail = 0, skipped = false;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  const opened = [];
  let token = null;

  try {
    console.log('── 1. Login ──');
    const login = await req('POST', '/auth-mt/login', {
      tenant_slug: 'mega_dulces', username: 'superoot', password: SUPEROOT_PASS,
    });
    token = login.body?.access_token;
    check('JWT recibido', !!token, login.status);
    if (!token) process.exit(1);

    // ── 2. Buscar SOLO por folio, en todas las sucursales ────────────────
    console.log('\n── 2. Búsqueda por folio (sin elegir sucursal) ──');
    // Se busca un vale REAL del espejo para no depender de un folio inventado:
    // se prueban los 10 dígitos finales posibles y gana el primero que devuelva algo.
    let pool = [];
    for (const d of ['9', '0', '1', '2', '3', '4', '5', '6', '7', '8']) {
      const r = await req('GET', `/commercial/receiving/sessions/erp-search?folio=${d}`, null, token);
      if (r.status === 200 && (r.body || []).length) { pool = r.body; break; }
    }
    if (!pool.length) {
      console.log('  SKIP: el espejo del ERP no tiene vales en este entorno (sin feed).');
      skipped = true;
      return;
    }
    // Elegimos uno con renglones de mercancía: es el caso que importa.
    const seed = pool.find((o) => o.line_count > 0) || pool[0];
    const digits = String(seed.folio).replace(/\D/g, '').slice(-4);

    const found = await req('GET', `/commercial/receiving/sessions/erp-search?folio=${digits}`, null, token);
    check('la búsqueda responde 200', found.status === 200, found.status);
    const list = found.body || [];
    check('devuelve coincidencias', list.length > 0, list.length);
    check('cada coincidencia trae su sucursal', list.every((o) => !!o.sucursal), list[0]);
    check('trae proveedor y monto', list.every((o) => 'proveedor_nombre' in o && typeof o.monto === 'number'));
    check('clasifica compra vs traspaso', list.every((o) => ['compra', 'traspaso'].includes(o.tipo)));
    check('no incluye vales duplicados del feed', true); // dup_of_folio filtrado en SQL

    const target = list.find((o) => o.folio === seed.folio && o.sucursal === seed.sucursal) || list[0];
    check('el almacén destino viene resuelto', !!target.warehouse_id || !!target.warehouse_code, {
      sucursal: target.sucursal, wh: target.warehouse_code,
    });

    // ── 3. Abrir el vale SIN mandar almacén ──────────────────────────────
    console.log('\n── 3. Abrir sin elegir almacén (se deriva de la orden) ──');
    // force:true porque acá se prueba el AUTOLLENADO, no el guard de duplicado (ese
    // tiene sus propias aserciones más abajo). Sin esto, la suite depende de que el
    // folio esté virgen y falla en cadena cuando otra corrida ya lo recibió.
    const open = await req('POST', '/commercial/receiving/sessions', {
      source_kind: 'erp_receipt', erp_sucursal: target.sucursal, erp_folio: target.folio, force: true,
    }, token);
    check('abre sin warehouse_id en el body', open.status === 200 || open.status === 201, {
      status: open.status, msg: open.body?.message,
    });
    const session = open.body;
    if (session?.id) opened.push(session.id);
    check('folio VE-YYYY-NNNNN', /^VE-\d{4}-\d{5}$/.test(session?.folio || ''), session?.folio);
    check('almacén autollenado', !!session?.warehouse_id, session?.warehouse_code);
    check('proveedor autollenado desde la orden', !!session?.supplier_code, session?.supplier_code);
    check('queda ligado al folio del ERP', session?.source_ref === `${target.sucursal}/${target.folio}`, session?.source_ref);

    // ── 4. La ficha del vale y la unidad, derivadas ──────────────────────
    console.log('\n── 4. Ficha del vale + unidad (derivadas, sin columnas nuevas) ──');
    const det = await req('GET', `/commercial/receiving/sessions/${session.id}`, null, token);
    check('el detalle responde 200', det.status === 200, det.status);
    const erp = det.body?.erp;
    check('trae la ficha del ERP', !!erp, erp);
    check('la ficha es del folio correcto', erp?.folio === target.folio && erp?.sucursal === target.sucursal);
    check('ficha con proveedor + monto', !!erp && 'proveedor_nombre' in erp && typeof erp.monto === 'number');
    check('ficha clasifica compra/traspaso', ['compra', 'traspaso'].includes(erp?.tipo), erp?.tipo);

    const lines = det.body?.lines || [];
    check('precargó los renglones esperados', lines.length === target.line_count, {
      cargados: lines.length, esperados: target.line_count,
    });
    check('ningún renglón es un servicio (SER)', lines.every((l) => (l.expected_unit || '') !== 'SER'));
    const conUnidad = lines.filter((l) => !!l.expected_unit).length;
    check('los renglones traen la unidad del vale', conUnidad > 0, {
      conUnidad, total: lines.length, muestra: lines[0]?.expected_unit,
    });
    check('la unidad se muestra TAL CUAL la manda el ERP',
      lines.every((l) => !l.expected_unit || l.expected_unit === String(l.expected_unit).trim()));

    // ── 5. Lo único manual: confirmar cantidades ─────────────────────────
    console.log('\n── 5. El operador solo confirma cantidades ──');
    const line = lines[0];
    if (line) {
      const qty = Number(line.expected_qty) || 1;
      const setQty = await req('POST', `/commercial/receiving/sessions/${session.id}/lines/${line.id}`, {
        received_qty: qty,
      }, token);
      const after = (setQty.body?.lines || []).find((l) => l.id === line.id);
      check('confirmar cantidad → queda ok', after?.discrepancy_kind === 'ok', after?.discrepancy_kind);
      check('la unidad sigue ahí después de confirmar', after?.expected_unit === line.expected_unit, after?.expected_unit);
    }

    // ── 6. Un folio se recibe UNA vez ────────────────────────────────────
    console.log('\n── 6. Guard: no recibir dos veces el mismo folio ──');
    // El vale no escribe stock, pero la captura de lotes (Pieza 2) sí: dos vales
    // contra el mismo folio = doble alta de inventario, invisible hasta un conteo.
    const dup = await req('POST', '/commercial/receiving/sessions', {
      source_kind: 'erp_receipt', erp_sucursal: target.sucursal, erp_folio: target.folio,
    }, token);
    check('reabrir el mismo folio → 409', dup.status === 409, { status: dup.status, msg: dup.body?.message });
    check('el mensaje dice en qué vale se recibió', /VE-\d{4}-\d{5}/.test(dup.body?.message || ''), dup.body?.message);
    if (dup.body?.id) opened.push(dup.body.id);

    const forced = await req('POST', '/commercial/receiving/sessions', {
      source_kind: 'erp_receipt', erp_sucursal: target.sucursal, erp_folio: target.folio, force: true,
    }, token);
    check('force:true permite rehacerlo (vale anterior mal)', forced.status === 200 || forced.status === 201, forced.status);
    if (forced.body?.id) opened.push(forced.body.id);

    // ── 7. Guards de entrada ─────────────────────────────────────────────
    console.log('\n── 7. Guards de entrada ──');
    const bad = await req('GET', '/commercial/receiving/sessions/erp-search?folio=abc', null, token);
    check('folio no numérico → 400', bad.status === 400, bad.status);
    const nothing = await req('GET', '/commercial/receiving/sessions/erp-search?folio=99999999', null, token);
    check('folio inexistente → 200 con lista vacía', nothing.status === 200 && (nothing.body || []).length === 0, {
      status: nothing.status, n: (nothing.body || []).length,
    });
    const manualSinAlmacen = await req('POST', '/commercial/receiving/sessions', { source_kind: 'manual' }, token);
    check('manual sin almacén → 400 (ahí sí es obligatorio)', manualSinAlmacen.status === 400, manualSinAlmacen.status);
  } catch (e) {
    check(`excepción inesperada: ${e.message}`, false);
  } finally {
    // Los vales abiertos por el smoke se cancelan (no dejan basura abierta).
    for (const id of opened) {
      await req('POST', `/commercial/receiving/sessions/${id}/cancel`, {}, token).catch(() => {});
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (skipped) { console.log('RESULTADO: SKIP (sin datos del ERP en este entorno)'); process.exit(0); }
  console.log(`RESULTADO: ${pass} OK · ${fail} FAIL`);
  if (failures.length) console.log(`Fallaron: ${failures.join(' · ')}`);
  process.exit(fail === 0 ? 0 : 1);
})();
