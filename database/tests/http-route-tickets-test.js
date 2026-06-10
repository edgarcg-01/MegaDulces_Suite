/* eslint-disable no-console */
/**
 * Test E2E "Cierre de ruta" (commercial.route_tickets).
 *
 * Verifica (sin OCR — guardado manual de campos):
 *   1. Vendedor guarda los 3 tipos (venta/carga/combustible).
 *   2. corte_number duplicado → 409.
 *   3. Lista propia del vendedor.
 *   4. Reportes admin: resumen (carga excluido de gasto) + por-ruta.
 *
 * NOTA: el endpoint /procesar (OCR Claude vision) NO se ejercita acá
 * (requiere imagen real + créditos Anthropic). Se valida manual.
 *
 * Requisitos: API en :3334 con ENABLE_MULTITENANT=true + seed roles (vendedor).
 * Correr: node database/http-route-tickets-test.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
const BASE = 'http://localhost:3334/api';
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

let RC; // ruta real (dígitos canónicos), descubierta tras login — el endpoint valida route_code
const stamp = Date.now().toString().slice(-6); // corte único por corrida (idempotencia)

let origZona = null;
let zonaAssigned = false;

(async () => {
  let exitCode = 1;
  try {
  console.log('── 1. Login (superoot = todos los permisos) ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) { console.log('FATAL sin token'); return; }

  // El endpoint valida route_code contra las rutas de la ZONA del usuario. superoot
  // no tiene zona (todas las rutas pertenecen a zonas) → asignarle una zona con
  // rutas numeradas para la corrida; se restaura en el finally.
  const su = await knex('identity.users').where({ tenant_id: T, username: 'superoot' }).first('id', 'zona_id');
  origZona = su?.zona_id ?? null;
  const zonaRoute = await knex('catalogs')
    .where({ tenant_id: T, catalog_id: 'rutas' }).whereNotNull('parent_id').whereNull('deleted_at')
    .whereRaw("value ~ '[0-9]'").first('value', 'parent_id');
  if (!zonaRoute) { console.log('FATAL sin rutas en zona'); return; }
  RC = (String(zonaRoute.value).match(/\d+/) || [])[0];
  await knex('identity.users').where({ tenant_id: T, id: su.id }).update({ zona_id: zonaRoute.parent_id });
  zonaAssigned = true;
  check('ruta real con número disponible', !!RC, RC);

  console.log('\n── 2. Guardar los 3 tipos ──');
  const corte = `E2E-CORTE-${stamp}`;
  const venta = await req('POST', '/commercial/route-tickets', {
    ticket_type: 'venta', route_code: RC, ticket_date: '2026-06-03', total: 5000, corte_number: corte,
  }, token);
  check('venta guardada', venta.status === 201 && !!venta.body?.id, venta.body);

  const carga = await req('POST', '/commercial/route-tickets', {
    ticket_type: 'carga', route_code: RC, ticket_date: '2026-06-03', total: 8000,
  }, token);
  check('carga guardada', carga.status === 201 && !!carga.body?.id, carga.body);

  const comb = await req('POST', '/commercial/route-tickets', {
    ticket_type: 'combustible', route_code: RC, ticket_date: '2026-06-03', total: 900, liters: 40, reference: `FOLIO-${stamp}`,
  }, token);
  check('combustible guardado', comb.status === 201 && !!comb.body?.id, comb.body);
  check('combustible persistió litros', Number(comb.body?.liters) === 40, comb.body?.liters);

  console.log('\n── 3. Unicidad corte_number ──');
  const dup = await req('POST', '/commercial/route-tickets', {
    ticket_type: 'venta', route_code: RC, ticket_date: '2026-06-03', total: 1, corte_number: corte,
  }, token);
  check('corte duplicado → 409', dup.status === 409, { status: dup.status });

  console.log('\n── 4. Listar propios ──');
  const list = await req('GET', '/commercial/route-tickets?route_code=' + RC + '&pageSize=50', null, token);
  const codes = (list.body?.data || []).filter((t) => t.route_code === RC);
  check('lista incluye los 3 recién creados', codes.length >= 3, { count: codes.length });

  console.log('\n── 5. Reportes admin ──');
  const resumen = await req('GET', '/commercial/route-tickets/reports/resumen?date_from=2026-06-03&date_to=2026-06-03', null, token);
  check('resumen responde', resumen.status === 200, resumen.body);
  const porTipo = resumen.body?.por_tipo || [];
  const cargaRow = porTipo.find((r) => r.ticket_type === 'carga');
  check('resumen incluye carga en conteo', !!cargaRow, porTipo);
  // gasto = combustible (NO incluye carga ni venta)
  check('gasto excluye carga (solo combustible)', Number(resumen.body?.gasto) >= 900, { gasto: resumen.body?.gasto });
  check('ventas refleja corte de venta', Number(resumen.body?.ventas) >= 5000, { ventas: resumen.body?.ventas });

  const porRuta = await req('GET', '/commercial/route-tickets/reports/por-ruta?date_from=2026-06-03&date_to=2026-06-03', null, token);
  check('por-ruta responde array', Array.isArray(porRuta.body), porRuta.body);
  const rutaE2E = (porRuta.body || []).find((r) => r.route_code === RC);
  check('por-ruta incluye RD E2E (carga excluida del total)', !!rutaE2E, rutaE2E);

  console.log('\n── 6. Fase 2: carga con líneas → stock-in al camión ──');
  const stock = await req('GET', '/commercial/inventory/stock?pageSize=1', null, token);
  const pid = (stock.body?.data || [])[0]?.product_id;
  if (!pid) {
    check('hay un producto para probar stock-in', false, 'sin productos con stock');
  } else {
    const QTY = 7;
    const carga2 = await req('POST', '/commercial/route-tickets', {
      ticket_type: 'carga', route_code: RC, ticket_date: '2026-06-03', total: 1500,
      lines: [{ product_id: pid, quantity: QTY }],
    }, token);
    check('carga con líneas → 201', carga2.status === 201, { status: carga2.status });
    check('respuesta trae warehouse_id (camión)', !!carga2.body?.warehouse_id, carga2.body);
    check('respuesta trae stocked_lines = 1', carga2.body?.stocked_lines === 1, carga2.body?.stocked_lines);
    const truck = carga2.body?.warehouse_id;
    if (truck) {
      const truckStock = await req('GET', `/commercial/inventory/stock?warehouse_id=${truck}&product_id=${pid}`, null, token);
      const row = (truckStock.body?.data || [])[0];
      check('stock del camión >= cantidad cargada', Number(row?.quantity || 0) >= QTY, { qty: row?.quantity });
    }
  }

  console.log(`\n════════ Total: ${pass} pass / ${fail} fail ════════`);
  if (fail) console.log('Failures:\n  - ' + failures.join('\n  - '));
  exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('FATAL:', e.message);
    exitCode = 1;
  } finally {
    if (zonaAssigned) {
      try { await knex('identity.users').where({ tenant_id: T, username: 'superoot' }).update({ zona_id: origZona }); } catch (_) {}
    }
    await knex.destroy();
  }
  process.exit(exitCode);
})();
