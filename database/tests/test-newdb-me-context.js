/* eslint-disable no-console */
/**
 * `[SN.2]` — Smoke HTTP de `GET /users/me/context` (el bloque "Mi contexto" de la landing).
 *
 * Tres cosas, porque fallan por motivos distintos:
 *   1. El endpoint contesta con la FORMA del contrato (`MeContext`) para la persona del token, y
 *      `position`/`department` son objeto `{code,name}` **o `null` declarado** — nunca ausentes,
 *      nunca un string sacado del rol.
 *   2. Sin token → 401 (es self-scoped, no público).
 *   3. Gate ESTÁTICO sobre el controller: `me/context` está declarado ANTES de `@Get(':id')` y sin
 *      `@RequirePermissions`. Si alguien lo mueve debajo de `:id`, la ruta genérica se lo traga
 *      (misma trampa documentada en `me/scope`) y este bloque se pone rojo aunque la API esté viva.
 *
 * Requiere API en :3334. Si no está, se declara NO MEDIDO (exit 2), no verde.
 * Correr: node database/tests/test-newdb-me-context.js
 */

const fs = require('fs');
const path = require('path');
const { noMedido } = require('./_lib/no-medido');

const BASE = process.env.API_BASE || 'http://localhost:3334/api';
let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); fail++; }
};

async function req(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
}

(async () => {
  // ── 3. Gate estático (no necesita API; va primero para que un fallo de entorno no lo esconda) ──
  console.log('── 3. Orden de rutas en el controller ──');
  const ctrl = fs.readFileSync(
    path.resolve(__dirname, '../../libs/trade/src/lib/users/users.controller.ts'),
    'utf8',
  );
  const iCtx = ctrl.indexOf("@Get('me/context')");
  const iId = ctrl.indexOf("@Get(':id')");
  check('me/context está declarado', iCtx >= 0);
  check("@Get(':id') existe (si no, el gate no mide nada)", iId >= 0);
  check("me/context va ANTES de @Get(':id')", iCtx >= 0 && iId >= 0 && iCtx < iId, { iCtx, iId });
  // El tramo es SÓLO este handler: desde su @Get hasta el siguiente @Get. Un recorte fijo de N
  // caracteres alcanzaba al método vecino (`:id/scope`, que sí exige USUARIOS_VER) y acusaba en
  // falso — la primera corrida de este test lo demostró.
  const siguiente = ctrl.indexOf('@Get(', iCtx + 1);
  const tramo = ctrl.slice(iCtx, siguiente > 0 ? siguiente : iCtx + 400);
  check('el handler de me/context contiene un método (el tramo no está vacío)', /myContext\(/.test(tramo));
  check('me/context NO exige @RequirePermissions (self-scoped)', !/@RequirePermissions/.test(tramo));

  // ── 1 y 2. En vivo ────────────────────────────────────────────────────────────────────────────
  console.log('\n── 1. Login ──');
  let login;
  try {
    login = await req('POST', '/auth-mt/login', {
      tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
    });
  } catch (e) {
    noMedido(`la API en ${BASE} no contesta — ${e.message}`);
  }
  const token = login.body?.access_token;
  check('JWT recibido', !!token, login.status);
  if (!token) { console.log(`\n${pass} OK · ${fail} FAIL`); process.exit(fail ? 1 : 0); }

  console.log('\n── 2. GET /users/me/context ──');
  const me = await req('GET', '/users/me/context', null, token);
  check('200', me.status === 200, { status: me.status, body: me.body });
  const b = me.body || {};
  check('user_id + username presentes', typeof b.user_id === 'string' && typeof b.username === 'string');
  check('username es el del login', b.username === 'superoot', b.username);
  check('role_name presente', typeof b.role_name === 'string' && b.role_name.length > 0, b.role_name);
  const esRefONull = (v) => v === null || (v && typeof v.code === 'string' && typeof v.name === 'string');
  check('position es {code,name} o null DECLARADO (nunca ausente)', 'position' in b && esRefONull(b.position), b.position);
  check('department es {code,name} o null DECLARADO', 'department' in b && esRefONull(b.department), b.department);
  check('nombre es string o null (nunca undefined)', 'nombre' in b && (b.nombre === null || typeof b.nombre === 'string'));
  check('zona y warehouse_code declarados (string o null)',
    'zona' in b && 'warehouse_code' in b && (b.zona === null || typeof b.zona === 'string') && (b.warehouse_code === null || typeof b.warehouse_code === 'string'));
  // El puesto NO se deriva del rol: si viene, tiene que ser un código del catálogo, no el role_name.
  if (b.position) check('position.code no es el role_name disfrazado', b.position.code !== b.role_name, b.position);

  console.log('\n── 2b. Sin token ──');
  const anon = await req('GET', '/users/me/context', null, null);
  check('401 sin token', anon.status === 401, anon.status);

  console.log(`\n${pass} OK · ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
