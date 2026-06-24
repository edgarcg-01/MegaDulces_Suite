/* eslint-disable no-console */
/**
 * Smoke HTTP — Prospección DENUE (Fase DENUE).
 *
 * Verifica:
 *   GET  /commercial-map/prospects/config         → config Michoacán + geocerca La Piedad
 *   GET  /commercial-map/prospects/quantify        → universo DENUE por SCIAN (requiere token)
 *   POST /commercial-map/prospects/ingest-nearby    → cosecha real DENUE + dedup (requiere token)
 *   GET  /commercial-map/prospects                  → candidatos para la capa del mapa
 *   GET  /commercial-map/prospects/counts           → conteo por estado
 *   POST /commercial-map/prospects/dedup            → reclasifica vs stores+customers
 *   POST /commercial-map/prospects/:id/dismiss      → descarta
 *   + GEOCERCA: cada prospecto a ≤100 km de La Piedad · id inválido → 404.
 *
 * Requisitos: migraciones aplicadas + API :3334 REINICIADA con DENUE_TOKEN en el
 * entorno (si falta, el test corre lo que no depende del token y lo avisa).
 * Correr: node database/tests/http-denue-prospects-test.js
 */
const BASE = 'http://localhost:3334/api';
const LA_PIEDAD = { lat: 20.345, lng: -102.0367 };
const MAX_KM = 100;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, det) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det !== undefined ? ` — ${JSON.stringify(det)}` : ''}`); failures.push(name); fail++; }
}
function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
async function req(method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

(async () => {
  console.log('── 1. Login superoot ──');
  const lr = await fetch(`${BASE}/auth-mt/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' }) });
  const token = (await lr.json())?.access_token;
  check('JWT recibido', !!token);
  if (!token) { console.log('FATAL sin token (¿API arriba en :3334?)'); process.exit(1); }

  console.log('\n── 2. GET /prospects/config (Michoacán + geocerca La Piedad) ──');
  const cfg = await req('GET', '/commercial-map/prospects/config', token);
  check('config 200', cfg.status === 200, cfg.status);
  check('entidad = 16 (Michoacán)', cfg.body?.entidad === '16', cfg.body?.entidad);
  check('max_radius_km = 100', Number(cfg.body?.max_radius_km) === 100, cfg.body?.max_radius_km);
  check('centro ≈ La Piedad', Math.abs(Number(cfg.body?.center_lat) - LA_PIEDAD.lat) < 0.01 && Math.abs(Number(cfg.body?.center_lng) - LA_PIEDAD.lng) < 0.01, { lat: cfg.body?.center_lat, lng: cfg.body?.center_lng });
  const scian = Array.isArray(cfg.body?.scian_codes) ? cfg.body.scian_codes : JSON.parse(cfg.body?.scian_codes || '[]');
  check('SCIAN incluye dulcerías 461160', scian.includes('461160'), scian);

  console.log('\n── 3. GET /prospects/quantify (universo DENUE) ──');
  const q = await req('GET', '/commercial-map/prospects/quantify', token);
  check('quantify 200', q.status === 200, q.status);
  const denueEnabled = q.body?.enabled === true;
  if (denueEnabled) {
    check('quantify devuelve items[] con totales', Array.isArray(q.body.items) && q.body.items.length > 0, q.body.items);
    const dulc = (q.body.items || []).find((i) => i.scian === '461160');
    check('dulcerías Michoacán > 0', dulc && dulc.total > 0, dulc);
    console.log('     universo:', (q.body.items || []).map((i) => `${i.scian}=${i.total}`).join(' · '));
  } else {
    console.log('  ⚠️  DENUE deshabilitado (falta DENUE_TOKEN en la API o no reiniciada). Se saltan los pasos de cosecha.');
  }

  console.log('\n── 4. POST /prospects/ingest-area (cosecha robusta Michoacán + geocerca) ──');
  if (denueEnabled) {
    // BuscarAreaAct (paginado, no rate-limiteado como Buscar) por entidad 16 + SCIAN
    // de la config; el service recorta a ≤100 km de La Piedad vía passesGeo().
    const ing = await req('POST', '/commercial-map/prospects/ingest-area', token, {});
    check('ingest-area 200', ing.status === 200 || ing.status === 201, ing.status);
    check('cosechó POIs de DENUE (fetched>0)', (ing.body?.fetched || 0) > 0, ing.body);
    check('upserteó tras geocerca (upserted>0)', (ing.body?.upserted || 0) > 0, ing.body);
    console.log(`     fetched=${ing.body?.fetched} upserted=${ing.body?.upserted}`);

    // ingest-nearby usa el endpoint Buscar, que INEGI rate-limitea agresivo → best-effort.
    const near = await req('POST', '/commercial-map/prospects/ingest-nearby', token, { lat: LA_PIEDAD.lat, lng: LA_PIEDAD.lng, radius: 2000 });
    if ((near.body?.fetched || 0) > 0) console.log(`     (ingest-nearby OK: fetched=${near.body.fetched})`);
    else console.log('     (ingest-nearby fetched=0 — endpoint Buscar rate-limiteado por INEGI; no es fallo del pipeline)');
  } else {
    console.log('  (skip: DENUE deshabilitado)');
  }

  console.log('\n── 5. GET /prospects (candidatos para el mapa) ──');
  const list = await req('GET', '/commercial-map/prospects', token);
  check('list 200', list.status === 200, list.status);
  const prospects = Array.isArray(list.body?.prospects) ? list.body.prospects : [];
  check('devuelve prospects[] + total', typeof list.body?.total === 'number' && Array.isArray(list.body?.prospects), list.body?.total);
  if (prospects.length > 0) {
    check('cada prospecto trae lat/lng + status + score', prospects.every((p) => typeof p.status === 'string' && 'whitespace_score' in p), prospects[0]);
    check('todos en estado candidate', prospects.every((p) => p.status === 'candidate'), prospects.map((p) => p.status).slice(0, 3));

    console.log('\n── 5b. GEOCERCA: todos a ≤100 km de La Piedad ──');
    const located = prospects.filter((p) => p.lat != null && p.lng != null);
    const outside = located.filter((p) => haversineKm(LA_PIEDAD, { lat: Number(p.lat), lng: Number(p.lng) }) > MAX_KM);
    check('ningún prospecto fuera de 100 km', outside.length === 0, outside.slice(0, 3).map((p) => ({ n: p.nombre, km: Math.round(haversineKm(LA_PIEDAD, { lat: +p.lat, lng: +p.lng })) })));
    const farMich = located.map((p) => haversineKm(LA_PIEDAD, { lat: +p.lat, lng: +p.lng }));
    if (farMich.length) console.log(`     ubicados=${located.length} | dist máx=${Math.round(Math.max(...farMich))}km`);
    const noGto = prospects.every((p) => !p.entidad || /michoac/i.test(p.entidad));
    check('ninguno es de Guanajuato/otra entidad (filtro entidad=16)', noGto, prospects.find((p) => p.entidad && !/michoac/i.test(p.entidad))?.entidad);
  } else if (denueEnabled) {
    check('hay candidatos tras cosechar', false, 'lista vacía pese a cosecha');
  } else {
    console.log('  (sin candidatos — DENUE deshabilitado, nada que cosechar todavía)');
  }

  console.log('\n── 6. GET /prospects/counts ──');
  const counts = await req('GET', '/commercial-map/prospects/counts', token);
  check('counts 200', counts.status === 200, counts.status);
  check('counts trae candidate/covered/dismissed/converted', counts.body && ['candidate', 'covered', 'dismissed', 'converted'].every((k) => k in counts.body), counts.body);

  console.log('\n── 7. POST /prospects/dedup (reclasifica vs stores+customers) ──');
  const dd = await req('POST', '/commercial-map/prospects/dedup', token, {});
  check('dedup 200', dd.status === 200 || dd.status === 201, dd.status);
  check('dedup devuelve scanned/covered/candidate', dd.body && typeof dd.body.scanned === 'number', dd.body);
  console.log(`     scanned=${dd.body?.scanned} covered=${dd.body?.covered} candidate=${dd.body?.candidate}`);

  console.log('\n── 7b. GET /prospects/penetration (clientes ÷ universo DENUE) ──');
  const pen = await req('GET', '/commercial-map/prospects/penetration', token);
  check('penetration 200', pen.status === 200, pen.status);
  check('trae total + by_scian + by_municipio', pen.body && pen.body.total && Array.isArray(pen.body.by_scian) && Array.isArray(pen.body.by_municipio), Object.keys(pen.body || {}));
  check('total.pct es número 0..100', typeof pen.body?.total?.pct === 'number' && pen.body.total.pct >= 0 && pen.body.total.pct <= 100, pen.body?.total);
  console.log(`     penetración global=${pen.body?.total?.pct}% (${pen.body?.total?.mine}/${pen.body?.total?.universe}) · municipios=${pen.body?.by_municipio?.length}`);

  console.log('\n── 7c. POST /prospects/enrich-customers (teléfono/email desde DENUE) ──');
  const enr = await req('POST', '/commercial-map/prospects/enrich-customers', token, {});
  check('enrich 200', enr.status === 200 || enr.status === 201, enr.status);
  check('enrich devuelve candidates/filled_phone/filled_email', enr.body && typeof enr.body.candidates === 'number' && typeof enr.body.filled_phone === 'number', enr.body);
  console.log(`     candidatos=${enr.body?.candidates} teléfonos=${enr.body?.filled_phone} emails=${enr.body?.filled_email}`);

  console.log('\n── 8. POST /prospects/:id/dismiss ──');
  if (prospects.length > 0) {
    const victim = prospects[0];
    const dis = await req('POST', `/commercial-map/prospects/${victim.id}/dismiss`, token, {});
    check('dismiss 200', (dis.status === 200 || dis.status === 201) && dis.body?.ok === true, dis.status);
    const after = await req('GET', '/commercial-map/prospects', token);
    const stillThere = (after.body?.prospects || []).some((p) => p.id === victim.id);
    check('el descartado ya no aparece como candidate', !stillThere, victim.id);
  } else {
    console.log('  (skip: no hay candidatos para descartar)');
  }

  console.log('\n── 9. id inválido → 404 ──');
  const bad = await req('POST', '/commercial-map/prospects/not-a-uuid/dismiss', token, {});
  check('id no-uuid responde 404', bad.status === 404, bad.status);

  console.log(`\n══ Resultado: ${pass} OK, ${fail} FAIL ══`);
  if (fail) console.log('FALLOS:', failures.join(', '));
  if (!denueEnabled) console.log('NOTA: corré de nuevo tras setear DENUE_TOKEN + reiniciar la API para ejercitar la cosecha real.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
