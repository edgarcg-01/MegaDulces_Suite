/**
 * `[RE.20.6]` — **El alcance también manda al ESCRIBIR.**
 *
 * El permiso dice *qué* podés hacer; el alcance dice *sobre qué*. Tener `COMPRAS_ENTRADAS_VALIDAR`
 * no es tener "_VALIDAR sobre CEDIS".
 *
 * Encontrado revisando el backend el 2026-08-29: los filtros de las LISTAS estaban scopeados,
 * pero `validate` / `reject` / `validateBulk` / `descartar` / `reactivar` recibían el id (o la
 * sucursal) por la ruta y escribían donde les dijeran — y **nadie pasa por la lista para hacer
 * un POST**. `attach` y `decideTwin` sí lo comprobaban; era la excepción, no la regla.
 *
 * Por qué importa acá y no es teórico: **8 `encargado_tienda` tienen `_VALIDAR` con alcance
 * `own`** (su propia tienda). Y `descartar` **saca la fila del denominador de cobertura**, que
 * es justo el número por el que se le exige a esa sucursal: el incentivo para tocar el de
 * al lado —o el propio desde afuera— está servido.
 *
 * Este smoke NO prueba el guard de TypeScript (eso es el service); prueba las dos premisas de
 * datos de las que depende, que son las que se pueden romper solas con el tiempo:
 *   1. Que siga habiendo usuarios con `_VALIDAR` y alcance ACOTADO — si algún día no hay, el
 *      guard deja de tener efecto y conviene saberlo.
 *   2. Que **nadie** con `_VALIDAR` quede sin regla de alcance Y sin god-mode: ése sería un
 *      usuario que el guard bloquea de golpe, porque el default de `modeWrite` es `none`
 *      (fail-closed). Es la aserción que evita tumbar a alguien en un deploy.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-goods-receipts-write-scope.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
// Espeja `PLATFORM_ADMIN_ROLES` de `libs/platform-core/.../ability.factory.ts`: el god-mode es
// por NOMBRE DE ROL, no por clave de permiso (me costó un susto asumir lo contrario).
const GOD = new Set(['superadmin', 'admin']);
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

(async () => {
  try {
    const { rows } = await knex.raw(`
      SELECT u.username, u.role_name, u.warehouse_code,
             COALESCE(us.mode_write, us.mode) AS u_w,
             COALESCE(rs.mode_write, rs.mode) AS r_w
        FROM identity.users u
        JOIN identity.role_permissions rp
          ON rp.tenant_id = u.tenant_id AND lower(rp.role_name) = lower(u.role_name)
        LEFT JOIN identity.user_scopes us
               ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = 'warehouse'
        LEFT JOIN identity.role_scopes rs
               ON rs.tenant_id = u.tenant_id AND lower(rs.role_name) = lower(u.role_name) AND rs.dimension = 'warehouse'
       WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
         AND (rp.permissions -> 'COMPRAS_ENTRADAS_VALIDAR')::text = 'true'`, [T]);

    if (!rows.length) { console.log('  ⚠️  nadie con COMPRAS_ENTRADAS_VALIDAR — SKIP'); process.exit(0); }

    const god = [], todos = [], acotados = [], sinRegla = [];
    for (const u of rows) {
      if (GOD.has(String(u.role_name).toLowerCase())) { god.push(u); continue; }
      const modo = u.u_w || u.r_w;
      if (modo === 'all') todos.push(u);
      else if (modo === 'own' || modo === 'listed') acotados.push(u);
      else sinRegla.push(u);
    }
    console.log(`\n  ${rows.length} usuarios con _VALIDAR: ${god.length} god-mode · ${todos.length} alcance all · ${acotados.length} acotados · ${sinRegla.length} sin regla\n`);

    // LA aserción que evita tumbar a alguien en un deploy: el default de `modeWrite` es `none`
    // (fail-closed), así que un usuario sin regla y sin god-mode queda sin poder validar NADA
    // en cuanto el guard entra. Si esto se pone rojo, hay que darle alcance ANTES de desplegar.
    ok(sinRegla.length === 0,
      sinRegla.length === 0
        ? 'nadie con _VALIDAR queda sin alcance de escritura (el guard no tumba a nadie)'
        : `${sinRegla.length} usuario(s) con _VALIDAR y SIN regla de alcance: ${sinRegla.map((u) => u.username + '/' + u.role_name).join(', ')} — el guard los bloquea`);

    // Si nadie está acotado, el guard es inocuo. No es un error, pero sí algo que conviene ver:
    // significa que el control documental entre sucursales hoy no está separando nada.
    if (!acotados.length) console.log('     (nadie acotado: el guard no restringe a nadie hoy)');
    else {
      ok(true, `${acotados.length} con alcance acotado — el guard los limita a su sucursal:`);
      for (const u of acotados) console.log(`        · ${u.username} (${u.role_name} → ${u.warehouse_code || '?'})`);
    }

    // Los acotados por `own` resuelven su sucursal desde `users.warehouse_code`: sin ese campo
    // el alcance `own` no tiene a qué apuntar y el guard los bloquea aunque tengan regla.
    const ownSinSucursal = acotados.filter((u) => (u.u_w || u.r_w) === 'own' && !u.warehouse_code);
    ok(ownSinSucursal.length === 0,
      ownSinSucursal.length === 0
        ? "los de alcance 'own' tienen sucursal asignada (el 'own' resuelve a algo)"
        : `${ownSinSucursal.length} con 'own' y SIN warehouse_code: ${ownSinSucursal.map((u) => u.username).join(', ')}`);

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`}`);
  } catch (e) {
    console.error('  ❌ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
