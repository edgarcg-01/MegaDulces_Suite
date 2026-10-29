/* eslint-disable no-console */
/**
 * `[ETQ-HISTORIAL.2.1]` GET /store/labels/price-history por HTTP, contra la base LOCAL sembrada.
 *
 *   node database/scripts/etq-historial-sembrar-local.js     # 1) siembra (reversible con --borrar)
 *   (la API local arriba: la levanta quien prueba)            # 2)
 *   node database/tests/http-label-price-history-test.js      # 3)
 *
 * Roles: un usuario EFÍMERO con sólo `STORE_LABELS_VER` (el permiso mínimo, no un admin: un admin pasa por god-mode y una
 * puerta mal puesta saldría verde) y otro SIN ese permiso (403). Se borran al final.
 *
 * Variable `HIST_API_BASE` (no `API_BASE`: el .env ya define esa SIN `/api` y todo daría 404 — protocolo 74).
 * Lo que NO se mide aquí (se declara): la cifra de tiempo es de la base local sintética, no de prod.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const bcrypt = require('bcryptjs');

const BASE = process.env.HIST_API_BASE || 'http://localhost:3334/api';
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUF = String(Date.now()).slice(-8);
const PASS = `Smoke!${SUF}`;
let pass = 0;
let fail = 0;
const noMedido = [];
const check = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); fail++; } };

// El limitador de la API deja 10 peticiones por segundo (app.module.ts, ThrottlerModule `short`): sin pausa, con ~70 ms por
// petición, la 16.ª ya devuelve 429 y los últimos casos fallan por la API, no por el endpoint.
const PAUSA_MS = 150;
const pausa = () => new Promise((r) => setTimeout(r, PAUSA_MS));

async function get(p, token) {
  await pausa();
  const r = await fetch(`${BASE}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let body = null;
  try { body = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body };
}
async function usuario(etiqueta, permisos) {
  const username = `smoke_hist_${etiqueta}_${SUF}`;
  const [{ id }] = await knex('identity.users')
    .insert({ tenant_id: T, username, nombre: `SMOKE ${etiqueta}`, password_hash: await bcrypt.hash(PASS, 10), role_name: 'colaborador' }).returning('id');
  for (const k of permisos) await knex('identity.user_permissions').insert({ tenant_id: T, user_id: id, permission_key: k, allow: true, nota: 'smoke price-history' });
  const r = await fetch(`${BASE}/auth-mt/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_slug: 'mega_dulces', username, password: PASS }) });
  const j = await r.json().catch(() => ({}));
  return { id, token: j.access_token ?? null, status: r.status };
}

(async () => {
  console.log('\n=== [ETQ-HISTORIAL.2.1] price-history por HTTP ===\n');
  const ids = [];
  try {
    const ok = await usuario('ver', ['STORE_LABELS_VER']);
    const sin = await usuario('sin', []);
    ids.push(ok.id, sin.id);
    check('login del usuario con el permiso mínimo', !!ok.token, `status ${ok.status}`);
    check('login del usuario sin permiso', !!sin.token, `status ${sin.status}`);

    console.log('\n1 — puertas');
    check('sin token → 401', (await get('/store/labels/price-history?sku=99001')).status === 401);
    check('⛔ sin STORE_LABELS_VER → 403', (await get('/store/labels/price-history?sku=99001', sin.token)).status === 403);
    check('sin sku → 400', (await get('/store/labels/price-history', ok.token)).status === 400);
    check('⛔ sku con comilla o espacios (inyección) → 400', (await get(`/store/labels/price-history?sku=${encodeURIComponent("1' OR '1'='1")}`, ok.token)).status === 400);
    check('⛔ dias fuera de 90/365/0 → 400', (await get('/store/labels/price-history?sku=99001&dias=7', ok.token)).status === 400);
    check('⛔ dias que no es número → 400', (await get('/store/labels/price-history?sku=99001&dias=abc', ok.token)).status === 400);

    console.log('\n2 — lo sembrado (99001 repetido · 99002 A→B→A · 99003 sin precio · 99004 sin cambios)');
    const sembrado = await knex('kepler_ods.kdpv_bitacora_precios').where({ c9: 'ETQ-HIST-SEED' }).count({ n: '*' }).first();
    if (Number(sembrado.n) === 0) {
      noMedido.push('no hay datos sembrados: corre database/scripts/etq-historial-sembrar-local.js antes');
    } else {
      const t0 = Date.now();
      const a = await get('/store/labels/price-history?sku=99001', ok.token);
      const ms = Date.now() - t0;
      check('99001 → 200', a.status === 200, `status ${a.status}`);
      const items = a.body?.items ?? [];
      check('⭐ trae las filas CRUDAS de las 9 plazas (Kepler reescribe: son miles, no decenas)', items.length > 4000 && new Set(items.map((i) => i.sucursal)).size === 9, `${items.length} filas, ${new Set(items.map((i) => i.sucursal)).size} plazas`);
      check('no se truncó y declara su tope', a.body?.truncado === false && a.body?.tope === 8000);
      check('del más reciente al más viejo', items.every((it, i) => i === 0 || items[i - 1].fecha >= it.fecha));
      check('cada fila trae anterior, nuevo y delta numéricos', items.slice(0, 50).every((i) => typeof i.precio_nuevo === 'number' && typeof i.precio_anterior === 'number' && typeof i.delta === 'number'));
      check(`⭐ responde en menos de 0.5 s (base local sintética: ${ms} ms)`, ms < 500, `${ms} ms`);

      const d90 = await get('/store/labels/price-history?sku=99001&dias=90', ok.token);
      const corte = new Date(); corte.setDate(corte.getDate() - 91);
      check('dias=90 trae MENOS filas que 365 y ninguna más vieja', (d90.body?.items?.length ?? 0) < items.length && d90.body.items.every((i) => i.fecha >= corte.toISOString().slice(0, 10)));
      const todo = await get('/store/labels/price-history?sku=99001&dias=0', ok.token);
      check('dias=0 (toda la bitácora) declara dias:null', todo.status === 200 && todo.body?.dias === null && (todo.body?.items?.length ?? 0) >= items.length);

      const b = await get('/store/labels/price-history?sku=99002', ok.token);
      check('99002: sólo la plaza 06, con A→B→A (10→12 y 12→10)', b.body?.items?.length === 4 && b.body.items.every((i) => i.sucursal === '06')
        && b.body.items.some((i) => i.precio_anterior === 10 && i.precio_nuevo === 12) && b.body.items.some((i) => i.precio_anterior === 12 && i.precio_nuevo === 10), JSON.stringify(b.body?.items?.length));
      const c = await get('/store/labels/price-history?sku=99003', ok.token);
      check('⭐ 99003: Kepler le quitó el precio → es_baja y precio 0 (no se dibuja como rebaja)', c.body?.items?.length === 1 && c.body.items[0].es_baja === true && c.body.items[0].precio_nuevo === 0, JSON.stringify(c.body?.items));
      const d = await get('/store/labels/price-history?sku=99004', ok.token);
      check('⭐ 99004: sin cambios → 200 con lista vacía (no 404): «sin cambios» ≠ «no existe»', d.status === 200 && Array.isArray(d.body?.items) && d.body.items.length === 0, dump(d));
      const e = await get('/store/labels/price-history?sku=NO-EXISTE-123', ok.token);
      check('un código que la bitácora no conoce → 200 y vacío (la pantalla lo distingue del catálogo)', e.status === 200 && e.body?.items?.length === 0);
    }
    noMedido.push('el tiempo de este test es de la base local sintética (~6 mil filas); en prod se midió el 2026-10-28 con el peor caso (SKU 92013, 5,683 filas): 280–400 ms las 9 plazas');
  } finally {
    await knex('identity.user_permissions').whereIn('user_id', ids).del();
    await knex('identity.user_roles').whereIn('user_id', ids).del();
    await knex('identity.users').whereIn('id', ids).del();
    await knex.destroy();
  }
  if (noMedido.length) { console.log('\n  NO MEDIDO (declarado):'); for (const n of noMedido) console.log(`   · ${n}`); }
  console.log(`\n=== ${pass} ✅  ${fail} ❌ ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function dump(r) { return `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`; }
