/* eslint-disable no-console */
/**
 * WMS-REC — La luz verde da de alta la mercancía y la manda a Caducidades.
 *
 * Es el flujo que se decidió (cambio a ADR-044):
 *
 *   RECEPCIÓN    el operador teclea el folio del ERP, confirma cantidades y aprueba.
 *                Al cerrar, la mercancía ENTRA a inventario en el lote 'NA' (sin fecha).
 *   CADUCIDADES  el bodeguero ve esa mercancía en una bandeja y le pone las fechas.
 *                Poner la fecha reclasifica NA → lote fechado; el total no se mueve.
 *
 * Lo que se verifica acá, contra los endpoints REALES:
 *   1. el stock sube exactamente lo recibido al dar luz verde
 *   2. entra al lote 'NA' — no se le inventa una caducidad
 *   3. el renglón aparece en la bandeja de Caducidades con su faltante
 *   4. cerrar dos veces NO duplica existencia (idempotencia sin columna nueva)
 *   5. poner la fecha lo saca de la bandeja y NO mueve el total
 *
 * Skip-graceful: sin espejo del ERP (entorno sin feed) no falla, se salta.
 *
 * Correr: node database/tests/http-luz-verde-caducidades-test.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:3334/api';
const SUPEROOT_PASS = process.env.SUPEROOT_INITIAL_PASSWORD || 'superoot';
let pass = 0;
let fail = 0;
let skipped = false;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch (_) {
    /* sin cuerpo */
  }
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) {
    console.log(`  OK   ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
    failures.push(name);
    fail++;
  }
}

(async () => {
  let token = null;

  try {
    console.log('-- 1. Login --');
    const login = await req('POST', '/auth-mt/login', {
      tenant_slug: 'mega_dulces',
      username: 'superoot',
      password: SUPEROOT_PASS,
    });
    token = login.body?.access_token;
    check('JWT recibido', !!token, login.status);
    if (!token) process.exit(1);

    // -- 2. Un vale del ERP cuyos renglones sí existan en el catálogo -------
    console.log('\n-- 2. Vale del ERP con renglones mapeables --');
    // Se busca un vale REAL del espejo (no un folio inventado): la búsqueda acepta
    // dígitos parciales, así que gana el primer dígito que devuelva coincidencias.
    let candidatos = [];
    let searchStatus = null;
    for (const d of ['9', '0', '1', '2', '3', '4', '5', '6', '7', '8']) {
      const r = await req('GET', `/commercial/receiving/sessions/erp-search?folio=${d}`, null, token);
      searchStatus = r.status;
      if (r.status !== 200) break; // un 500 es FALLA, no "entorno sin feed"
      if ((r.body || []).length) { candidatos = r.body; break; }
    }
    check('la búsqueda por folio responde 200', searchStatus === 200, searchStatus);
    if (!candidatos.length) {
      console.log('  SKIP  el espejo analytics.erp_goods_receipts está vacío (entorno sin feed del ERP)');
      skipped = true;
      throw new Error('__skip__');
    }
    check('erp-search devuelve vales del espejo', candidatos.length > 0, candidatos.length);

    // Se necesita uno cuyos SKUs SÍ estén en el catálogo: si no, esa mercancía no
    // puede entrar a inventario — y el sistema lo dice en progress.sin_catalogo.
    let ses = null;
    let elegido = null;
    let ultimoOpen = null;
    for (const c of candidatos) {
      const src = `${c.sucursal}/${c.folio}`;
      const abre = await req(
        'POST',
        '/commercial/receiving/sessions',
        { source_kind: 'erp_receipt', erp_sucursal: c.sucursal, erp_folio: c.folio, force: true },
        token,
      );
      if (abre.status !== 201 && abre.status !== 200) {
        ultimoOpen = { src, status: abre.status, msg: abre.body?.message };
        continue;
      }
      const det = await req('GET', `/commercial/receiving/sessions/${abre.body.id}`, null, token);
      const conProducto = (det.body?.lines || []).filter((l) => l.product_id);
      if (conProducto.length) {
        ses = det.body;
        elegido = src;
        break;
      }
      await req('POST', `/commercial/receiving/sessions/${abre.body.id}/cancel`, {}, token);
    }
    if (!ses) {
      if (ultimoOpen)
        console.log(`  último intento de abrir: ${ultimoOpen.src} → ${ultimoOpen.status} ${ultimoOpen.msg || ''}`);
      console.log('  SKIP  ningún vale del ERP tiene SKUs presentes en el catálogo local');
      skipped = true;
      throw new Error('__skip__');
    }
    console.log(`  vale ${ses.folio} <- ERP ${elegido} · almacén ${ses.warehouse_id}`);
    check('el vale trajo renglones con producto del catálogo', (ses.lines || []).some((l) => l.product_id));

    const linea =
      ses.lines.find((l) => l.product_id && Number(l.expected_qty) > 0) ||
      ses.lines.find((l) => l.product_id);
    const cantidad = Number(linea.expected_qty) > 0 ? Number(linea.expected_qty) : 3;
    const wh = ses.warehouse_id;

    const leerStock = async () => {
      const r = await req(
        'GET',
        `/commercial/inventory/stock?warehouse_id=${wh}&product_id=${linea.product_id}`,
        null,
        token,
      );
      const rows = Array.isArray(r.body) ? r.body : r.body?.data || [];
      const row = rows.find((x) => x.product_id === linea.product_id) || rows[0];
      return Number(row?.quantity || 0);
    };

    const antes = await leerStock();
    console.log(`\n-- 3. Stock antes: ${antes} --`);

    // -- 4. Confirmar cantidad y DAR LUZ VERDE -----------------------------
    console.log('\n-- 4. Confirmar cantidad y dar luz verde --');
    const upd = await req(
      'POST',
      `/commercial/receiving/sessions/${ses.id}/lines/${linea.id}`,
      { received_qty: cantidad },
      token,
    );
    check('cantidad confirmada', upd.status === 200 || upd.status === 201, upd.status);

    // Los demás renglones quedan en 0 recibido: sólo se da de alta lo confirmado.
    const cerrar = await req('POST', `/commercial/receiving/sessions/${ses.id}/close`, {}, token);
    check('la luz verde cierra el vale', cerrar.status === 200 || cerrar.status === 201, {
      status: cerrar.status,
      body: cerrar.body,
    });

    // -- 5. El stock subió EXACTAMENTE lo recibido ------------------------
    console.log('\n-- 5. El inventario refleja lo aprobado --');
    const despues = await leerStock();
    console.log(`  ${antes} -> ${despues} (recibido ${cantidad})`);
    check('el stock subió exactamente lo recibido', despues === antes + cantidad, {
      antes,
      despues,
      cantidad,
    });

    // -- 6. Entró SIN fecha, en el lote 'NA' -----------------------------
    const lotes = await req(
      'GET',
      `/commercial/inventory/stock/${wh}/${linea.product_id}/lots`,
      null,
      token,
    );
    const filas = Array.isArray(lotes.body) ? lotes.body : lotes.body?.data || [];
    const na = filas.find((l) => (l.lot_code || l.lot || '') === 'NA');
    const fechadoAntes = Number(filas.find((l) => (l.lot_code || l.lot) === 'SMOKE-LV')?.quantity || 0);
    check(
      'la mercancía entró al lote NA (sin caducidad inventada)',
      !!na && Number(na.quantity) >= cantidad,
      filas.map((l) => ({ lote: l.lot_code || l.lot, q: l.quantity, vence: l.expiry_date })),
    );

    // -- 7. Aparece en la BANDEJA de Caducidades --------------------------
    console.log('\n-- 7. Bandeja de Caducidades --');
    const bandeja = await req(
      'GET',
      `/commercial/receiving/sessions/pending-expiry?warehouse_id=${wh}`,
      null,
      token,
    );
    check('la bandeja responde', bandeja.status === 200, bandeja.status);
    const pendientes = Array.isArray(bandeja.body) ? bandeja.body : [];
    const mio = pendientes.find((p) => p.line_id === linea.id);
    check('el renglón aprobado aparece esperando fecha', !!mio, { pendientes: pendientes.length });
    if (mio) {
      console.log(`  ${mio.sku} · ${mio.product_name} · falta fecha de ${mio.pending_qty}`);
      check('el faltante es lo recibido sin declarar', mio.pending_qty === cantidad, {
        pending: mio.pending_qty,
        cantidad,
      });
      check('la bandeja dice de qué vale viene', mio.vale_folio === ses.folio, mio.vale_folio);
      check(
        'la bandeja dice cuántos días lleva esperando',
        typeof mio.dias_esperando === 'number' && mio.dias_esperando >= 0,
        mio.dias_esperando,
      );
      check('la bandeja trae el almacén para no preguntarlo', !!mio.warehouse_id, mio.warehouse_id);
    }

    // -- 8. Cerrar dos veces NO duplica existencia -----------------------
    console.log('\n-- 8. Reintento del cierre --');
    const recerrar = await req('POST', `/commercial/receiving/sessions/${ses.id}/close`, {}, token);
    const stockFinal = await leerStock();
    check('un vale ya cerrado no se vuelve a cerrar', recerrar.status >= 400, recerrar.status);
    check('el stock no se duplicó', stockFinal === despues, { despues, stockFinal });

    // -- 9. Poner la fecha lo saca de la bandeja -------------------------
    console.log('\n-- 9. El bodeguero pone la fecha --');
    const cap = await req(
      'POST',
      '/commercial/receiving/evaluate',
      {
        warehouse_id: wh,
        product_id: linea.product_id,
        receiving_line_id: linea.id,
        source_ref: elegido,
        quantity: cantidad,
        confirmed_lot: 'SMOKE-LV',
        confirmed_expiry: '2027-12-31',
      },
      token,
    );
    check('la captura de fecha se acepta con el renglón ya recibido', cap.status === 200 || cap.status === 201, {
      status: cap.status,
      body: cap.body,
    });

    const bandeja2 = await req(
      'GET',
      `/commercial/receiving/sessions/pending-expiry?warehouse_id=${wh}`,
      null,
      token,
    );
    const sigue = (Array.isArray(bandeja2.body) ? bandeja2.body : []).find((p) => p.line_id === linea.id);
    check('el renglón con fecha ya no pide fecha', !sigue, sigue ? { pending: sigue.pending_qty } : undefined);

    const stockTrasFecha = await leerStock();
    check('poner la fecha NO cambia el total del inventario', stockTrasFecha === despues, {
      antes: despues,
      despues: stockTrasFecha,
    });

    // La reclasificación tiene que verse en los lotes: aparece el fechado y NA baja.
    const lotes2 = await req(
      'GET',
      `/commercial/inventory/stock/${wh}/${linea.product_id}/lots`,
      null,
      token,
    );
    const filas2 = Array.isArray(lotes2.body) ? lotes2.body : lotes2.body?.data || [];
    const fechado = filas2.find((l) => (l.lot_code || l.lot) === 'SMOKE-LV');
    const na2 = filas2.find((l) => (l.lot_code || l.lot) === 'NA');
    check('el lote fechado subió la cantidad declarada',
      !!fechado && Number(fechado.quantity) === fechadoAntes + cantidad,
      filas2.map((l) => ({ lote: l.lot_code || l.lot, q: l.quantity, vence: l.expiry_date })));
    check('el lote sin fecha bajó exactamente lo declarado',
      Number(na2?.quantity || 0) === Number(na?.quantity || 0) - cantidad,
      { na_antes: Number(na?.quantity || 0), na_despues: Number(na2?.quantity || 0) });
    check('la suma de lotes sigue igual al total',
      filas2.reduce((a, l) => a + Number(l.quantity), 0) === stockTrasFecha,
      { suma: filas2.reduce((a, l) => a + Number(l.quantity), 0), total: stockTrasFecha });
  } catch (e) {
    if (e.message !== '__skip__') {
      console.log(`\n  ERROR ${e.message}`);
      fail++;
      failures.push(e.message);
    }
  }

  console.log(`\n${'='.repeat(58)}`);
  if (skipped && fail === 0) {
    console.log('SKIP — entorno sin espejo del ERP o sin catálogo mapeado');
    process.exit(0);
  }
  console.log(`${pass}/${pass + fail} OK`);
  if (fail) {
    console.log('Fallas:');
    failures.forEach((f) => console.log(`  · ${f}`));
  }
  process.exit(fail ? 1 : 0);
})();
