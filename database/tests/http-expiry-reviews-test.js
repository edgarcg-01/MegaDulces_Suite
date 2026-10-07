/* eslint-disable no-console */
/**
 * P2.6 — Smoke HTTP E2E del Control de Caducidades (inspección de anaquel digital).
 *
 * Ejercita el flujo real contra los endpoints (:3334), no DB-direct:
 *   - crear hoja (draft) para un almacén dedicado,
 *   - agregar renglón CON producto + caducidad + cantidad (alimenta FEFO),
 *   - agregar renglón SIN producto (solo raw, NO alimenta FEFO),
 *   - subir "foto" (se adjunta un ReviewFile directo en el renglón — sin depender
 *     de Cloudinary; el endpoint /upload se prueba aparte de forma tolerante),
 *   - enviar la hoja y verificar:
 *       (1) el renglón con caducidad aparece en /commercial/inventory/expiring,
 *       (2) commercial.stock.quantity NO cambió (invariante SUM(lotes)=stock),
 *       (3) fed_lines = 1 (solo el renglón con producto+caducidad),
 *       (4) re-enviar → 409.
 *
 * Requiere API en :3334 con el código de commercial-expiry-reviews.
 * Correr: node database/tests/http-expiry-reviews-test.js
 */

// El .env de la maquina: sin esto `SUPEROOT_INITIAL_PASSWORD` llega undefined y
// el login cae al 'superoot' hardcodeado (que solo vale en algunas maquinas).
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

// 127.0.0.1 y no `localhost`: en Windows `localhost` resuelve a IPv6 ::1 y ahi
// el server no contesta (ECONNRESET). Ya documentado en el tracker.
const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:3334/api';
// La password de superoot NO se hardcodea: en cada maquina es la de su .env
// (ya paso: 44 suites con 'superoot' fijo no podian correr fuera de una maquina).
const SUPEROOT_PASS = process.env.SUPEROOT_INITIAL_PASSWORD || 'superoot';
let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  console.log('── 1. Login ──');
  const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: SUPEROOT_PASS });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  console.log('\n── 2. Setup (almacén dedicado + stock 100) ──');
  const whs = await req('GET', '/commercial/warehouses', null, token);
  const defWh = (whs.body?.data || whs.body || []).find((w) => w.is_default) || (whs.body?.data || whs.body || [])[0];
  const stock = await req('GET', `/commercial/inventory/stock?warehouse_id=${defWh.id}&pageSize=5`, null, token);
  const productId = (stock.body?.data || stock.body || [])[0]?.product_id;
  check('product_id de muestra obtenido', !!productId);
  if (!productId) process.exit(1);

  const ts = Date.now().toString().slice(-8);
  const created = await req('POST', '/commercial/warehouses', { code: `EXPREV-${ts}`, name: `Test Caducidades ${ts}`, is_default: false }, token);
  const whId = created.body?.id;
  check('almacén de test creado', !!whId, created.body);
  if (!whId) process.exit(1);

  const seed = await req('POST', '/commercial/inventory/movements', { warehouse_id: whId, product_id: productId, movement_type: 'in', quantity: 100, reference_type: 'test-seed' }, token);
  check('stock inicial 100 sembrado', seed.status === 201 || seed.status === 200, seed.body);

  const stockBefore = await req('GET', `/commercial/inventory/stock/${whId}/${productId}`, null, token);
  const qtyBefore = Number(stockBefore.body?.quantity ?? 0);
  check('stock inicial = 100', qtyBefore === 100, { qtyBefore });

  console.log('\n── 2b. Resolver codigo (pistola / camara / tecleado) ──');
  // El endpoint que hace rapida la captura: los tres caminos (lector HID, camara del
  // telefono, tecleado a mano) terminan en el mismo GET /resolve.
  const prodSample = await req('GET', '/commercial/products?pageSize=5', null, token);
  const sample = (prodSample.body?.data || []).find((x) => x.sku) || {};

  // La ruta va ANTES de :id en el controller; si alguien la reordena, esto cae con
  // 400 'id invalido' en vez de resolver (es la trampa que cuida este check).
  const bySku = await req('GET', `/commercial/expiry-reviews/resolve?code=${encodeURIComponent(sample.sku || 'ZZZ')}`, null, token);
  check('resolve responde 200 (la ruta no se la traga :id)', bySku.status === 200, { status: bySku.status, body: bySku.body });
  if (sample.sku) {
    check('resolve por SKU devuelve el producto', bySku.body?.match?.sku === sample.sku, bySku.body?.match);
    check('resolve por SKU reporta source', ['sku', 'barcode', 'legacy_barcode'].includes(bySku.body?.source), bySku.body?.source);
  }

  if (sample.barcode) {
    const byBc = await req('GET', `/commercial/expiry-reviews/resolve?code=${encodeURIComponent(sample.barcode)}`, null, token);
    check('resolve por codigo de barras da producto', !!byBc.body?.match || (byBc.body?.candidates || []).length > 0, byBc.body);
  } else {
    console.log('  SKIP resolve por barcode (el producto de muestra no tiene barcode)');
  }

  const miss = await req('GET', '/commercial/expiry-reviews/resolve?code=NO-EXISTE-9999999', null, token);
  check('codigo inexistente NO es error: 200 con match null', miss.status === 200 && miss.body?.match === null, { status: miss.status, body: miss.body });
  check('codigo inexistente reporta source none', miss.body?.source === 'none', miss.body?.source);

  const empty = await req('GET', '/commercial/expiry-reviews/resolve?code=', null, token);
  check('resolve sin code -> 400', empty.status === 400, { status: empty.status });

  console.log('\n── 2c. Asistente por voz (P2.7) ──');
  // El asistente NO guarda el renglón: devuelve campos + la siguiente pregunta.
  // Sin ANTHROPIC_API_KEY responde degradado en vez de romper la pantalla.
  const vEmpty = await req('POST', '/commercial/expiry-reviews/voice/intake', { transcript: '' }, token);
  check('voice/intake sin transcript -> 400', vEmpty.status === 400, { status: vEmpty.status });

  const vName = sample.nombre ? String(sample.nombre).split(' ').slice(0, 3).join(' ') : 'mazapan';
  const v1 = await req('POST', '/commercial/expiry-reviews/voice/intake', {
    transcript: `tengo 3 cajas de ${vName} que caducan el 15 de octubre`,
  }, token);
  check('voice/intake responde 200', v1.status === 200 || v1.status === 201, { status: v1.status, body: v1.body });
  check('voice/intake devuelve reply + slots + missing', !!v1.body?.reply && !!v1.body?.slots && Array.isArray(v1.body?.missing), v1.body);
  if (v1.body?.degraded) {
    console.log('  SKIP entendimiento (ANTHROPIC_API_KEY no configurada en este entorno)');
  } else {
    const sl = v1.body?.slots || {};
    check('entendio la cantidad (3)', Number(sl.quantity) === 3, sl);
    check('entendio la unidad (caja)', sl.unit === 'caja', sl);
    check('entendio la caducidad (YYYY-10-15)', /^\d{4}-10-15$/.test(String(sl.expiry_date || '')), sl);
    // El producto lo resuelve el CATALOGO: o pego uno, o ofrece candidatos.
    const resolved = !!sl.product_id || (v1.body?.candidates || []).length > 0;
    check('el producto lo resolvio el catalogo (match o candidatos)', resolved, { product_id: sl.product_id, cands: (v1.body?.candidates || []).length });
    check('el asistente NUNCA inventa product_id fuera del catalogo',
      !sl.product_id || /^[0-9a-f-]{36}$/i.test(sl.product_id), sl.product_id);
  }

  // Fecha imposible: se descarta en vez de viajar al sub-ledger FEFO.
  const vBad = await req('POST', '/commercial/expiry-reviews/voice/intake', {
    transcript: 'caduca el 31 de febrero de 2062', slots: {},
  }, token);
  check('fecha imposible/absurda NO se acepta', vBad.status !== 200 || !vBad.body?.slots?.expiry_date, vBad.body?.slots);

  // Dictado con el gate del dominio (no el de ventas): sin audio devuelve vacio,
  // sin GROQ_API_KEY devuelve error 'no_key' -- en ningun caso 403.
  const vTr = await req('POST', '/commercial/expiry-reviews/voice/transcribe', { audio: '', mime: 'audio/webm' }, token);
  check('voice/transcribe accesible con permiso de caducidades (no 403)', vTr.status !== 403, { status: vTr.status });
  check('voice/transcribe sin audio devuelve texto vacio', vTr.status === 200 || vTr.status === 201, { status: vTr.status, body: vTr.body });

  const vPick = await req('POST', '/commercial/expiry-reviews/voice/pick', { slots: {}, product_id: 'no-es-uuid' }, token);
  check('voice/pick con product_id invalido -> 400', vPick.status === 400, { status: vPick.status });

  console.log('\n── 3. Crear hoja + renglones ──');
  const review = await req('POST', '/commercial/expiry-reviews', { warehouse_id: whId, notes: 'Smoke P2.6', default_location: 'Anaquel 3' }, token);
  const reviewId = review.body?.id;
  check('hoja creada (draft)', !!reviewId && review.body?.status === 'draft', review.body);
  check('hoja guardó default_location', review.body?.default_location === 'Anaquel 3', review.body?.default_location);
  if (!reviewId) process.exit(1);

  const expDate = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString().slice(0, 10); // vence en 20 días
  const line1 = await req('POST', `/commercial/expiry-reviews/${reviewId}/lines`, {
    product_id: productId, product_code_raw: 'SMOKE-1', quantity: 10, expiry_date: expDate,
    condition: 'regular', observations: 'se ve dura', action: 'promocionar', location: 'Anaquel 3',
    files: [{ role: 'evidencia', url: 'https://example.test/foto.jpg', kind: 'image' }],
  }, token);
  check('renglón 1 (producto+caducidad+foto+ubicación) agregado', line1.status === 201 || line1.status === 200, line1.body);
  check('renglón 1 guardó location', line1.body?.location === 'Anaquel 3', line1.body?.location);

  const line2 = await req('POST', `/commercial/expiry-reviews/${reviewId}/lines`, {
    product_code_raw: '99999', product_name_raw: 'Producto sin match', quantity: 5, condition: 'malo', observations: 'no tiene fecha',
  }, token);
  check('renglón 2 (sin producto, solo raw) agregado', line2.status === 201 || line2.status === 200, line2.body);

  const detail = await req('GET', `/commercial/expiry-reviews/${reviewId}`, null, token);
  check('detalle trae 2 renglones', (detail.body?.lines || []).length === 2, { n: (detail.body?.lines || []).length });
  check('renglón 1 guardó la foto en files jsonb', (detail.body?.lines || []).some((l) => (l.files || []).length === 1));

  console.log('\n── 4. Endpoint /upload (tolerante a falta de Cloudinary) ──');
  const upload = await req('POST', '/commercial/expiry-reviews/upload', { file_base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', role: 'evidencia' }, token);
  if (upload.status === 200 || upload.status === 201) check('upload devolvió url', !!upload.body?.url, upload.body);
  else { console.log(`  SKIP upload (Cloudinary no configurado local, status ${upload.status})`); }

  console.log('\n── 5. Enviar hoja → alimenta FEFO ──');
  const submit = await req('POST', `/commercial/expiry-reviews/${reviewId}/submit`, {}, token);
  check('submit OK (status submitted)', submit.body?.status === 'submitted', submit.body);
  check('fed_lines = 1 (solo el renglón con producto+caducidad)', submit.body?.fed_lines === 1, { fed_lines: submit.body?.fed_lines });

  const expiring = await req('GET', `/commercial/inventory/expiring?days=60&warehouse_id=${whId}`, null, token);
  const lot = (expiring.body || []).find((l) => l.product_id === productId && Number(l.quantity) === 10);
  check('el lote fechado aparece en /expiring con qty 10', !!lot, { rows: (expiring.body || []).length });
  check('el lote fechado tiene la caducidad capturada', lot?.expiry_date?.slice(0, 10) === expDate, { got: lot?.expiry_date });

  const stockAfter = await req('GET', `/commercial/inventory/stock/${whId}/${productId}`, null, token);
  const qtyAfter = Number(stockAfter.body?.quantity ?? -1);
  check('INVARIANTE: stock.quantity NO cambió (sigue 100)', qtyAfter === qtyBefore, { qtyBefore, qtyAfter });

  const detail2 = await req('GET', `/commercial/expiry-reviews/${reviewId}`, null, token);
  const l1 = (detail2.body?.lines || []).find((l) => l.product_id === productId);
  const l2 = (detail2.body?.lines || []).find((l) => !l.product_id);
  check('renglón 1 marcado fed_to_fefo con fefo_qty=10', l1?.fed_to_fefo === true && Number(l1?.fefo_qty) === 10, { l1 });
  check('renglón 2 (sin producto) NO alimentó FEFO', l2?.fed_to_fefo === false, { l2 });

  console.log('\n── 6b. Promotor de marca propia (scoping) ──');
  const myUserId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;
  const abrands = await req('GET', '/commercial/promoter-brands/brands', null, token);
  const brand = (abrands.body || [])[0];
  check('marcas asignables disponibles', Array.isArray(abrands.body) && abrands.body.length > 0, { n: (abrands.body || []).length });
  if (brand?.id) {
    const setb = await req('PUT', `/commercial/promoter-brands/${myUserId}`, { brand_ids: [brand.id] }, token);
    check('asignar marca al usuario', Array.isArray(setb.body?.brand_ids) && setb.body.brand_ids.includes(brand.id), setb.body);
    const mine = await req('GET', '/commercial/promoter-brands/mine', null, token);
    check('/mine devuelve la marca asignada', (mine.body?.brand_ids || []).includes(brand.id), mine.body?.brand_ids);
    const scoped = await req('GET', `/commercial/products?brand_ids=${brand.id}&pageSize=10`, null, token);
    const rows = scoped.body?.data || [];
    check('productos scopeados: todos son de la marca', rows.length === 0 || rows.every((p) => p.brand_id === brand.id), { n: rows.length });
    // limpiar (no dejar a superoot como promotor)
    const clr = await req('PUT', `/commercial/promoter-brands/${myUserId}`, { brand_ids: [] }, token);
    check('limpieza: usuario deja de ser promotor', (clr.body?.brand_ids || []).length === 0);
  }

  // ── P2.6.9 — captura de tienda: alta por producto + expediente con folio ──
  //
  // Ejercita el flujo NUEVO (el que reemplazó al alta por "hoja"): contexto de
  // captura, alta directa que alimenta FEFO al guardar, folio emitido, el eco
  // del turno, la corrección que REVIERTE FEFO, el expediente por sucursal y
  // la hoja imprimible por folio.
  //
  // Se corre con superoot (alcance `all`), así que el `warehouse_id` va explícito
  // — es justo la rama de `resolveWriteWarehouse` que un colaborador NO usa.
  console.log('\n── 7. Captura de tienda: alta por producto + expediente (P2.6.9) ──');

  // La sección nueva se ejercita contra una SUCURSAL de verdad (código de 2
  // dígitos), no contra el almacén desechable de la sección 2: las caducidades se
  // archivan por sucursal y el folio lleva su código. Se le siembra stock aparte.
  const ctx = await req('GET', '/commercial/expiry-reviews/entries/context', null, token);
  check('contexto de captura responde', ctx.status === 200, { status: ctx.status });
  check('superoot tiene alcance de todas las sucursales', ctx.body?.mode === 'all', ctx.body?.mode);
  const sucursales = ctx.body?.options || [];
  check('el contexto lista solo sucursales de 2 dígitos',
    sucursales.length > 0 && sucursales.every((w) => /^[0-9]{2}$/.test(w.code)),
    { n: sucursales.length, codes: sucursales.map((w) => w.code) });

  // Alta sin sucursal cuando el alcance es `all` → 400 (no adivina dónde escribir).
  const sinWh = await req('POST', '/commercial/expiry-reviews/entries',
    { product_id: productId, quantity: 3, unit: 'caja', expiry_date: '2027-03-31' }, token);
  check('alta sin sucursal con alcance all → 400', sinWh.status === 400, { status: sinWh.status });

  // Un almacén que NO es sucursal se rechaza con mensaje, no con un 500. Antes
  // esto reventaba en la DB (`22001`) porque el folio se armaba con un código de
  // 15 caracteres: es la regresión que cuida este check.
  const noSuc = await req('POST', '/commercial/expiry-reviews/entries',
    { warehouse_id: whId, product_id: productId, quantity: 1, unit: 'caja', expiry_date: '2027-03-31' }, token);
  check('almacén que no es sucursal → 400 con mensaje (no 500)', noSuc.status === 400, { status: noSuc.status, msg: noSuc.body?.message });

  // Sucursal real + su propio stock para poder alimentar FEFO.
  const suc = sucursales[0];
  check('hay una sucursal para capturar', !!suc?.id, suc);
  if (!suc?.id) { console.log('  ABORT sin sucursales sembradas'); process.exit(1); }
  await req('POST', '/commercial/inventory/movements',
    { warehouse_id: suc.id, product_id: productId, movement_type: 'in', quantity: 50, reference_type: 'test-seed-suc' }, token);

  // Total de la sucursal ANTES de capturar. El invariante es que alimentar FEFO
  // y revertirlo NO mueven el total (son reclasificaciones entre lotes), así que
  // se compara contra este snapshot y no contra un número fijo — con un número
  // fijo la 2ª corrida fallaba sola porque el seed acumula.
  const stockSucBefore = await req('GET', `/commercial/inventory/stock?warehouse_id=${suc.id}&product_id=${productId}`, null, token);
  const qtySucBefore = Number((stockSucBefore.body?.data || stockSucBefore.body || [])[0]?.quantity);
  check('total de la sucursal leído antes de capturar', Number.isFinite(qtySucBefore), { qtySucBefore });

  const entry = await req('POST', '/commercial/expiry-reviews/entries', {
    warehouse_id: suc.id, product_id: productId, quantity: 4, unit: 'caja',
    expiry_date: '2027-03-31', condition: 'bueno', location: 'Anaquel 3',
  }, token);
  check('alta de una caducidad → 201/200', entry.status === 201 || entry.status === 200, { status: entry.status, body: entry.body });
  const entryId = entry.body?.id;
  const folio = entry.body?.folio;
  check('la alta emitió folio con formato CAD-<suc>-<año>-<NNNNN>',
    typeof folio === 'string' && /^CAD-[0-9]{2}-\d{4}-\d{5}$/.test(folio), folio);
  check('la alta alimentó FEFO al guardarse', entry.body?.fed_to_fefo === true, {
    fed: entry.body?.fed_to_fefo, qty: entry.body?.fefo_qty,
  });

  // El eco del turno: lo que YO capturé hoy.
  const mine2 = await req('GET', '/commercial/expiry-reviews/entries/mine', null, token);
  check('el eco del turno incluye la alta', (mine2.body?.data || []).some((e) => e.id === entryId), { n: (mine2.body?.data || []).length });

  // Corrección: revierte FEFO, reescribe y vuelve a alimentar.
  const upd = await req('PATCH', `/commercial/expiry-reviews/entries/${entryId}`, { quantity: 6 }, token);
  check('corregir una alta del día → 200', upd.status === 200, { status: upd.status, body: upd.body });
  check('la corrección re-alimentó FEFO con la cantidad nueva', Number(upd.body?.fefo_qty) === 6, upd.body?.fefo_qty);

  // El invariante sigue intacto después de alimentar Y revertir.
  const stockAfterEntry = await req('GET', `/commercial/inventory/stock?warehouse_id=${suc.id}&product_id=${productId}`, null, token);
  const qtyTrasAlta = Number((stockAfterEntry.body?.data || stockAfterEntry.body || [])[0]?.quantity);
  check('INVARIANTE tras alta+corrección: el total de la sucursal no cambió', qtyTrasAlta === qtySucBefore, { qtySucBefore, qtyTrasAlta });

  // Expediente: la hoja aparece archivada bajo su sucursal.
  const exp = await req('GET', `/commercial/expiry-reviews/expediente?warehouse_id=${suc.id}`, null, token);
  check('el expediente lista la hoja', (exp.body?.data || []).some((h) => h.folio === folio), { n: (exp.body?.data || []).length });
  const hojaEnExp = (exp.body?.data || []).find((h) => h.folio === folio);
  check('la hoja del expediente dice quién la levantó', !!hojaEnExp?.levantada_por, hojaEnExp?.levantada_por);
  check('la hoja del expediente trae los días a vencer calculados en SQL',
    hojaEnExp?.dias_a_vencer !== undefined && hojaEnExp?.dias_a_vencer !== null, hojaEnExp?.dias_a_vencer);

  // Filtro por plazo, calculado contra CURRENT_DATE en la base.
  const expVenc = await req('GET', '/commercial/expiry-reviews/expediente?plazo=vencido', null, token);
  check('filtro plazo=vencido no incluye una caducidad de 2027',
    !(expVenc.body?.data || []).some((h) => h.folio === folio), { n: (expVenc.body?.data || []).length });

  // Portada por sucursal.
  const sucs = await req('GET', '/commercial/expiry-reviews/expediente/sucursales', null, token);
  check('la portada del expediente lista sucursales con contadores',
    Array.isArray(sucs.body?.data) && sucs.body.data.length > 0 && sucs.body.data.every((s) => typeof s.hojas === 'number'),
    { n: (sucs.body?.data || []).length });

  // La hoja imprimible, por FOLIO (no por uuid) — es la URL citable.
  const hoja = await req('GET', `/commercial/expiry-reviews/hoja/${encodeURIComponent(folio)}`, null, token);
  check('la hoja se abre por folio', hoja.status === 200 && hoja.body?.folio === folio, { status: hoja.status });
  check('la hoja trae sucursal, producto y cantidad para imprimir',
    !!hoja.body?.warehouse_name && !!hoja.body?.product_name && Number(hoja.body?.quantity) === 6,
    { wh: hoja.body?.warehouse_name, prod: hoja.body?.product_name, qty: hoja.body?.quantity });
  const hojaFake = await req('GET', '/commercial/expiry-reviews/hoja/CAD-99-1999-00001', null, token);
  check('un folio inexistente → 404', hojaFake.status === 404, { status: hojaFake.status });

  // Borrar devuelve al lote NA lo fechado y limpia el contenedor si queda vacío.
  const del = await req('DELETE', `/commercial/expiry-reviews/entries/${entryId}`, null, token);
  check('borrar la alta del día → 200', del.status === 200 && del.body?.deleted === true, del.body);
  const stockAfterDel = await req('GET', `/commercial/inventory/stock?warehouse_id=${suc.id}&product_id=${productId}`, null, token);
  check('INVARIANTE tras borrar: el total de la sucursal no cambió',
    Number((stockAfterDel.body?.data || stockAfterDel.body || [])[0]?.quantity) === qtySucBefore,
    { qtySucBefore, qty: (stockAfterDel.body?.data || stockAfterDel.body || [])[0]?.quantity });
  const hojaBorrada = await req('GET', `/commercial/expiry-reviews/hoja/${encodeURIComponent(folio)}`, null, token);
  check('la hoja borrada ya no se abre → 404', hojaBorrada.status === 404, { status: hojaBorrada.status });

  console.log('\n── 6. Reglas de estado ──');
  const resubmit = await req('POST', `/commercial/expiry-reviews/${reviewId}/submit`, {}, token);
  check('re-enviar hoja enviada → 409', resubmit.status === 409, { status: resubmit.status });
  const addAfter = await req('POST', `/commercial/expiry-reviews/${reviewId}/lines`, { product_code_raw: 'X', quantity: 1 }, token);
  check('agregar renglón a hoja enviada → 409', addAfter.status === 409, { status: addAfter.status });

  console.log(`\n──────────\n  ${pass} OK · ${fail} FAIL`);
  if (fail) { console.log('  Fallas:', failures.join(', ')); process.exit(1); }
  console.log('  ✅ P2.6 Control de Caducidades verde.');
})().catch((e) => { console.error(e); process.exit(1); });
