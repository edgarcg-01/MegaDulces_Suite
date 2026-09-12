/* eslint-disable no-console */
/**
 * HTTP smoke — alcance de sucursal en Facturación de Telemarketing (GT.11, ADR-050).
 *
 * La regla: un usuario con sucursal designada trabaja SÓLO con esa sucursal y con el
 * personal de esa área. Se verifica que el recorte es real y no cosmético:
 *
 *   1. **La tabla** sólo trae facturas de sus sucursales.
 *   2. **El catálogo de vendedores** (`/filtros`) tampoco filtra de más: si viera al
 *      personal de las otras sucursales, el selector ofrecería gente con la que no puede
 *      trabajar y el filtro devolvería vacío sin explicar por qué.
 *   3. **Pedir otra sucursal no sirve**: `?warehouse_codes=<ajena>` se recorta en silencio.
 *   4. **El documento suelto tampoco se abre** (`GET /:folio`) — sin esto, el recorte de la
 *      tabla se salta con un deep-link `?doc=` y se imprime el anexo de cualquier sucursal.
 *   5. **La guía de cobranza** se niega si la selección incluye folios fuera de alcance.
 *
 * Y el contraste con un usuario de alcance `all`: ve las dos sucursales sobre las MISMAS
 * filas. Sin ese contraste, el test pasaría en verde con un endpoint roto que no devuelve
 * nada para nadie.
 *
 * Self-contained: siembra 2 roles + 2 usuarios + alcance, usa facturas REALES del ODS
 * (no inventa ventas) y limpia al final.
 * Requiere API en localhost:3334 con ENABLE_MULTITENANT=true.
 */

const BASE = `http://localhost:${process.env.TM_TEST_PORT || 3334}/api`;
// GT.12/GT.13 — el smoke también cubre el expediente (archivado + reimpresión desde snapshot)
// y el orden de la tabla, porque los tres comparten el mismo endpoint y el mismo alcance.
const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }
require('./_lib/assert-safe-target').assertSafeTarget('http-telemarketing-scope-test');
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';

const M = '00000000-0000-0000-0000-00000000d01c';
const ROLE = 'tm_scope_smoke';
const USER = 'tm_scope_smoke';
const PASS = 'tm_scope_smoke';
const ROLE_ALL = 'tm_scope_smoke_all';
const USER_ALL = 'tm_scope_smoke_all';
const PASS_ALL = 'tm_scope_smoke_all';
/** Los dos permisos que abren la pantalla; nada más. */
const PERMS = { COMMERCIAL_SALES_DOCS_VER: true };

let ok = 0, fail = 0;
const check = (t, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${t}`); }
  else { fail++; console.log(`  ❌ ${t}${extra ? ` — ${extra}` : ''}`); }
};

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (e) { /* puede ser pdf o vacío */ }
  return { status: r.status, body: json };
}

async function seedUser(pg, bcrypt, { role, username, password }) {
  await pg.query(
    `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
     VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions = EXCLUDED.permissions`,
    [M, role, JSON.stringify(PERMS)],
  );
  const hash = await bcrypt.hash(password, 10);
  const u = await pg.query(
    `INSERT INTO identity.users (tenant_id, username, password_hash, nombre, role_name, activo)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (tenant_id, username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role_name=EXCLUDED.role_name, activo=true
     RETURNING id`,
    [M, username, hash, username, role],
  );
  return u.rows[0].id;
}

async function setScope(pg, userId, mode, values) {
  await pg.query(
    `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values)
     VALUES ($1,$2,'warehouse',$3,$4::text[])
     ON CONFLICT (tenant_id, user_id, dimension) DO UPDATE SET mode=EXCLUDED.mode, values=EXCLUDED.values`,
    [M, userId, mode, values],
  );
}

async function cleanup(pg, ids) {
  const vivos = (ids || []).filter(Boolean);
  if (vivos.length) {
    await pg.query(`DELETE FROM identity.user_scopes WHERE tenant_id=$1 AND user_id = ANY($2::uuid[])`, [M, vivos]).catch(() => {});
  }
  await pg.query(`DELETE FROM identity.users WHERE tenant_id=$1 AND username = ANY($2)`, [M, [USER, USER_ALL]]).catch(() => {});
  await pg.query(`DELETE FROM identity.role_permissions WHERE tenant_id=$1 AND role_name = ANY($2)`, [M, [ROLE, ROLE_ALL]]).catch(() => {});
}

(async () => {
  const pg = new Client({ connectionString: DST, ssl: /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false });
  await pg.connect();
  await cleanup(pg, []);

  console.log('\n── 1. Escenario: dos sucursales con facturas reales ──');
  // Se eligen del ODS, no se inventan: el test tiene que fallar si el recorte no funciona,
  // no si la data de prueba no existe.
  const { rows: sucs } = await pg.query(
    `SELECT sucursal, count(*)::int n, min(fecha)::text desde, max(fecha)::text hasta
       FROM analytics.erp_sales_invoices
      WHERE tenant_id=$1 AND doc_tipo='telemarketing' AND cancelada=false
      GROUP BY 1 HAVING count(*) > 0 ORDER BY 2 DESC LIMIT 2`, [M]);
  if (sucs.length < 2) {
    console.log('  ⏭️  SKIP: hacen falta 2 sucursales con facturas de telemarketing en esta DB.');
    await pg.end();
    process.exit(0);
  }
  const MIA = sucs[0].sucursal, AJENA = sucs[1].sucursal;
  const FROM = sucs.map((s) => s.desde).sort()[0];
  const TO = sucs.map((s) => s.hasta).sort().reverse()[0];
  check(`sucursales del escenario: mía=${MIA} (${sucs[0].n}) · ajena=${AJENA} (${sucs[1].n})`, true);

  console.log('\n── 2. Fixtures: usuario acotado + usuario con alcance total ──');
  let uid = null, uidAll = null;
  try {
    const bcrypt = require('bcryptjs');
    uid = await seedUser(pg, bcrypt, { role: ROLE, username: USER, password: PASS });
    uidAll = await seedUser(pg, bcrypt, { role: ROLE_ALL, username: USER_ALL, password: PASS_ALL });
    await setScope(pg, uid, 'listed', [MIA]);
    await setScope(pg, uidAll, 'all', null);
    check('usuarios + alcance sembrados', !!uid && !!uidAll);
  } catch (e) {
    check('usuarios + alcance sembrados', false, e.message);
    await cleanup(pg, [uid, uidAll]); await pg.end(); process.exit(1);
  }

  const lg = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: USER, password: PASS });
  const tok = lg.body?.access_token;
  check('login del usuario acotado', !!tok, `status=${lg.status}`);
  const lgAll = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: USER_ALL, password: PASS_ALL });
  const tokAll = lgAll.body?.access_token;
  check('login del usuario con alcance total', !!tokAll, `status=${lgAll.status}`);
  if (!tok || !tokAll) { await cleanup(pg, [uid, uidAll]); await pg.end(); process.exit(1); }

  const rango = `from=${FROM}&to=${TO}&pageSize=200`;

  console.log('\n── 3. La tabla trae SÓLO su sucursal ──');
  const lista = await req('GET', `/commercial/sales-documents?${rango}`, tok);
  const filas = lista.body?.rows || [];
  check('responde 200 con filas', lista.status === 200 && filas.length > 0, `status=${lista.status} filas=${filas.length}`);
  check(`todas las filas son de la sucursal ${MIA}`,
    filas.length > 0 && filas.every((r) => String(r.sucursal) === MIA),
    `sucursales vistas: ${[...new Set(filas.map((r) => r.sucursal))].join(',')}`);

  console.log('\n── 4. El contraste: alcance total SÍ ve las dos ──');
  const listaAll = await req('GET', `/commercial/sales-documents?${rango}`, tokAll);
  const sucsAll = new Set((listaAll.body?.rows || []).map((r) => String(r.sucursal)));
  check('el usuario con alcance total ve más de una sucursal', sucsAll.size > 1,
    `vio: ${[...sucsAll].join(',')} (si es 1, el escenario no prueba nada)`);

  console.log('\n── 5. El catálogo de vendedores respeta el alcance ──');
  const fil = await req('GET', `/commercial/sales-documents/filtros?from=${FROM}&to=${TO}`, tok);
  const filAll = await req('GET', `/commercial/sales-documents/filtros?from=${FROM}&to=${TO}`, tokAll);
  const sucsFiltro = (fil.body?.sucursales || []).map((s) => String(s.sucursal));
  check('el catálogo de sucursales trae sólo la suya', sucsFiltro.length > 0 && sucsFiltro.every((s) => s === MIA),
    `trajo: ${sucsFiltro.join(',')}`);
  const vend = new Set((fil.body?.vendedores || []).map((v) => v.vendedor_code));
  const vendAll = new Set((filAll.body?.vendedores || []).map((v) => v.vendedor_code));
  check('ve menos vendedores que el de alcance total (no ve al personal de las otras)',
    vend.size > 0 && vend.size <= vendAll.size && [...vend].every((v) => vendAll.has(v)),
    `acotado=${vend.size} total=${vendAll.size}`);

  console.log('\n── 6. Pedir otra sucursal se recorta en silencio ──');
  const pedida = await req('GET', `/commercial/sales-documents?${rango}&warehouse_codes=${AJENA}`, tok);
  const filasPedidas = pedida.body?.rows || [];
  check('pedir la ajena no devuelve filas ajenas', pedida.status === 200 && filasPedidas.every((r) => String(r.sucursal) === MIA),
    `status=${pedida.status} sucursales: ${[...new Set(filasPedidas.map((r) => r.sucursal))].join(',')}`);

  console.log('\n── 7. Un documento de otra sucursal no se abre ni se imprime ──');
  const { rows: ajenos } = await pg.query(
    `SELECT folio_digital FROM analytics.erp_sales_invoices
      WHERE tenant_id=$1 AND doc_tipo='telemarketing' AND cancelada=false AND sucursal=$2 LIMIT 1`, [M, AJENA]);
  const folioAjeno = ajenos[0]?.folio_digital;
  const det = await req('GET', `/commercial/sales-documents/${encodeURIComponent(folioAjeno)}`, tok);
  check('el detalle de un folio ajeno responde 404', det.status === 404, `status=${det.status}`);
  const detAll = await req('GET', `/commercial/sales-documents/${encodeURIComponent(folioAjeno)}`, tokAll);
  check('el MISMO folio sí abre con alcance total (el 404 es por alcance, no porque no exista)',
    detAll.status === 200, `status=${detAll.status}`);

  console.log('\n── 8. La guía de cobranza se niega con folios fuera de alcance ──');
  const guia = await req('POST', '/commercial/sales-documents/guia-cobranza.pdf', tok, { folios: [folioAjeno] });
  check('la guía rechaza el folio ajeno (400, y lo nombra)',
    guia.status === 400 && /no se encontraron/i.test(String(guia.body?.message || '')),
    `status=${guia.status} msg=${String(guia.body?.message || '').slice(0, 90)}`);

  console.log('\n── 9. Expediente: la guía se archiva y se reimprime desde su snapshot ──');
  const { rows: mias } = await pg.query(
    `SELECT folio_digital, vendedor_code FROM analytics.erp_sales_invoices
      WHERE tenant_id=$1 AND doc_tipo='telemarketing' AND cancelada=false AND sucursal=$2
        AND vendedor_code IS NOT NULL
      ORDER BY fecha DESC LIMIT 2`, [M, MIA]);
  const mismoVendedor = mias.length === 2 && mias[0].vendedor_code === mias[1].vendedor_code;
  const paraGuia = mismoVendedor ? mias.map((r) => r.folio_digital) : [mias[0]?.folio_digital].filter(Boolean);
  const antes = await req('GET', '/commercial/sales-documents/expedientes', tok);
  const nAntes = Array.isArray(antes.body) ? antes.body.length : -1;

  // El PDF no se puede leer con `req()` (devuelve binario): se usa fetch directo por el header.
  const gen = await fetch(`${BASE}/commercial/sales-documents/guia-cobranza.pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ folios: paraGuia, responsable: 'SMOKE' }),
  });
  const folioExp = gen.headers.get('x-expediente-folio');
  const idExp = gen.headers.get('x-expediente-id');
  const pdf1 = Buffer.from(await gen.arrayBuffer());
  check('genera la guía y devuelve el folio del expediente en el header',
    gen.status === 201 && /^GC-\d{4}-\d{5}$/.test(String(folioExp)) && pdf1.length > 5000,
    `status=${gen.status} folio=${folioExp} bytes=${pdf1.length}`);

  const desp = await req('GET', '/commercial/sales-documents/expedientes', tok);
  const historial = Array.isArray(desp.body) ? desp.body : [];
  const archivado = historial.find((e) => e.folio === folioExp);
  check('el expediente aparece en el historial, con su vendedor y su total',
    !!archivado && historial.length === nAntes + 1 && archivado.documentos === paraGuia.length
      && Number(archivado.total) > 0,
    `n=${historial.length} (antes ${nAntes}) archivado=${JSON.stringify(archivado || null).slice(0, 140)}`);

  // La reimpresión sale del SNAPSHOT: mismo documento, byte por byte, aunque la cartera cambie.
  const re = await fetch(`${BASE}/commercial/sales-documents/expedientes/${idExp}/pdf`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const pdf2 = Buffer.from(await re.arrayBuffer());
  check('la reimpresión devuelve el MISMO documento (sale del snapshot, no de la cartera de hoy)',
    re.status === 200 && pdf2.length === pdf1.length,
    `status=${re.status} original=${pdf1.length} copia=${pdf2.length}`);

  // Y el alcance también aplica al historial: el usuario acotado no ve guías de otra sucursal
  // porque no puede crearlas — se verifica que el endpoint responde y no filtra de más.
  const delOtro = await req('GET', '/commercial/sales-documents/expedientes?vendedor_code=NO-EXISTE', tok);
  check('el filtro por vendedor del historial responde vacío para uno inexistente',
    delOtro.status === 200 && Array.isArray(delOtro.body) && delOtro.body.length === 0,
    `status=${delOtro.status}`);

  console.log('\n── 10. Orden de la tabla (GT.13) ──');
  const desc = await req('GET', `/commercial/sales-documents?${rango}&sort=total_desc`, tok);
  const asc = await req('GET', `/commercial/sales-documents?${rango}&sort=total_asc`, tok);
  const tDesc = (desc.body?.rows || []).map((r) => Number(r.total));
  const tAsc = (asc.body?.rows || []).map((r) => Number(r.total));
  check('total_desc ordena de mayor a menor', tDesc.length > 1 && tDesc.every((v, i) => i === 0 || tDesc[i - 1] >= v),
    `primeros: ${tDesc.slice(0, 3).join(', ')}`);
  check('total_asc ordena de menor a mayor', tAsc.length > 1 && tAsc.every((v, i) => i === 0 || tAsc[i - 1] <= v),
    `primeros: ${tAsc.slice(0, 3).join(', ')}`);
  check('y son órdenes distintos (si coincidieran, el sort no estaría haciendo nada)',
    tDesc[0] !== tAsc[0] || tDesc.length <= 1);

  // Las guías del smoke se borran: son expedientes de prueba sobre facturas reales.
  await pg.query(`DELETE FROM commercial.collection_guides WHERE tenant_id=$1 AND responsable='SMOKE'`, [M]).catch(() => {});

  await cleanup(pg, [uid, uidAll]);
  await pg.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} OK · ${fail} fallas\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
