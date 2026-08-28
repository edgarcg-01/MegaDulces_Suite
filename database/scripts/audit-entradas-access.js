'use strict';
/**
 * `[RE.13.6]` — **Quién puede tocar el proceso de recepción documental, y quién vería algo.**
 *
 * Es el gate de despliegue de la Fase RE.13, y también el insumo de la única decisión que no
 * es mía: **a quién se le quita `COMPRAS_ENTRADAS_VALIDAR`**. Aprobar la factura de un
 * proveedor es un control interno, así que la lista de roles la define Edgar — pero la
 * decisión sólo se puede tomar con los números delante:
 *
 *   1. `_VALIDAR` está otorgado a **15 roles**, incluidos `coordinadora_marketing`,
 *      `tele_operator` y `gestor_tesoreria`, pese a que el controller lo documenta como
 *      "permiso especial restringido". Un rol con 0 usuarios activos se recorta sin costo;
 *      uno con 12 hay que hablarlo. Este script separa los dos casos.
 *   2. El alcance manda tanto como el permiso: un capturista con `warehouse` en `own` y la
 *      ficha **sin sucursal** ve CERO filas. Acá se resuelve el alcance efectivo igual que lo
 *      hace `ScopeService` (user_scopes → role_scopes → none) y se marca a los que quedarían
 *      con la pantalla en blanco.
 *   3. **Segregación de funciones**: quién puede capturar Y validar a la vez. El guard nuevo
 *      impide aprobar *lo propio*, pero la acumulación sigue siendo un hallazgo de control.
 *
 * Read-only: no escribe nada. Corre contra local por default.
 *
 * Uso:
 *   node database/scripts/audit-entradas-access.js
 *   DATABASE_URL_NEW=<prod> node database/scripts/audit-entradas-access.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const PERMS = ['COMPRAS_ENTRADAS_VER', 'COMPRAS_ENTRADAS_GESTIONAR', 'COMPRAS_ENTRADAS_VALIDAR'];
/** Roles de plataforma: `ScopeService` los resuelve como `all` sin mirar reglas. */
const PLATAFORMA = ['superadmin', 'admin'];

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const num = (n, w = 4) => String(n).padStart(w);

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log(`\nRE.13.6 — Acceso al proceso de recepción documental\n${'='.repeat(78)}`);

  // ── 1. Permisos por rol + cuántos usuarios ACTIVOS lo tienen ──────────────
  const roles = (await c.query(`
    SELECT rp.role_name,
           (rp.permissions->>'COMPRAS_ENTRADAS_VER')::boolean       AS ver,
           (rp.permissions->>'COMPRAS_ENTRADAS_GESTIONAR')::boolean AS gestionar,
           (rp.permissions->>'COMPRAS_ENTRADAS_VALIDAR')::boolean   AS validar,
           (SELECT COUNT(*)::int FROM public.users u
             WHERE lower(u.role_name) = lower(rp.role_name) AND u.deleted_at IS NULL) AS usuarios
      FROM public.role_permissions rp
     WHERE COALESCE((rp.permissions->>'COMPRAS_ENTRADAS_VALIDAR')::boolean, false)
        OR COALESCE((rp.permissions->>'COMPRAS_ENTRADAS_GESTIONAR')::boolean, false)
     ORDER BY (rp.permissions->>'COMPRAS_ENTRADAS_VALIDAR')::boolean DESC NULLS LAST, rp.role_name`)).rows;

  console.log(`\n1) Roles con permiso sobre entradas (${roles.length})\n`);
  console.log(`   ${pad('rol', 32)} ver  gest val  usuarios`);
  console.log(`   ${'-'.repeat(60)}`);
  for (const r of roles) {
    const marca = r.validar && r.usuarios === 0 ? '  ← sin usuarios: recortar sale gratis' : '';
    console.log(`   ${pad(r.role_name, 32)} ${r.ver ? ' ✓ ' : ' · '} ${r.gestionar ? ' ✓ ' : ' · '} ${r.validar ? ' ✓ ' : ' · '} ${num(r.usuarios)}${marca}`);
  }
  const conValidar = roles.filter((r) => r.validar);
  const validarVacios = conValidar.filter((r) => r.usuarios === 0);
  const validarConGente = conValidar.filter((r) => r.usuarios > 0);
  console.log(`\n   ${conValidar.length} roles pueden VALIDAR · ${validarVacios.length} sin usuarios · ${validarConGente.length} con gente`);
  if (validarVacios.length) {
    console.log(`   Recorte sin costo: ${validarVacios.map((r) => r.role_name).join(', ')}`);
  }
  console.log(`   Decisión de Edgar (tienen gente): ${validarConGente.map((r) => `${r.role_name} (${r.usuarios})`).join(', ')}`);

  // ── 2. Alcance efectivo de quien captura o valida ─────────────────────────
  // Misma resolución que ScopeService: plataforma → all; user_scopes gana sobre role_scopes;
  // `own` = la sucursal de su ficha; sin regla = none (fail-closed).
  const users = (await c.query(`
    SELECT u.id, u.username, u.role_name, u.warehouse_code,
           COALESCE((rp.permissions->>'COMPRAS_ENTRADAS_GESTIONAR')::boolean, false) AS captura,
           COALESCE((rp.permissions->>'COMPRAS_ENTRADAS_VALIDAR')::boolean, false)   AS valida,
           us.mode AS user_mode, us.values AS user_values, us.mode_write AS user_mode_write,
           rs.mode AS role_mode, rs.values AS role_values, rs.mode_write AS role_mode_write
      FROM public.users u
      LEFT JOIN public.role_permissions rp ON lower(rp.role_name) = lower(u.role_name)
      LEFT JOIN identity.user_scopes us ON us.user_id = u.id AND us.dimension = 'warehouse' AND us.tenant_id = $1
      LEFT JOIN identity.role_scopes rs ON lower(rs.role_name) = lower(u.role_name) AND rs.dimension = 'warehouse' AND rs.tenant_id = $1
     WHERE u.deleted_at IS NULL
       AND (COALESCE((rp.permissions->>'COMPRAS_ENTRADAS_GESTIONAR')::boolean, false)
         OR COALESCE((rp.permissions->>'COMPRAS_ENTRADAS_VALIDAR')::boolean, false))
     ORDER BY u.role_name, u.username`, [TENANT])).rows;

  const resolver = (u) => {
    if (PLATAFORMA.includes(String(u.role_name || '').toLowerCase())) return { mode: 'all', values: [], via: 'plataforma' };
    const mode = u.user_mode ?? u.role_mode ?? null;
    const via = u.user_mode ? 'usuario' : u.role_mode ? 'rol' : 'sin regla';
    if (!mode) return { mode: 'none', values: [], via };
    if (mode === 'listed') return { mode, values: (u.user_mode ? u.user_values : u.role_values) || [], via };
    if (mode === 'own') return { mode, values: u.warehouse_code ? [u.warehouse_code] : [], via };
    return { mode, values: [], via }; // all / none
  };

  const ciegos = [];
  const acumulan = [];
  console.log(`\n2) Alcance efectivo de los ${users.length} usuarios que capturan o validan\n`);
  console.log(`   ${pad('usuario', 22)} ${pad('rol', 26)} ${pad('cap/val', 8)} ${pad('alcance', 22)} regla`);
  console.log(`   ${'-'.repeat(96)}`);
  for (const u of users) {
    const s = resolver(u);
    const ve = s.mode === 'all' ? 'toda la red' : s.mode === 'none' ? 'NADA' : s.values.length ? s.values.join(',') : 'NADA (own sin sucursal)';
    const rol = `${u.captura ? 'cap' : '—'}/${u.valida ? 'val' : '—'}`;
    if (ve.startsWith('NADA')) ciegos.push({ ...u, ve });
    if (u.captura && u.valida) acumulan.push(u);
    console.log(`   ${pad(u.username, 22)} ${pad(u.role_name, 26)} ${pad(rol, 8)} ${pad(ve, 22)} ${s.via}`);
  }

  // ── 3. Los dos hallazgos que bloquean el arranque ─────────────────────────
  console.log(`\n3) Lo que hay que resolver antes de prender las pantallas\n`);
  if (ciegos.length) {
    console.log(`   ⚠️  ${ciegos.length} usuario(s) con permiso pero SIN alcance: la pantalla les sale vacía.`);
    for (const u of ciegos) console.log(`       · ${u.username} (${u.role_name}) — ${u.ve}`);
    console.log(`       Fix: poner su sucursal en la ficha (mode 'own') o darle 'listed' con sus códigos.`);
  } else {
    console.log(`   ✅ Todos los que capturan o validan tienen alcance con al menos una sucursal.`);
  }
  if (acumulan.length) {
    console.log(`\n   ⚠️  ${acumulan.length} usuario(s) pueden CAPTURAR y VALIDAR a la vez:`);
    for (const u of acumulan) console.log(`       · ${u.username} (${u.role_name})`);
    console.log(`       El guard de RE.13.2 impide aprobar lo PROPIO, así que no es un agujero abierto,`);
    console.log(`       pero la acumulación sigue siendo hallazgo de control: dos personas distintas es mejor.`);
  } else {
    console.log(`\n   ✅ Nadie acumula captura + validación.`);
  }
  // ── 4. Sucursales sin nadie que capture ───────────────────────────────────
  // El hallazgo operativo que ni el permiso ni el alcance muestran por separado: una sucursal
  // puede tener volumen y no tener a NADIE con alcance de escritura sobre ella. Los de "toda
  // la red" pueden capturar ahí, pero no es su trabajo — nadie va a subir la factura.
  const vol = (await c.query(`
    SELECT c.sucursal, COUNT(*)::int AS entradas
      FROM analytics.erp_goods_receipts c
     WHERE c.tenant_id = $1 AND c.dup_of_folio IS NULL
       AND c.receipt_date >= COALESCE(
             (SELECT reception_start FROM finance.receipt_settings WHERE tenant_id = $1),
             '2026-08-01'::date)
     GROUP BY 1 ORDER BY 2 DESC`, [TENANT])).rows;

  const propios = new Map(); // sucursal → usuarios con alcance ACOTADO a ella
  for (const u of users) {
    if (!u.captura) continue;
    const s = resolver(u);
    if (s.mode === 'all') continue; // "toda la red" no es el dueño del trabajo de una sucursal
    for (const v of s.values) propios.set(v, [...(propios.get(v) || []), u.username]);
  }

  console.log(`
4) ¿Quién sube la factura en cada sucursal? (volumen desde el arranque)
`);
  console.log(`   ${pad('suc', 6)} ${pad('entradas', 10)} capturistas con esa sucursal en su alcance`);
  console.log(`   ${'-'.repeat(78)}`);
  const huerfanas = [];
  for (const v of vol) {
    const gente = propios.get(v.sucursal) || [];
    if (!gente.length) huerfanas.push(v);
    console.log(`   ${pad(v.sucursal, 6)} ${pad(num(v.entradas, 6), 10)} ${gente.length ? gente.join(', ') : '⚠️  NADIE'}`);
  }
  if (huerfanas.length) {
    const tot = huerfanas.reduce((a, x) => a + Number(x.entradas), 0);
    console.log(`
   ⚠️  ${huerfanas.length} sucursal(es) sin capturista propio, con ${tot} entradas esperando:`);
    console.log(`       ${huerfanas.map((x) => `${x.sucursal} (${x.entradas})`).join(' · ')}`);
    console.log(`       Sin alguien asignado ahí, esas facturas no las sube nadie: la pantalla existe`);
    console.log(`       pero no tiene dueño. Es lo primero a resolver antes de anunciar el proceso.`);
  }

  console.log('');
  await c.end();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
