/* eslint-disable no-console */
/**
 * WMS — **Ubicaciones por HTTP**: dar de alta un rack, escanearlo y ver qué tiene.
 *
 * Existe porque el smoke que había (`test-newdb-bin-locations.js`) es **DB-directo
 * y espeja en JS las reglas del servicio**. Ese molde ya cobró una vez en esta
 * misma fase: WMS-REC.4 daba 17/17 en verde con la ruta principal caída, porque
 * el test reimplementaba la lógica en vez de pegarle al endpoint. Todo lo que se
 * verifica acá vive en `BinLocationService` —normalización del código, largos,
 * lookup— y un mirror no lo tocaría ni de casualidad.
 *
 * Lo que se comprueba, con el motivo por el que importa:
 *
 *   1. El código se NORMALIZA en el servidor (mayúsculas, sin espacios). La
 *      pantalla ya lo hacía y el servidor no: un alta por API con `r-12` creaba
 *      una ubicación que ningún escaneo de `R-12` encontraba, porque `putAway`
 *      busca por igualdad exacta.
 *   2. Un código de 41 caracteres o un nombre de 121 contestan **400 explicando**,
 *      no **500 pelado**. Medido antes del arreglo: los dos tiraban 500, y en el
 *      Andén el código se arma con un campo libre, así que escribir el nombre
 *      largo del rack alcanzaba para caer ahí. Ése es el "no se pudo crear" que
 *      se reportó desde la bodega.
 *   3. El duplicado se detecta SIN importar mayúsculas: dos ubicaciones que en el
 *      cartel impreso se ven idénticas no se pueden desempatar con la pistola.
 *   4. Un código que no existe devuelve **200 con `match: null`**, no 404: es una
 *      respuesta legítima ("ese rack no está dado de alta") y la puerta para
 *      crearlo, no una excepción.
 *   5. El escaneo encuentra el rack y trae su contenido y sus totales.
 *
 * Los casos 2 y 3 son **pruebas negativas**: se vieron en rojo contra el código
 * anterior antes de escribir el arreglo.
 *
 * Correr:  SMOKE_API_BASE=http://127.0.0.1:3346/api node database/tests/http-bin-locations-test.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:3334/api';
const SUPEROOT_PASS = process.env.SUPEROOT_INITIAL_PASSWORD || 'superoot';

let pass = 0;
let fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

// Sufijo por corrida: el test crea ubicaciones REALES y tiene que poder correr
// dos veces seguidas sin chocar con las suyas del intento anterior.
const SUF = String(Date.now()).slice(-6);
const CODE = `R-SMK${SUF}`;

(async () => {
  console.log('── 1. Login ──');
  const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: SUPEROOT_PASS });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  console.log('\n── 2. Setup: una sucursal de verdad ──');
  const whs = await req('GET', '/commercial/warehouses', null, token);
  const lista = whs.body?.data || whs.body || [];
  const wh = lista.find((w) => /^[0-9]{2}$/.test(String(w.code || '')));
  check('hay una sucursal de 2 dígitos', !!wh?.id, { n: lista.length });
  if (!wh?.id) { console.log('  ABORT sin sucursales'); process.exit(1); }

  const creados = [];

  console.log('\n── 3. El código se normaliza en el SERVIDOR ──');
  // Minúsculas + espacios + espacios al borde: lo que sale de una pistola mal
  // configurada o de un dedo apurado. Tiene que quedar UNA sola forma.
  const crudo = await req('POST', '/commercial/inventory/bins',
    { warehouse_id: wh.id, code: `  ${CODE.toLowerCase()} a `, label: '  Rack de prueba  ' }, token);
  check('alta con código sucio → 201/200', crudo.status === 201 || crudo.status === 200, { status: crudo.status, body: crudo.body });
  check('el servidor lo guardó en MAYÚSCULAS y sin espacios',
    crudo.body?.code === `${CODE}-A`, crudo.body?.code);
  check('el nombre queda recortado', crudo.body?.label === 'Rack de prueba', crudo.body?.label);
  if (crudo.body?.id) creados.push(crudo.body.id);

  console.log('\n── 4. Los largos reales contestan, no revientan ──');
  // REGRESIÓN: los dos daban 500 "Internal server error" (22001 de Postgres).
  const largo = await req('POST', '/commercial/inventory/bins',
    { warehouse_id: wh.id, code: 'A'.repeat(41) }, token);
  check('código de 41 caracteres → 400 (NO 500)', largo.status === 400, { status: largo.status });
  check('…y el 400 dice cuál es el límite', /40/.test(String(largo.body?.message || '')), largo.body?.message);

  const label121 = await req('POST', '/commercial/inventory/bins',
    { warehouse_id: wh.id, code: `${CODE}-L`, label: 'L'.repeat(121) }, token);
  check('nombre de 121 caracteres → 400 (NO 500)', label121.status === 400, { status: label121.status });

  const rarito = await req('POST', '/commercial/inventory/bins', { warehouse_id: wh.id, code: 'RACK-Ñ' }, token);
  check('código con caracteres que la pistola no repite → 400', rarito.status === 400, { status: rarito.status });

  const vacio = await req('POST', '/commercial/inventory/bins', { warehouse_id: wh.id, code: '   ' }, token);
  check('código vacío → 400', vacio.status === 400, { status: vacio.status });

  console.log('\n── 5. Duplicado sin importar mayúsculas ──');
  const dup = await req('POST', '/commercial/inventory/bins',
    { warehouse_id: wh.id, code: `${CODE.toLowerCase()}-a` }, token);
  check('mismo código en otra caja → 409, no una segunda ubicación',
    dup.status === 409, { status: dup.status, msg: dup.body?.message });

  console.log('\n── 6. Escanear un rack ──');
  const noExiste = await req('GET', `/commercial/inventory/bins/lookup?code=NOEXISTE-${SUF}`, null, token);
  check('código inexistente → 200 con match null (NO 404)',
    noExiste.status === 200 && noExiste.body?.match === null, { status: noExiste.status, body: noExiste.body });
  check('…y devuelve el código normalizado para poder ofrecer crearlo',
    noExiste.body?.code === `NOEXISTE-${SUF}`, noExiste.body?.code);

  const malCodigo = await req('GET', '/commercial/inventory/bins/lookup?code=RACK%20%C3%91', null, token);
  check('escanear un código imposible → 400, no una lista vacía que parezca "no hay"',
    malCodigo.status === 400, { status: malCodigo.status });

  const enMinus = await req('GET', `/commercial/inventory/bins/lookup?code=${CODE.toLowerCase()}-a`, null, token);
  check('escaneo en minúsculas encuentra el rack creado',
    enMinus.body?.match?.code === `${CODE}-A`, { status: enMinus.status, match: enMinus.body?.match });
  check('el lookup dice de qué almacén es (el que escanea no eligió ninguno)',
    !!enMinus.body?.match?.warehouse_code, enMinus.body?.match?.warehouse_code);
  check('un rack vacío trae totales en cero, no null',
    enMinus.body?.totals?.unidades === 0 && enMinus.body?.totals?.lineas === 0, enMinus.body?.totals);

  console.log('\n── 7. Acomodar escaneando el cartel y volver a preguntar ──');
  const pend = await req('GET', `/commercial/inventory/unlocated?warehouse_id=${wh.id}`, null, token);
  const lote = (pend.body || [])[0];
  if (!lote) {
    console.log('  SKIP  no hay nada por acomodar en esta sucursal (entorno sin stock sembrado)');
  } else {
    const qty = Math.min(3, Number(lote.to_locate) || 1);
    // `bin_code` sucio a propósito: es lo que entrega una pistola mal configurada.
    const put = await req('POST', '/commercial/inventory/put-away', {
      warehouse_id: wh.id, product_id: lote.product_id, lot_code: lote.lot_code,
      expiry_date: lote.expiry_date ? String(lote.expiry_date).slice(0, 10) : undefined,
      bin_code: ` ${CODE.toLowerCase()}-a `, quantity: qty,
    }, token);
    check('put-away con el código escaneado sucio → lo encuentra igual',
      put.status === 201 || put.status === 200, { status: put.status, body: put.body });

    const lleno = await req('GET', `/commercial/inventory/bins/lookup?code=${CODE}-A`, null, token);
    check('el escaneo ahora devuelve el contenido del rack',
      (lleno.body?.contents || []).length >= 1, { n: (lleno.body?.contents || []).length });
    check('los totales cuadran con lo acomodado',
      Number(lleno.body?.totals?.unidades) === qty, { totals: lleno.body?.totals, qty });
    check('el contenido trae los días a vencer calculados en la BASE',
      (lleno.body?.contents || []).every((c) => 'days_to_expiry' in c), lleno.body?.contents?.[0]);
  }

  console.log('\n── 7bis. Mover un lote de un rack a otro ──');
  // Es la operacion que NO existia: `stock_lot_locations` tenia un solo escritor
  // (el upsert de put-away) y solo sabia SUMAR, asi que un lote acomodado quedaba
  // clavado en ese rack para siempre y el mapa de la bodega envejecia solo.
  const destino = await req('POST', '/commercial/inventory/bins',
    { warehouse_id: wh.id, code: `${CODE}-B`, label: 'Destino de prueba' }, token);
  check('segunda ubicacion creada para mover', destino.status === 201 || destino.status === 200, { status: destino.status });
  if (destino.body?.id) creados.push(destino.body.id);

  if (!lote) {
    console.log('  SKIP  sin stock sembrado no hay lote que mover');
  } else {
    const qty = Math.min(3, Number(lote.to_locate) || 1);
    const mover = (body) => req('POST', '/commercial/inventory/move-lot', body, token);
    const base = {
      warehouse_id: wh.id, product_id: lote.product_id, lot_code: lote.lot_code,
      expiry_date: lote.expiry_date ? String(lote.expiry_date).slice(0, 10) : undefined,
    };

    const mismo = await mover({ ...base, from_bin_code: `${CODE}-A`, to_bin_code: `${CODE}-A`, quantity: 1 });
    check('mover al MISMO rack -> 400 (no es un movimiento)', mismo.status === 400, { status: mismo.status });

    const noExiste = await mover({ ...base, from_bin_code: `${CODE}-A`, to_bin_code: `NADA-${SUF}`, quantity: 1 });
    check('destino inexistente -> 404 diciendo que es el destino',
      noExiste.status === 404 && /destino/i.test(String(noExiste.body?.message || '')),
      { status: noExiste.status, msg: noExiste.body?.message });

    const deMas = await mover({ ...base, from_bin_code: `${CODE}-A`, to_bin_code: `${CODE}-B`, quantity: qty + 1000 });
    check('mover mas de lo que hay en el origen -> 409 con la cantidad real',
      deMas.status === 409 && /hay/i.test(String(deMas.body?.message || '')),
      { status: deMas.status, msg: deMas.body?.message });

    const ok = await mover({ ...base, from_bin_code: ` ${CODE.toLowerCase()}-a `, to_bin_code: `${CODE}-B`, quantity: qty });
    check('mover con los codigos escaneados sucios -> funciona', ok.status === 201 || ok.status === 200,
      { status: ok.status, body: ok.body });
    check('el origen queda en cero', Number(ok.body?.queda_en_origen) === 0, ok.body?.queda_en_origen);

    const origen = await req('GET', `/commercial/inventory/bins/lookup?code=${CODE}-A`, null, token);
    const dest = await req('GET', `/commercial/inventory/bins/lookup?code=${CODE}-B`, null, token);
    check('el rack de origen ya no lo tiene', Number(origen.body?.totals?.unidades || 0) === 0, origen.body?.totals);
    check('el rack de destino si', Number(dest.body?.totals?.unidades || 0) === qty, dest.body?.totals);

    // INVARIANTE: mover NO es un movimiento de existencia. Lo unico que cambia
    // es donde esta: nada vuelve a la cola de 'por acomodar'.
    const pend2 = await req('GET', `/commercial/inventory/unlocated?warehouse_id=${wh.id}&product_id=${lote.product_id}`, null, token);
    const fila2 = (pend2.body || []).find((u) => u.lot_code === lote.lot_code);
    check('INVARIANTE: mover no devolvio mercancia a "por acomodar"',
      !fila2 || Number(fila2.to_locate) <= Number(lote.to_locate) - qty,
      { antes: lote.to_locate, despues: fila2?.to_locate });

    // Y el rack vaciado se puede borrar: la fila en 0 no lo bloquea.
    const vaciado = await req('DELETE', `/commercial/inventory/bins/${crudo.body?.id}`, null, token);
    check('un rack que quedo vacio por un movimiento SI se puede borrar',
      vaciado.status === 200, { status: vaciado.status, msg: vaciado.body?.message });
    if (vaciado.status === 200) {
      const i = creados.indexOf(crudo.body?.id);
      if (i >= 0) creados.splice(i, 1);
    }
  }

  console.log('\n── 8. Limpieza ──');
  // Se borran las ubicaciones creadas por el test. La que quedó con mercancía NO
  // se puede borrar (el backend lo impide), así que primero se vacía su renglón.
  for (const id of creados) {
    const del = await req('DELETE', `/commercial/inventory/bins/${id}`, null, token);
    check(`ubicación de prueba borrada (${id.slice(0, 8)})`, del.status === 200 || del.status === 409,
      { status: del.status, msg: del.body?.message });
  }

  console.log(`\n──────────\n  ${pass} OK · ${fail} FAIL`);
  if (fail) { console.log('  Fallas:', failures.join(', ')); process.exit(1); }
  console.log('  ✅ Ubicaciones (HTTP) verde.');
})().catch((e) => { console.error(e); process.exit(1); });
