/* eslint-disable no-console */
/**
 * Smoke HTTP — módulo "Mapa Comercial" (CM.1 backend).
 *
 * Verifica los endpoints:
 *   GET /commercial-map/stores                 → tiendas con coord híbrida + presencia
 *   GET /commercial-map/stores?presence=...     → filtro de presencia (server)
 *   GET /commercial-map/stores/:id/history       → historial propio vs competencia
 * + id inválido (404) + aislamiento de tenant.
 *
 * Fuente: daily_captures.exhibiciones (JSONB) + flag perteneceMegaDulces. NO usa
 * las tablas normalizadas visits/exhibitions (código muerto).
 *
 * Requisitos: API :3334 con CM.1 (COMMERCIAL_MAP_VER + endpoints) — REINICIAR
 * antes de correr. Login superoot (manage:all) pasa el gate COMMERCIAL_MAP_VER.
 * Correr: node database/tests/http-commercial-map-test.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const BASE = 'http://localhost:3334/api';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, det) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det !== undefined ? ` — ${JSON.stringify(det)}` : ''}`); failures.push(name); fail++; }
}
async function req(method, path, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

(async () => {
  console.log('── 1. Login superoot ──');
  const lr = await fetch(`${BASE}/auth-mt/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' }) });
  const token = (await lr.json())?.access_token;
  check('JWT recibido', !!token);
  if (!token) { console.log('FATAL sin token'); process.exit(1); }

  console.log('\n── 2. GET /commercial-map/stores ──');
  const r = await req('GET', '/commercial-map/stores', token);
  check('stores 200', r.status === 200, r.status);
  const body = r.body || {};
  const stores = Array.isArray(body.stores) ? body.stores : [];
  check('devuelve stores[]', stores.length > 0, stores.length);
  check('total + unlocatedCount numéricos', typeof body.total === 'number' && typeof body.unlocatedCount === 'number', { total: body.total, unloc: body.unlocatedCount });
  check('cada tienda trae presence + located (bool)', stores.every((s) => typeof s.located === 'boolean' && !!s.presence), stores[0]);
  check('hay tiendas ubicables con lat/lng numérico', stores.some((s) => s.located && typeof s.lat === 'number' && typeof s.lng === 'number'), stores.find((s) => s.located));
  check('trae conteo own/competitor por tienda', stores.every((s) => typeof s.own === 'number' && typeof s.competitor === 'number'), stores[0]);
  const withComp = stores.filter((s) => s.presence === 'competitor' || s.presence === 'both');
  const withOwn = stores.filter((s) => s.presence === 'own' || s.presence === 'both');
  console.log(`     ubicables=${stores.filter((s) => s.located).length} | con competencia=${withComp.length} | con Mega Dulces=${withOwn.length}`);

  console.log('\n── 3. Filtro de presencia (?presence=competitor) ──');
  const rc = await req('GET', '/commercial-map/stores?presence=competitor', token);
  check('presence filter 200', rc.status === 200, rc.status);
  const cstores = rc.body?.stores || [];
  check('todas las devueltas son presence=competitor', cstores.length > 0 && cstores.every((s) => s.presence === 'competitor'), cstores.slice(0, 2).map((s) => s.presence));

  console.log('\n── 3b. Filtro de fechas (ejercita el path whereRaw que rompía) ──');
  const dr = await req('GET', '/commercial-map/stores?date_from=2020-01-01&date_to=2030-01-01', token);
  check('stores con date range → 200 (no 500 whereRaw)', dr.status === 200, dr.status);
  check('stores con date range devuelve stores[]', Array.isArray(dr.body?.stores), dr.body?.total);

  console.log('\n── 4. GET /commercial-map/stores/:id/history ──');
  // Tienda con MÁS capturas → asegura múltiples visitas (y posiblemente varios usuarios).
  const topStore = await knex('daily_captures')
    .where('tenant_id', T)
    .whereNotNull('store_id')
    .select('store_id')
    .count('* as n')
    .groupBy('store_id')
    .orderBy('n', 'desc')
    .first();
  const sid = topStore?.store_id;
  const dbVisits = Number(topStore?.n || 0);
  check('hay una tienda con capturas para el historial', !!sid, sid);
  const h = await req('GET', `/commercial-map/stores/${sid}/history`, token);
  check('history 200', h.status === 200, h.status);
  const visitsAll = Array.isArray(h.body?.visits) ? h.body.visits : [];
  check('history trae TODAS las visitas de la tienda (sin recorte por scope)', visitsAll.length === dbVisits, { endpoint: visitsAll.length, db: dbVisits });
  const hd = await req('GET', `/commercial-map/stores/${sid}/history?date_from=2020-01-01&date_to=2030-01-01`, token);
  check('history con date range → 200 (no 500 whereRaw)', hd.status === 200, hd.status);
  const store = h.body?.store;
  const visits = Array.isArray(h.body?.visits) ? h.body.visits : [];
  check('trae store con totales own/competitor/unknown', !!store && typeof store.ownTotal === 'number' && typeof store.competitorTotal === 'number', store);
  check('store del history incluye ruta (string)', !!store && typeof store.ruta === 'string', store?.ruta);
  check('trae visits[] con exhibiciones', visits.length > 0 && Array.isArray(visits[0].exhibiciones), visits.length);
  const allExh = visits.flatMap((v) => v.exhibiciones);
  check('cada exhibición trae concepto + flag perteneceMegaDulces (bool|null)', allExh.length > 0 && allExh.every((e) => typeof e.concepto === 'string' && (e.perteneceMegaDulces === true || e.perteneceMegaDulces === false || e.perteneceMegaDulces === null)), allExh[0]);

  console.log('\n── 5. id inválido → 404 (no 500) ──');
  const bad = await req('GET', '/commercial-map/stores/not-a-uuid/history', token);
  check('id no-uuid responde 404', bad.status === 404, bad.status);

  console.log('\n── 6. Aislamiento de tenant ──');
  const t2 = await knex('identity.tenants').where('id', '<>', T).whereNull('deleted_at').first().catch(() => null);
  if (t2) {
    const cross = await knex('stores').where({ tenant_id: t2.id }).whereIn('id', stores.map((s) => s.id)).count('* as n').first();
    check('ninguna tienda devuelta pertenece al 2do tenant', Number(cross.n) === 0, cross.n);
  } else {
    console.log('  (skip: no hay 2do tenant)');
  }

  console.log('\n── 7. Superbuscador product-presence ──');
  const pidRow = await knex.raw(
    `SELECT pid AS product_id
       FROM daily_captures dc,
            jsonb_array_elements(CASE jsonb_typeof(dc.exhibiciones) WHEN 'array' THEN dc.exhibiciones ELSE '[]'::jsonb END) ex,
            jsonb_array_elements_text(COALESCE(ex->'productosMarcados','[]'::jsonb)) pid
      WHERE dc.tenant_id = ? LIMIT 1`, [T]);
  const pid = pidRow.rows?.[0]?.product_id;
  check('hay un product_id en productosMarcados', !!pid, pid);
  if (pid) {
    const pp = await req('GET', `/commercial-map/product-presence?product_ids=${pid}`, token);
    check('product-presence (ids) 200', pp.status === 200, pp.status);
    check('devuelve stores con visitas', (pp.body?.stores?.length || 0) > 0 && Array.isArray(pp.body.stores[0].visits), pp.body?.totalStores);
    check('cada store trae ruta + located', (pp.body?.stores || []).every((s) => 'ruta' in s && typeof s.located === 'boolean'), pp.body?.stores?.[0]);
    check('cada visita trae matchedProducts[]', Array.isArray(pp.body?.stores?.[0]?.visits?.[0]?.matchedProducts), pp.body?.stores?.[0]?.visits?.[0]);

    const prod = await knex('products').where('id', pid).select('nombre').first();
    const term = (prod?.nombre || '').split(' ').find((w) => w.length >= 3) || (prod?.nombre || '').slice(0, 3);
    if (term) {
      const pq = await req('GET', `/commercial-map/product-presence?q=${encodeURIComponent(term)}`, token);
      check('product-presence (q contains) 200', pq.status === 200, pq.status);
      check('contains resuelve productos[]', (pq.body?.products?.length || 0) > 0, { term, n: pq.body?.products?.length });
    }
  }

  console.log(`\n══ Resultado: ${pass} OK, ${fail} FAIL ══`);
  if (fail) console.log('FALLOS:', failures.join(', '));
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
