/* eslint-disable no-console */
/**
 * `[E.12.2]` — **Cotizaciones por HTTP, con un rol de PERMISO MÍNIMO y su prueba negativa.**
 *
 * Por qué existe aparte del smoke de base: `test-newdb-quotes.js` inserta directo a la tabla y
 * comprueba los candados del esquema. Eso **no toca los guards ni el SQL del servicio**, y por
 * eso no vio dos errores de Postgres que la primera llamada HTTP real destapó en E.12.1 (42725
 * operador ambiguo y 42P18 parámetro sin tipo). ADR-044: la verificación HTTP es su propio paso.
 *
 * ⚠️ **Y no se prueba con un admin.** Los roles de plataforma pasan por god-mode
 * (`isPlatformAdminRole`), así que un `@RequirePermissions` mal puesto —o un permiso que nadie
 * repartió— sale VERDE con `superoot` y rojo para todos los demás. Es exactamente la forma que
 * tuvo `[LC.6.2]`: un módulo en prod que nadie podía abrir. Por eso acá hay DOS usuarios
 * efímeros:
 *
 *   · `telemarketing`  → el rol que la migración 20260921210000 reparte. Tiene que ENTRAR.
 *   · `almacenista`    → un rol cualquiera sin la llave. Tiene que recibir **403**.
 *
 * Sin el segundo, un gate abierto de par en par pasaría el test igual.
 *
 * Pre-requisitos: API en :3334 y las migraciones de E.12 aplicadas.
 * Uso: node database/tests/http-quotes-test.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const bcrypt = require('bcryptjs');

const BASE = 'http://localhost:3334/api';
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUF = String(Date.now()).slice(-8);
const PASS_PLANO = `Smoke!${SUF}`;

let pass = 0;
let fail = 0;
const check = (name, cond, det) => {
  if (cond) {
    console.log(`  ✅ ${name}`);
    pass++;
  } else {
    console.log(`  ❌ ${name}${det ? ' — ' + det : ''}`);
    fail++;
  }
};

async function req(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* respuesta sin cuerpo */
  }
  return { status: r.status, body: json };
}

/** Crea un usuario efímero con un rol dado y devuelve su username. */
async function crearUsuario(rol) {
  const username = `smoke_${rol}_${SUF}`.slice(0, 40);
  await knex('identity.users').insert({
    tenant_id: T,
    username,
    nombre: `SMOKE ${rol}`,
    password_hash: await bcrypt.hash(PASS_PLANO, 10),
    role_name: rol,
  });
  return username;
}

async function login(username) {
  const r = await req('POST', '/auth-mt/login', null, {
    tenant_slug: 'mega_dulces',
    username,
    password: PASS_PLANO,
  });
  return { token: r.body?.access_token ?? null, status: r.status };
}

(async () => {
  console.log('\n=== [E.12.2] Cotizaciones por HTTP — rol mínimo y prueba negativa ===\n');

  let uOperador = null;
  let uSinLlave = null;
  const creadas = [];

  try {
    // ── 0. Los dos usuarios efímeros ───────────────────────────────────────────────────────
    console.log('0 — usuarios de prueba (se borran al final)');
    uOperador = await crearUsuario('telemarketing');
    uSinLlave = await crearUsuario('almacenista');
    check('creados los 2 usuarios efímeros', !!uOperador && !!uSinLlave);

    const op = await login(uOperador);
    const sin = await login(uSinLlave);
    check(`login del operador (${uOperador})`, !!op.token, `status ${op.status}`);
    check(`login del rol sin llave (${uSinLlave})`, !!sin.token, `status ${sin.status}`);
    if (!op.token || !sin.token) {
      console.log('\n  ⚠️  NO MEDIDO: sin token no se puede probar ningún gate.');
      return;
    }

    // Se comprueba que el rol mínimo NO es admin de plataforma: si lo fuera, todo lo de abajo
    // pasaría por god-mode y este test no probaría nada.
    const payload = JSON.parse(Buffer.from(op.token.split('.')[1], 'base64').toString());
    check(
      `el token es del rol telemarketing, NO de un admin (role=${payload.role_name})`,
      payload.role_name === 'telemarketing',
    );

    // ── 1. Lectura ─────────────────────────────────────────────────────────────────────────
    console.log('\n1 — lectura con COMMERCIAL_QUOTES_VER');
    const lista = await req('GET', '/commercial/quotes', op.token);
    check('GET /commercial/quotes → 200', lista.status === 200, `status ${lista.status}`);
    check('devuelve {rows,total}', Array.isArray(lista.body?.rows), JSON.stringify(lista.body).slice(0, 120));

    const resumen = await req('GET', '/commercial/quotes/summary', op.token);
    check('GET /summary → 200', resumen.status === 200, `status ${resumen.status}`);
    check(
      'el resumen declara los 6 estados en 0 explícito (un estado ausente se lee como "no aplica")',
      resumen.body?.by_status && Object.keys(resumen.body.by_status).length === 6,
    );

    // ── 2. El padrón de mayoreo ────────────────────────────────────────────────────────────
    console.log('\n2 — el padrón de mayoreo derivado del ERP');
    const padron = await req('GET', '/commercial/quotes/wholesale-customers?search=C1086', op.token);
    check('GET /wholesale-customers → 200', padron.status === 200, `status ${padron.status}`);
    const c = Array.isArray(padron.body) ? padron.body[0] : null;
    check('encuentra C1086', c?.customer_code === 'C1086', JSON.stringify(padron.body).slice(0, 120));
    check(
      'trae sus sucursales, no una sola fila colapsada',
      Array.isArray(c?.branches) && c.branches.length > 1,
      `branches=${c?.branches?.length}`,
    );
    check(
      'declara que sus condiciones VARÍAN entre sucursales',
      c?.terms_vary_by_branch === true,
    );
    const suc01 = c?.branches?.find((b) => b.sucursal === '01');
    check(
      'la sucursal 01 trae 3% de descuento (lo que el ERP muestra en pantalla)',
      Number(suc01?.discount_1_pct) === 3,
      `descuento=${suc01?.discount_1_pct}`,
    );

    // ── 3. Alta ────────────────────────────────────────────────────────────────────────────
    console.log('\n3 — alta con COMMERCIAL_QUOTES_GESTIONAR');
    const creada = await req('POST', '/commercial/quotes', op.token, {
      erp_customer_code: 'C1086',
      source_branch: '01',
      origin: 'telemarketing',
      customer_request: `SMOKE ${SUF}`,
    });
    check('POST /commercial/quotes → 201', creada.status === 201, `status ${creada.status} ${JSON.stringify(creada.body).slice(0,140)}`);
    if (creada.body?.id) creadas.push(creada.body.id);
    check('devuelve folio COT-', String(creada.body?.code || '').startsWith('COT-'), creada.body?.code);
    check(
      'CONGELÓ las condiciones leyéndolas del ERP, no del request',
      creada.body?.terms_source === 'kepler_kdud' && Number(creada.body?.terms_discount_pct) === 3,
      `source=${creada.body?.terms_source} desc=${creada.body?.terms_discount_pct}`,
    );
    check(
      'y el límite y el plazo de ESA sucursal',
      Number(creada.body?.terms_credit_limit) === 60000 && Number(creada.body?.terms_payment_days) === 15,
      `limite=${creada.body?.terms_credit_limit} plazo=${creada.body?.terms_payment_days}`,
    );

    // El alta rechaza lo que no puede reproducir.
    const sinSuc = await req('POST', '/commercial/quotes', op.token, {
      erp_customer_code: 'C1086',
      origin: 'telemarketing',
    });
    check('cliente del ERP sin sucursal → 400', sinSuc.status === 400, `status ${sinSuc.status}`);

    const inexistente = await req('POST', '/commercial/quotes', op.token, {
      erp_customer_code: 'C9999',
      source_branch: '01',
    });
    check('cliente que no existe en el padrón → 404', inexistente.status === 404, `status ${inexistente.status}`);

    // ── 4. LA PRUEBA NEGATIVA: el rol sin la llave ─────────────────────────────────────────
    console.log('\n4 — el rol SIN la llave no entra (sin esto, un gate abierto pasaría igual)');
    const nLista = await req('GET', '/commercial/quotes', sin.token);
    check('GET /commercial/quotes sin permiso → 403', nLista.status === 403, `status ${nLista.status}`);

    const nPadron = await req('GET', '/commercial/quotes/wholesale-customers', sin.token);
    check('GET /wholesale-customers sin permiso → 403', nPadron.status === 403, `status ${nPadron.status}`);

    const nAlta = await req('POST', '/commercial/quotes', sin.token, {
      erp_customer_code: 'C1086',
      source_branch: '01',
    });
    check('POST /commercial/quotes sin permiso → 403', nAlta.status === 403, `status ${nAlta.status}`);

    // ── 5. Cancelar ────────────────────────────────────────────────────────────────────────
    console.log('\n5 — cancelar exige motivo');
    if (creada.body?.id) {
      const sinMotivo = await req('POST', `/commercial/quotes/${creada.body.id}/cancel`, op.token, {});
      check('cancelar sin motivo → 400', sinMotivo.status === 400, `status ${sinMotivo.status}`);

      const conMotivo = await req('POST', `/commercial/quotes/${creada.body.id}/cancel`, op.token, {
        reason: 'smoke test',
      });
      check('cancelar con motivo → 201', conMotivo.status === 201 || conMotivo.status === 200, `status ${conMotivo.status}`);
      check('queda cancelled', conMotivo.body?.status === 'cancelled', conMotivo.body?.status);
    } else {
      console.log('  ⚠️  NO MEDIDO: no hubo cotización que cancelar.');
    }
  } finally {
    // Limpieza: sólo lo que este smoke creó.
    if (creadas.length) {
      await knex('commercial.quote_lines').whereIn('quote_id', creadas).del();
      await knex('commercial.quotes').whereIn('id', creadas).del();
    }
    for (const u of [uOperador, uSinLlave].filter(Boolean)) {
      await knex('identity.users').where({ tenant_id: T, username: u }).del();
    }
    await knex.destroy();
  }

  console.log(`\n${fail === 0 ? `✅ TODO VERDE (${pass})` : `❌ ${fail} FALLAS de ${pass + fail}`}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
