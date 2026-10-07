/* eslint-disable no-console */
/**
 * Fase CG — capa BACKEND por HTTP (ADR-044: lo que toca Postgres se prueba corrido de verdad).
 *
 * ⚠️ ESTA SUITE NO SE HABÍA CORRIDO CUANDO SE ESCRIBIÓ (2026-09-18). Las dos APIs de dev
 * estaban arriba pero levantadas ANTES de este código, así que `/api/finance/cash-ledger`
 * devolvía 404 en las dos. Reiniciar los dev servers es del dueño de la máquina, no de esta
 * sesión. Lo que SÍ está verificado a esta fecha: la capa BD contra Postgres real
 * (`test-newdb-cash-ledger.js`, 58 aserciones) y el motor de decisión con pruebas unitarias
 * (`caja-autofill.engine.spec.ts`, 35). Esta suite cubre lo que queda en medio: guards,
 * validación y transaccionalidad vistas desde afuera.
 *
 * Requisitos: API arriba y un usuario con FINANCE_CAJA_VER/_GESTIONAR (la migración
 * 20260918170000 los reparte; hay que RE-LOGUEAR, los permisos viajan en el JWT).
 *
 *   API=http://localhost:3334/api USER=... PASS=... node database/tests/http-cash-ledger-test.js
 */
const BASE = process.env.API || 'http://localhost:3334/api';
const USER = process.env.USER_TEST || process.env.USER || 'superuser';
const PASS = process.env.PASS || process.env.PASSWORD;

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { skipped++; console.log('  ⃝ NO MEDIDO —', m); };

let token = null;
async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* respuesta sin cuerpo */ }
  return { status: r.status, body: json };
}

(async () => {
  try {
    if (!PASS) { console.log('Falta PASS. Uso: API=... USER_TEST=... PASS=... node ...'); process.exitCode = 2; return; }

    console.log('\n── 0. Login ──');
    const login = await api('POST', '/auth-mt/login', { username: USER, password: PASS });
    if (login.status !== 200 && login.status !== 201) {
      console.log(`  ✗ login falló (${login.status}). El resto no se puede medir.`);
      process.exitCode = 1; return;
    }
    token = login.body?.access_token || login.body?.token;
    ok(!!token, 'login devuelve token');

    console.log('\n── 1. El catálogo de conceptos se sirve, y declara su cobertura ──');
    const cob = await api('GET', '/finance/cash-ledger/cobertura');
    ok(cob.status === 200, `GET /cobertura → 200 (got ${cob.status})`);
    ok(Array.isArray(cob.body?.catalogo), 'la cobertura del catálogo viene como lista');
    const totalUsables = (cob.body?.catalogo || []).reduce((a, r) => a + Number(r.usables || 0), 0);
    ok(totalUsables > 0, `hay conceptos usables (${totalUsables}) — si esto da 0, el carril del ODS está caído, no es que "no haya conceptos"`);

    const cs = await api('GET', '/finance/cash-ledger/conceptos?limit=5');
    ok(cs.status === 200 && Array.isArray(cs.body?.rows), 'GET /conceptos → 200 con filas');
    const muestra = cs.body?.rows?.[0];
    ok(!!muestra?.cuenta && !!muestra?.concepto && !!muestra?.sucursal,
      'cada concepto trae cuenta + concepto + SUCURSAL (el concepto no es global)');

    console.log('\n── 2. La captura valida contra el catálogo vivo ──');
    const malPar = await api('POST', '/finance/cash-ledger', {
      tipo: 'gasto', fecha: new Date().toISOString().slice(0, 10), sucursal: muestra?.sucursal || '00',
      kepler_cuenta: 'NO-EXISTE', kepler_concepto: '999',
      glosa: 'Prueba de par inexistente', monto: 100,
    });
    ok(malPar.status === 400, `[negativa] par cuenta/concepto inexistente → 400 (got ${malPar.status})`);

    const glosaCorta = await api('POST', '/finance/cash-ledger', {
      tipo: 'gasto', fecha: new Date().toISOString().slice(0, 10), sucursal: muestra?.sucursal,
      kepler_cuenta: muestra?.cuenta, kepler_concepto: muestra?.concepto,
      glosa: 'x', monto: 100,
    });
    ok(glosaCorta.status >= 400, `[negativa] glosa de 1 carácter no entra (got ${glosaCorta.status})`);

    const arqueoMal = await api('POST', '/finance/cash-ledger', {
      tipo: 'ingreso', fecha: new Date().toISOString().slice(0, 10), sucursal: muestra?.sucursal,
      kepler_cuenta: muestra?.cuenta, kepler_concepto: muestra?.concepto,
      glosa: 'Arqueo que no cuadra a proposito', monto: 1000,
      denominaciones: [{ denominacion: 500, piezas: 1 }],
    });
    ok(arqueoMal.status === 400, `[negativa] desglose que no cuadra con el monto → 400 (got ${arqueoMal.status})`);

    console.log('\n── 3. Un movimiento real: folio, snapshot y arqueo ──');
    const cu = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const clientUuid = `00000000-0000-4000-8000-${cu.replace(/\D/g, '').slice(0, 12).padEnd(12, '0')}`;
    const body = {
      tipo: 'ingreso', fecha: new Date().toISOString().slice(0, 10), sucursal: muestra?.sucursal,
      kepler_cuenta: muestra?.cuenta, kepler_concepto: muestra?.concepto,
      glosa: 'Movimiento de prueba HTTP de la fase CG', monto: 1234.56, morralla: 4.56,
      denominaciones: [{ denominacion: 1000, piezas: 1 }, { denominacion: 100, piezas: 2 }, { denominacion: 10, piezas: 3 }],
      client_uuid: clientUuid,
    };
    const creado = await api('POST', '/finance/cash-ledger', body);
    ok(creado.status === 200 || creado.status === 201, `POST → ${creado.status}`);
    ok(/^CI-\d{4}-\d{5}$/.test(creado.body?.folio || ''), `el folio tiene forma CI-AAAA-NNNNN (${creado.body?.folio})`);
    ok(!!creado.body?.kepler_concepto_nombre, 'guarda el NOMBRE del concepto como snapshot');
    ok(!!creado.body?.created_by, 'guarda el autor real (no un texto)');

    const repetido = await api('POST', '/finance/cash-ledger', body);
    ok(repetido.body?.folio === creado.body?.folio,
      'el reintento con el mismo client_uuid devuelve el MISMO movimiento (idempotencia), no uno nuevo');

    const det = await api('GET', `/finance/cash-ledger/${creado.body?.id}`);
    ok(det.status === 200, `GET /:id → 200`);
    ok(Number(det.body?.arqueo?.diferencia) === 0, `el arqueo cuadra al centavo (dif ${det.body?.arqueo?.diferencia})`);
    ok((det.body?.denominaciones || []).length === 3, 'el detalle trae las 3 denominaciones');

    console.log('\n── 4. Autorrelleno: propone con procedencia, o se calla con motivo ──');
    const af = await api('POST', '/finance/cash-ledger/autofill', {
      tipo: 'gasto', sucursal: muestra?.sucursal, glosa: 'Compra de papeleria', beneficiario: 'PROVEEDOR QUE NO EXISTE SA',
    });
    ok(af.status === 200 || af.status === 201, `POST /autofill → ${af.status}`);
    ok(af.body?.concepto !== undefined, 'devuelve una propuesta de concepto');
    if (af.body?.concepto?.value === null) {
      ok(!!af.body?.concepto?.reason, `sin propuesta, PERO con motivo ("${af.body?.concepto?.reason}") — no un default`);
    } else {
      ok(!!af.body?.concepto?.source && af.body?.concepto?.confidence !== null,
        'con propuesta, trae fuente y confianza (procedencia)');
    }
    ok(!!af.body?.niveles, 'declara qué niveles se pudieron consultar (un nivel caído ≠ "no propuso")');

    console.log('\n── 5. Los guards son de verdad ──');
    const saved = token; token = null;
    const sinToken = await api('GET', '/finance/cash-ledger');
    ok(sinToken.status === 401 || sinToken.status === 403, `[negativa] sin token → 401/403 (got ${sinToken.status})`);
    token = saved;

    console.log('\n── 6. Limpieza ──');
    skip('el movimiento de prueba queda en la DB: el endpoint de cancelación es de CG.15 y todavía no existe. Borrarlo a mano si se corrió contra una base que importe.');

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${skipped} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n💥', e.message);
    process.exitCode = 1;
  }
})();
