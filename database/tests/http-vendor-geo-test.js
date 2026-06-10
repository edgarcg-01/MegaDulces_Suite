/* eslint-disable no-console */
/**
 * Test E2E V.6 — autodetección de llegada del vendedor + anti-traslape.
 *
 * Cubre:
 *   1. GET /commercial/vendor-routes/nearby — cartera con coords, ranked por
 *      distancia, filtrada por radio (excluye los que están fuera).
 *   2. POST /commercial/vendor-routes/customers/:id/location — guard anti-traslape:
 *      coords que colisionan con otro cliente (< 25 m) → conflict; con force → set.
 *   3. POST /commercial/vendor-routes/check-in con lat/lng — backfill capture-on-visit
 *      cuando el cliente no tiene coords; idempotente (no re-pisa si ya tiene).
 *
 * Setup: asigna una sales_route de prueba (GEO-TEST-<stamp>) a superoot + 4 clientes
 * test con coords conocidas. Restaura en finally.
 *
 * Requisitos: API en :3334 con ENABLE_MULTITENANT=true (reiniciada con el código V.6).
 * Correr: node database/tests/http-vendor-geo-test.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
const BASE = 'http://localhost:3334/api';
const T = '00000000-0000-0000-0000-00000000d01c';
const stamp = Date.now().toString().slice(-6);
const ROUTE = `GEO-TEST-${stamp}`;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

// Punto de referencia (Morelia) + offsets calculados.
const P = { lat: 19.700000, lng: -101.200000 };
const C2 = { lat: 19.700000, lng: -101.199618 }; // ~40 m al E de P (dentro de radio, > 25 m sep)
const C3_FAR = { lat: 19.705426, lng: -101.200000 }; // ~600 m al N (fuera de radio 80)
const C3_NEAR = { lat: 19.700081, lng: -101.200000 }; // ~9 m de P (colisiona con C1)
const C4_CLEAR = { lat: 19.690000, lng: -101.200000 }; // ~1.1 km (sin colisión)

const ids = {};

(async () => {
  let exitCode = 1;
  try {
    console.log('── 1. Login superoot ──');
    const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
    const token = login.body?.access_token;
    check('JWT recibido', !!token);
    if (!token) return;

    const su = await knex('identity.users').where({ tenant_id: T, username: 'superoot' }).first('id');
    check('superoot existe', !!su?.id);

    // Setup: 4 clientes test + asignación de ruta a superoot.
    const mk = async (suffix, lat, lng) => {
      const [row] = await knex('commercial.customers')
        .insert({ tenant_id: T, code: `GEO-${stamp}-${suffix}`, name: `Geo Test ${suffix}`, sales_route: ROUTE, latitude: lat, longitude: lng })
        .returning('id');
      return row.id || row;
    };
    ids.c1 = await mk('C1', P.lat, P.lng);
    ids.c2 = await mk('C2', C2.lat, C2.lng);
    ids.c3 = await mk('C3', C3_FAR.lat, C3_FAR.lng);
    ids.c4 = await mk('C4', null, null); // sin coords → para probar backfill
    await knex('commercial.vendor_sales_routes')
      .insert({ tenant_id: T, user_id: su.id, sales_route: ROUTE })
      .onConflict(['tenant_id', 'user_id', 'sales_route']).ignore();

    console.log('\n── 2. nearby: ranking + radio ──');
    const near = await req('GET', `/commercial/vendor-routes/nearby?lat=${P.lat}&lng=${P.lng}&radius=80`, null, token);
    check('nearby responde array', Array.isArray(near.body), near.body);
    const list = near.body || [];
    const found = list.filter((x) => [ids.c1, ids.c2, ids.c3].includes(x.id));
    check('incluye C1 y C2, excluye C3 (fuera de 80 m)', found.length === 2 && !found.some((x) => x.id === ids.c3), found.map((x) => `${x.code}:${x.distance_m}m`));
    check('C1 primero (más cercano, ~0 m)', list[0]?.id === ids.c1, { first: list[0]?.code, d: list[0]?.distance_m });
    const c1row = list.find((x) => x.id === ids.c1);
    const c2row = list.find((x) => x.id === ids.c2);
    check('C1 distancia ~0 m', c1row && Number(c1row.distance_m) <= 2, c1row?.distance_m);
    check('C2 distancia ~40 m (30–55)', c2row && Number(c2row.distance_m) >= 30 && Number(c2row.distance_m) <= 55, c2row?.distance_m);

    console.log('\n── 3. set-location: guard anti-traslape ──');
    const conflict = await req('POST', `/commercial/vendor-routes/customers/${ids.c3}/location`, { latitude: C3_NEAR.lat, longitude: C3_NEAR.lng, force: false }, token);
    check('coords colisionantes → location_set=false', conflict.body?.location_set === false, conflict.body);
    check('reporta el cliente en conflicto (C1)', conflict.body?.conflict?.customer_id === ids.c1, conflict.body?.conflict);
    check('distancia del conflicto ~9 m (≤ 25)', Number(conflict.body?.conflict?.distance_m) <= 25, conflict.body?.conflict?.distance_m);
    const forced = await req('POST', `/commercial/vendor-routes/customers/${ids.c3}/location`, { latitude: C3_NEAR.lat, longitude: C3_NEAR.lng, force: true }, token);
    check('con force=true → location_set=true', forced.body?.location_set === true, forced.body);

    console.log('\n── 4. check-in: backfill capture-on-visit ──');
    const ci1 = await req('POST', '/commercial/vendor-routes/check-in', { customer_id: ids.c4, latitude: C4_CLEAR.lat, longitude: C4_CLEAR.lng }, token);
    check('check-in con coords → visita creada', !!ci1.body?.id, ci1.body);
    check('cliente sin coords → backfill location_set=true', ci1.body?.location?.location_set === true, ci1.body?.location);
    const c4 = await knex('commercial.customers').where({ id: ids.c4 }).first('latitude', 'longitude');
    check('coords persistidas en el cliente', c4?.latitude != null && c4?.longitude != null, c4);
    const ci2 = await req('POST', '/commercial/vendor-routes/check-in', { customer_id: ids.c4, latitude: C4_CLEAR.lat, longitude: C4_CLEAR.lng }, token);
    check('2do check-in NO re-backfillea (ya tiene coords)', ci2.body?.location == null, ci2.body?.location);

    console.log(`\n════════ Total: ${pass} pass / ${fail} fail ════════`);
    if (fail) console.log('Failures:\n  - ' + failures.join('\n  - '));
    exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('FATAL:', e.message);
    exitCode = 1;
  } finally {
    try {
      for (const id of Object.values(ids)) {
        if (id) await knex('commercial.customers').where({ id }).del();
      }
      await knex('commercial.vendor_sales_routes').where({ tenant_id: T, sales_route: ROUTE }).del();
    } catch (_) {}
    await knex.destroy();
  }
  process.exit(exitCode);
})();
