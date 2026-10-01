'use strict';
/**
 * `[MKT.6]` — La capa HTTP del resultado de la activación, ejercida de verdad.
 *
 * ── Por qué existe además del smoke de base ─────────────────────────────────────────────────
 * `test-newdb-promo-sellout.js` prueba la ARITMÉTICA contra la base y declara explícitamente
 * «la capa HTTP NO se ejerció». Esto la cierra. No es redundante: entre la vista y el navegador
 * hay un guard de permisos, un `TenantKnexService.run()` que sin `SET LOCAL app.tenant_id`
 * devuelve **cero filas en silencio**, y una conversión de `numeric` a JSON que puede convertir
 * un NULL en 0 sin que ninguna consulta se entere (ADR-044).
 *
 * ── Lo que afirma ────────────────────────────────────────────────────────────────────────────
 *  1. Las 5 rutas contestan y el JSON llega con la forma que la pantalla espera.
 *  2. ⭐ **El `null` sobrevive al viaje.** Un canal sin medir tiene que llegar con
 *     `monto_ventana: null`, no con `0` ni con la clave ausente: la pantalla dibuja "—" a partir
 *     de eso, y un 0 diría «no vendió» donde lo cierto es «no se pudo medir» (ADR-056).
 *  3. ⭐ **Sin token no se entra.** Un 200 sin credencial en un endpoint que expone el monto
 *     negociado con el proveedor es una fuga, no un descuido de forma.
 *  4. El rollup del acuerdo agrega sólo los canales medidos y cuadra con la lista.
 *  5. La conciliación DECLARA su estado (`fuente_vacia` con el espejo vacío), nunca $0.
 *
 * Uso: API_BASE=http://127.0.0.1:3402/api node database/tests/http-promo-sellout-test.js
 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:3334/api';
const USER = process.env.SMOKE_USER || 'superoot';
const PASS = process.env.SMOKE_PASS || 'superoot';

let fail = 0;
let n = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); n++; if (!c) fail++; };
const nm = (m) => console.log(`  ⚠️  NO MEDIDO — ${m}`);

const get = async (ruta, token) => {
  const r = await fetch(`${BASE}${ruta}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body = null;
  try { body = await r.json(); } catch { /* 204 o html */ }
  return { status: r.status, body };
};

(async () => {
  try {
    // ── Login ────────────────────────────────────────────────────────────────────────────────
    const lr = await fetch(`${BASE}/auth-mt/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_slug: 'mega_dulces', username: USER, password: PASS }),
    });
    if (!lr.ok) {
      nm(`no se pudo autenticar contra ${BASE} (${lr.status}): ¿la API está arriba?`);
      process.exit(2);
    }
    const token = (await lr.json()).access_token;
    ok(!!token, 'login OK');

    // ── [1] ⭐ NEGATIVA: sin token no se entra ───────────────────────────────────────────────
    console.log('\n[1] ⭐ Sin credencial no se contesta (acá viaja el monto negociado)');
    const anon = await get('/commercial/promo-sellout', null);
    ok(anon.status === 401 || anon.status === 403,
      `sin token → ${anon.status} (401/403 esperado, NO 200)`);

    // ── [2] La bandeja ───────────────────────────────────────────────────────────────────────
    console.log('\n[2] La bandeja contesta con la forma que la pantalla espera');
    const lista = await get('/commercial/promo-sellout', token);
    ok(lista.status === 200, `GET /promo-sellout → ${lista.status}`);
    ok(Array.isArray(lista.body), 'devuelve un arreglo');
    if (!Array.isArray(lista.body) || !lista.body.length) {
      nm('la bandeja vino vacía: sin acuerdos no se puede afirmar nada más');
      console.log(`\n  ${fail ? '❌' : '✅'} ${n - fail}/${n} aserciones · ${fail} fallas`);
      process.exit(fail ? 1 : 0);
    }
    const campos = ['channel_id', 'agreement_id', 'folio', 'proveedor', 'warehouse_code',
      'medicion', 'monto_ventana', 'monto_baseline', 'uplift_monto', 'codigos_ligados',
      'codigos_total', 'ventana_abierta', 'unidad_estado'];
    const faltan = campos.filter((c) => !(c in lista.body[0]));
    ok(faltan.length === 0, `la fila trae los 13 campos${faltan.length ? ' — faltan: ' + faltan.join(', ') : ''}`);

    const estados = [...new Set(lista.body.map((r) => r.medicion))];
    ok(estados.every((e) => ['medida', 'sin_venta', 'sin_baseline', 'sin_alcance'].includes(e)),
      `medicion sólo trae estados declarados: ${estados.join(', ')}`);

    // ── [3] ⭐ El null sobrevive el viaje ────────────────────────────────────────────────────
    console.log('\n[3] ⭐ Un canal sin medir llega con null, no con 0 ni sin la clave');
    const sinMedir = lista.body.find((r) => r.medicion !== 'medida');
    if (!sinMedir) {
      nm('no hay ningún canal sin medir en esta base: el caso no se pudo ejercer por HTTP');
    } else {
      ok('monto_ventana' in sinMedir, 'la clave monto_ventana viaja (no se omite)');
      ok(sinMedir.monto_ventana === null,
        `monto_ventana === null en '${sinMedir.medicion}' (llegó: ${JSON.stringify(sinMedir.monto_ventana)})`);
      ok(sinMedir.uplift_pct === null, 'uplift_pct === null');
      // Y el contraste: donde SÍ se midió, llega un número. Si todo fuera null, la aserción
      // de arriba se cumpliría con la ruta rota.
      const medida = lista.body.find((r) => r.medicion === 'medida');
      if (medida) {
        ok(typeof medida.monto_ventana === 'number' && medida.monto_ventana > 0,
          `CONTROL POSITIVO: un canal medido llega con número (${medida.monto_ventana})`);
      } else {
        nm('no hay ningún canal medido: falta el control positivo del null');
      }
    }

    // ── [4] El rollup del acuerdo cuadra con su lista ────────────────────────────────────────
    console.log('\n[4] El rollup agrega SÓLO los medidos y cuadra con sus canales');
    const conMedida = lista.body.find((r) => r.medicion === 'medida') || lista.body[0];
    const det = await get(`/commercial/promo-sellout/acuerdo/${conMedida.agreement_id}`, token);
    ok(det.status === 200, `GET /acuerdo/:id → ${det.status}`);
    const res = det.body?.resumen;
    const canales = det.body?.canales || [];
    ok(!!res && Array.isArray(canales), 'devuelve { resumen, canales }');
    if (res) {
      ok(res.canales_total === canales.length,
        `canales_total (${res.canales_total}) == canales devueltos (${canales.length})`);
      const medidos = canales.filter((c) => c.medicion === 'medida').length;
      ok(res.canales_medidos === medidos, `canales_medidos (${res.canales_medidos}) == ${medidos}`);
      const suma = res.no_medidos.sin_venta + res.no_medidos.sin_baseline + res.no_medidos.sin_alcance;
      // Si un motivo se perdiera, el tablero diría que midió más de lo que midió.
      ok(suma === res.canales_total - res.canales_medidos,
        `los no medidos suman exactamente total − medidos (${suma})`);
      if (medidos === 0) {
        ok(res.monto_ventana === null, 'sin canales medidos el rollup va null, no 0');
      } else {
        const esperado = Math.round(
          canales.filter((c) => c.medicion === 'medida')
            .reduce((a, c) => a + (c.monto_ventana || 0), 0) * 100) / 100;
        ok(Math.abs(res.monto_ventana - esperado) < 0.01,
          `monto_ventana del rollup (${res.monto_ventana}) == suma de los medidos (${esperado})`);
      }
    }

    // ── [5] El diagnóstico de cobertura ──────────────────────────────────────────────────────
    console.log('\n[5] Cobertura: las tres categorías particionan');
    const cob = await get(`/commercial/promo-sellout/acuerdo/${conMedida.agreement_id}/cobertura`, token);
    ok(cob.status === 200, `GET /cobertura → ${cob.status}`);
    if (cob.body) {
      const c = cob.body;
      ok(c.ligados + c.sin_ligar_resolubles + c.sin_ligar_sin_match === c.codigos_total,
        `${c.ligados} + ${c.sin_ligar_resolubles} + ${c.sin_ligar_sin_match} == ${c.codigos_total}`);
    }

    // ── [6] ⭐ La conciliación DECLARA, no dibuja $0 ─────────────────────────────────────────
    console.log('\n[6] ⭐ Negociado vs acreditado: una fuente vacía no es un cero');
    const con = await get(`/commercial/promo-sellout/acuerdo/${conMedida.agreement_id}/conciliacion`, token);
    ok(con.status === 200, `GET /conciliacion → ${con.status}`);
    if (con.body) {
      const k = con.body;
      ok(['conciliado', 'sin_acreditacion', 'fuente_vacia', 'sin_liga', 'sin_monto'].includes(k.estado),
        `estado declarado: '${k.estado}'`);
      ok(typeof k.nota === 'string' && k.nota.length > 0, 'trae una nota que explica el estado');
      if (k.estado === 'fuente_vacia') {
        // Éste es el punto entero: el espejo del ERP está vacío y el endpoint NO inventa un 0.
        ok(k.monto_acreditado === null, 'con la fuente vacía, monto_acreditado === null (no 0)');
        nm('el espejo de notas de crédito está vacío: la conciliación con datos reales sigue sin medirse');
      }
    }

    // ── [7] Por sucursal ─────────────────────────────────────────────────────────────────────
    console.log('\n[7] La ruta por plaza contesta y devuelve sólo esa plaza');
    const suc = await get(`/commercial/promo-sellout/sucursal/${conMedida.warehouse_code}`, token);
    ok(suc.status === 200, `GET /sucursal/${conMedida.warehouse_code} → ${suc.status}`);
    if (Array.isArray(suc.body) && suc.body.length) {
      ok(suc.body.every((r) => r.warehouse_code.toUpperCase() === conMedida.warehouse_code.toUpperCase()),
        `las ${suc.body.length} filas son de esa plaza`);
    } else {
      nm('la plaza no devolvió filas');
    }
    // ⚠️ El recorte por ALCANCE no se puede ejercer con `superoot` (ve todo). Lo prueba
    // `promo-sellout.scope.spec.ts` con dobles, que es donde vive la decisión de cortar.
    nm('el corte por alcance NO se ejerció acá: `superoot` ve todas las plazas (lo cubre el spec)');

  } catch (e) {
    console.error('\n  💥', e.message);
    fail++;
  } finally {
    console.log(`\n  ${fail ? '❌' : '✅'} ${n - fail}/${n} aserciones · ${fail} fallas`);
    process.exit(fail ? 1 : 0);
  }
})();
