/* eslint-disable no-console */
/**
 * `[CGA-A.19]` Cuentas de Kepler — la cobertura de la cola y la configuración por entidad, por HTTP.
 *
 * Ejerce los DOS endpoints que escriben con el payload exacto de la pantalla
 * (`caja-cuentas-kepler.component.ts`): `POST /autofill/declarar` y `DELETE /autofill/declaradas/:e`.
 * La entidad es SINTÉTICA (`ZZTEST-…`) y la prueba la quita al final, así que no deja rastro.
 *
 * ⚠️ NO SE HA CORRIDO a la fecha de escribirla (2026-10-23): necesita API arriba, y en esta sesión
 * está prohibido levantar el backend en local (CLAUDE.md). Va a `run-all-tests.js` con `needsApi`.
 *
 * Requisitos: un usuario con FINANCE_CAJA_VER + FINANCE_CAJA_AUTORIZAR (re-loguear: el permiso
 * viaja en el JWT).
 *
 *   API=http://localhost:3334/api USER_TEST=... PASS=... node database/tests/http-caja-cuentas-kepler-test.js
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
  const ENT = `ZZTEST-${Date.now().toString(36).toUpperCase()}`;
  let declarada = false;
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

    console.log('\n── 1. La cobertura se mide sobre el universo y sus tres estados suman ──');
    const cob = await api('GET', '/finance/cash-ledger/cuentas-kepler/cobertura');
    ok(cob.status === 200, `GET /cuentas-kepler/cobertura → 200 (got ${cob.status})`);
    const c = cob.body || {};
    const suma = (c.con_cuenta?.movimientos ?? NaN) + (c.falta_concepto?.movimientos ?? NaN) + (c.sin_cuenta?.movimientos ?? NaN);
    ok(suma === c.universo, `con_cuenta + falta_concepto + sin_cuenta = universo (${suma} = ${c.universo})`);
    ok(typeof c.truncado === 'boolean', 'declara si el universo se truncó');
    const enEntidades = (c.sin_cuenta_por_entidad || []).reduce((a, g) => a + Number(g.movimientos || 0), 0);
    ok(enEntidades === c.sin_cuenta?.movimientos, `la lista por entidad cubre TODOS los sin cuenta (${enEntidades} = ${c.sin_cuenta?.movimientos})`);
    if (c.universo > 0 && !c.truncado) {
      console.log(`  ⓘ cobertura: ${c.con_cuenta.movimientos} de ${c.universo} con cuenta y concepto · ${c.sin_cuenta.movimientos} sin cuenta · ${c.medido_ms} ms`);
      ok(c.medido_ms < 2000, `se mide en menos de 2 s (${c.medido_ms} ms)`);
    } else {
      skip(c.universo ? 'el universo pasó el tope: no se puede afirmar el total' : 'la cola está vacía: no hay con qué medir la cobertura');
    }

    console.log('\n── 2. Declarar: las negativas primero ──');
    const cs = await api('GET', '/finance/cash-ledger/conceptos?limit=5');
    const par = cs.body?.rows?.[0];
    ok(!!par?.cuenta && !!par?.concepto, 'hay un par del catálogo con qué declarar');

    const sinMotivo = await api('POST', '/finance/cash-ledger/autofill/declarar', {
      entidad_code: ENT, kepler_cuenta: par?.cuenta, kepler_concepto: par?.concepto, motivo: 'corto', sucursal: par?.sucursal,
    });
    ok(sinMotivo.status === 400, `[negativa] motivo de menos de 10 caracteres → 400 (got ${sinMotivo.status})`);

    const parFalso = await api('POST', '/finance/cash-ledger/autofill/declarar', {
      entidad_code: ENT, kepler_cuenta: 'NO-EXISTE', kepler_concepto: '999', motivo: 'Prueba de par inexistente', sucursal: par?.sucursal,
    });
    ok(parFalso.status >= 400 && parFalso.status < 500, `[negativa] par que no está en el catálogo → 4xx (got ${parFalso.status})`);

    console.log('\n── 3. Declarar, listar, cambiar y quitar (el payload de la pantalla) ──');
    const dec = await api('POST', '/finance/cash-ledger/autofill/declarar', {
      entidad_code: ENT, kepler_cuenta: par?.cuenta, kepler_concepto: par?.concepto,
      motivo: 'Prueba automatica CGA-A.19, se quita al final', sucursal: par?.sucursal,
    });
    declarada = dec.status === 200 || dec.status === 201;
    ok(declarada, `POST /autofill/declarar → 2xx (got ${dec.status})`);
    ok(dec.body?.entidad_code === ENT && dec.body?.kepler_cuenta === par?.cuenta, 'devuelve lo guardado');

    const lista = await api('GET', '/finance/cash-ledger/autofill/declaradas');
    ok(lista.status === 200 && (lista.body || []).some((d) => d.entidad_code === ENT), 'la declaración aparece en la lista');

    const otra = await api('POST', '/finance/cash-ledger/autofill/declarar', {
      entidad_code: ENT, kepler_cuenta: par?.cuenta, kepler_concepto: par?.concepto,
      motivo: 'Segunda vez: idempotente por entidad', sucursal: par?.sucursal,
    });
    const lista2 = await api('GET', '/finance/cash-ledger/autofill/declaradas');
    ok(otra.status < 300 && (lista2.body || []).filter((d) => d.entidad_code === ENT).length === 1,
      'declarar dos veces CAMBIA la fila, no la duplica');

    const saved = token; token = null;
    const sinToken = await api('DELETE', `/finance/cash-ledger/autofill/declaradas/${encodeURIComponent(ENT)}`);
    ok(sinToken.status === 401 || sinToken.status === 403, `[negativa] quitar sin token → 401/403 (got ${sinToken.status})`);
    token = saved;

    const q1 = await api('DELETE', `/finance/cash-ledger/autofill/declaradas/${encodeURIComponent(ENT)}`);
    ok(q1.status === 200 && q1.body?.quitada === true, `DELETE → quitada:true (got ${q1.status} ${JSON.stringify(q1.body)})`);
    declarada = !(q1.body?.quitada === true);
    const q2 = await api('DELETE', `/finance/cash-ledger/autofill/declaradas/${encodeURIComponent(ENT)}`);
    ok(q2.status === 200 && q2.body?.quitada === false, '[negativa] quitar lo que no existe → quitada:false, no un 500');

    const lista3 = await api('GET', '/finance/cash-ledger/autofill/declaradas');
    ok(!(lista3.body || []).some((d) => d.entidad_code === ENT), 'ya no está en la lista');
  } catch (e) {
    console.error('\n💥', e.message);
    fail++;
  } finally {
    if (declarada && token) {
      const r = await api('DELETE', `/finance/cash-ledger/autofill/declaradas/${encodeURIComponent(ENT)}`).catch(() => null);
      console.log(`  ⓘ limpieza de ${ENT}: ${r ? r.status : 'falló'}`);
    }
    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${skipped} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  }
})();
