/* eslint-disable no-console */
/**
 * Smoke HTTP — apartado "Rutas" (Fase 1 backend).
 *
 * Verifica los endpoints nuevos de detalle por ruta:
 *   GET /reports/routes/:routeId/visits  → visitas con tiempo + GPS, ORDER BY hora_inicio
 *   GET /reports/routes/:routeId/stores  → tiendas asignadas + flag visited (cobertura)
 *   GET /reports/routes                  → maestro (ya existía)
 * + aislamiento de tenant.
 *
 * Setup idempotente (knex, bypassa RLS): asigna las tiendas-con-captura a una
 * ruta y asegura hora_fin > hora_inicio para que duration_min sea calculable.
 *
 * Requisitos: API :3334 con código de Fase 0+1 (RUTAS_VER + endpoints) — REINICIAR
 * antes de correr. Login superoot (manage:all) pasa el gate RUTAS_VER.
 * Correr: node database/tests/http-routes-analysis-test.js
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
  console.log('── 0. Setup (asignar tiendas-con-captura a una ruta) ──');
  const route = await knex('catalogs').where({ tenant_id: T, catalog_id: 'rutas' }).whereNull('deleted_at').orderBy('value').first();
  if (!route) { console.log('FATAL sin rutas'); process.exit(1); }
  const sids = (await knex('daily_captures').where('tenant_id', T).whereNotNull('store_id').distinct('store_id')).map((r) => r.store_id);
  await knex('stores').where('tenant_id', T).whereIn('id', sids).whereNull('ruta_id').update({ ruta_id: route.id });
  await knex.raw(
    `UPDATE daily_captures SET hora_fin = hora_inicio + (interval '1 minute' * (5 + (extract(epoch from hora_inicio)::int % 18)))
     WHERE tenant_id=? AND store_id = ANY(?) AND (hora_fin IS NULL OR hora_fin <= hora_inicio)`, [T, sids]);
  const assigned = await knex('stores').where({ tenant_id: T, ruta_id: route.id }).whereNull('deleted_at').count('* as n').first();
  console.log(`     ruta=${route.value} (${route.id.slice(0, 8)}) | tiendas asignadas=${assigned.n}`);
  check('hay tiendas asignadas a la ruta', Number(assigned.n) > 0, assigned.n);

  console.log('\n── 1. Login superoot ──');
  const lr = await fetch(`${BASE}/auth-mt/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' }) });
  const token = (await lr.json())?.access_token;
  check('JWT recibido', !!token);
  if (!token) { console.log('FATAL sin token'); process.exit(1); }

  console.log('\n── 2. Maestro GET /reports/routes ──');
  const master = await req('GET', '/reports/routes', token);
  check('maestro 200', master.status === 200, master.status);
  const routeInMaster = (master.body?.routes || []).find((r) => r.id === route.id);
  check('la ruta aparece en el maestro con visitas', !!routeInMaster && routeInMaster.visitas > 0, routeInMaster);

  console.log('\n── 3. GET /reports/routes/:id/visits (tiempos + recorrido) ──');
  const v = await req('GET', `/reports/routes/${route.id}/visits`, token);
  check('visits 200', v.status === 200, v.status);
  const visits = Array.isArray(v.body) ? v.body : [];
  check('devuelve visitas', visits.length > 0, visits.length);
  check('cada visita trae duration_min numérico + store_nombre', visits.every((x) => typeof x.duration_min === 'number' && !!x.store_nombre), visits[0]);
  // ordenadas por hora_inicio ASC
  const ordered = visits.every((x, i) => i === 0 || new Date(visits[i - 1].hora_inicio) <= new Date(x.hora_inicio));
  check('visitas ordenadas por hora_inicio ASC', ordered, visits.slice(0, 3).map((x) => x.hora_inicio));
  check('traen GPS (lat/lng) para trazabilidad', visits.some((x) => x.latitud != null && x.longitud != null), visits[0]);

  console.log('\n── 4. GET /reports/routes/:id/stores (cobertura) ──');
  const s = await req('GET', `/reports/routes/${route.id}/stores`, token);
  check('stores 200', s.status === 200, s.status);
  const stores = Array.isArray(s.body) ? s.body : [];
  check('devuelve tiendas asignadas', stores.length > 0, stores.length);
  check('cada tienda trae flag visited (bool)', stores.every((x) => typeof x.visited === 'boolean'), stores[0]);
  check('al menos una tienda visitada', stores.some((x) => x.visited), stores.filter((x) => x.visited).length);

  console.log('\n── 5. routeId inválido → []  (no 500) ──');
  const bad = await req('GET', '/reports/routes/not-a-uuid/visits', token);
  check('routeId no-uuid responde 200 con []', bad.status === 200 && Array.isArray(bad.body) && bad.body.length === 0, { status: bad.status, body: bad.body });

  console.log('\n── 6. Aislamiento de tenant ──');
  const t2 = await knex('identity.tenants').where('id', '<>', T).whereNull('deleted_at').first().catch(() => null);
  if (t2) {
    // las tiendas de la ruta del tenant 1 no deben existir para el tenant 2
    const cross = await knex('stores').where({ tenant_id: t2.id, ruta_id: route.id }).count('* as n').first();
    check('tenant 2 no tiene tiendas en la ruta del tenant 1', Number(cross.n) === 0, cross.n);
  } else {
    console.log('  (skip: no hay 2do tenant)');
  }

  console.log(`\n══ Resultado: ${pass} OK, ${fail} FAIL ══`);
  if (fail) console.log('FALLOS:', failures.join(', '));
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
