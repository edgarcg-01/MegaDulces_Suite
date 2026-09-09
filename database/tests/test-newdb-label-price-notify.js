/* eslint-disable no-console */
'use strict';
/**
 * `[TDA.1]` — El aviso de cambio de precio no puede romper la ingesta.
 *
 * ── Qué se está protegiendo ──────────────────────────────────────────────────
 * El hop-2 recomputa `commercial.product_label_prices` DENTRO del POST del carril del ODS, que
 * corre cada 15 s. Ahí se le colgó un aviso HTTP al API para que la etiquetera se entere en vivo.
 * El riesgo es obvio y hay que medirlo, no prometerlo: si ese aviso lanza, o bloquea, o tarda, el
 * daño no es "no llegó el aviso" — es que se cae el carril que alimenta precio, costo, margen y
 * reorden de toda la plataforma. Cambiar un problema chico por uno grande.
 *
 * Cada afirmación va con su negativa (ADR-056). Las que importan son las tres del bloque 1: el
 * aviso tiene que devolver `false` y NO lanzar en los tres modos de falla reales — sin configurar,
 * con el API caído, y con el API colgado.
 *
 * ── Sin API y sin DB ─────────────────────────────────────────────────────────
 * Carga el módulo REAL de `services/feeds-ingest/` y levanta un server HTTP de nodo en un puerto
 * efímero para actuar de API. No necesita el server del monorepo arriba ni tocar Postgres, así que
 * la cobertura no se cae cuando la suite corre sin infra.
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const RUTA_NOTIFY = path.resolve(__dirname, '../../services/feeds-ingest/notify-store.js');
const RUTA_LABEL = path.resolve(__dirname, '../../services/feeds-ingest/label-compute.js');
const RUTA_APPLY = path.resolve(__dirname, '../../services/feeds-ingest/apply-handlers.js');

let pass = 0, fail = 0;
const fallas = [];
const check = (n, cond, det) => {
  if (cond) { console.log(`  OK   ${n}`); pass++; }
  else { console.log(`  FAIL ${n}${det ? ' — ' + det : ''}`); fail++; fallas.push(n); }
};

/** Recarga el módulo con el entorno que se le pase (lee las env vars al importarse). */
function cargarNotify(env) {
  for (const k of ['STORE_NOTIFY_URL', 'STORE_API_URL', 'STORE_INGEST_KEY', 'STORE_NOTIFY_TIMEOUT_MS', 'STORE_NOTIFY_MAX_IDS']) delete process.env[k];
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve(RUTA_NOTIFY)];
  return require(RUTA_NOTIFY);
}

/** Server de mentira que hace de API. `modo`: 'ok' | 'error' | 'cuelga'. */
function servidor(modo, recibidas) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      recibidas.push({ url: req.url, key: req.headers['x-store-ingest-key'], body: (() => { try { return JSON.parse(body); } catch { return null; } })() });
      if (modo === 'cuelga') return; // nunca contesta: ejercita el timeout
      if (modo === 'error') { res.writeHead(500); res.end('nope'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"emitted":true}');
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

/**
 * Cierra el server Y sus conexiones vivas.
 *
 * `srv.close()` a secas NO corta las conexiones ya abiertas, y el caso 'cuelga' deja una abierta a
 * propósito. Con ella viva, el `process.exit()` del final reventaba con
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` de libuv y el proceso salía con **127**
 * — o sea: 22 aserciones en verde y el runner leyéndolo como falla. Medido, no supuesto.
 */
function cerrar(srv) {
  if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
  srv.close();
}

(async () => {
  console.log('\n── 1. Fail-OPEN: los tres modos de falla NO lanzan ───────────────────');

  // (a) Sin configurar. Es el estado real hasta que se setean las env en Railway, así que este
  //     caso NO es hipotético: es cómo se va a comportar el día del deploy.
  {
    const { notifyLabelPricesChanged } = cargarNotify({});
    let lanzo = false, r = null;
    try { r = await notifyLabelPricesChanged('t', ['a']); } catch { lanzo = true; }
    check('sin configurar: devuelve false y no lanza', !lanzo && r === false);
  }

  // (b) API que responde 500.
  {
    const recibidas = [];
    const srv = await servidor('error', recibidas);
    const { port } = srv.address();
    const { notifyLabelPricesChanged } = cargarNotify({ STORE_NOTIFY_URL: `http://127.0.0.1:${port}`, STORE_INGEST_KEY: 'k' });
    let lanzo = false, r = null;
    try { r = await notifyLabelPricesChanged('t', ['a']); } catch { lanzo = true; }
    check('API con 500: devuelve false y no lanza', !lanzo && r === false);
    cerrar(srv);
  }

  // (c) API colgado. La negativa que de verdad importa: sin timeout, un API que no contesta
  //     bloquearía el hop-2 y con él el carril @15 s.
  {
    const recibidas = [];
    const srv = await servidor('cuelga', recibidas);
    const { port } = srv.address();
    const { notifyLabelPricesChanged } = cargarNotify({ STORE_NOTIFY_URL: `http://127.0.0.1:${port}`, STORE_INGEST_KEY: 'k', STORE_NOTIFY_TIMEOUT_MS: '300' });
    const t0 = Date.now();
    let lanzo = false, r = null;
    try { r = await notifyLabelPricesChanged('t', ['a']); } catch { lanzo = true; }
    const ms = Date.now() - t0;
    check('API colgado: se rinde por timeout, no lanza', !lanzo && r === false);
    check(`y se rinde RÁPIDO (${ms} ms < 2000)`, ms < 2000, `tardó ${ms} ms`);
    cerrar(srv);
  }

  console.log('\n── 2. Cuando el API sí contesta, manda lo correcto ───────────────────');
  {
    const recibidas = [];
    const srv = await servidor('ok', recibidas);
    const { port } = srv.address();
    const { notifyLabelPricesChanged } = cargarNotify({ STORE_NOTIFY_URL: `http://127.0.0.1:${port}/`, STORE_INGEST_KEY: 'secreto' });
    const r = await notifyLabelPricesChanged('tenant-1', ['p1', 'p2', 'p1']);
    check('devuelve true', r === true);
    check('pega en /store/live/label-prices-changed', recibidas[0]?.url === '/store/live/label-prices-changed', recibidas[0]?.url);
    check('manda el header x-store-ingest-key', recibidas[0]?.key === 'secreto');
    check('deduplica los product_ids', JSON.stringify(recibidas[0]?.body?.product_ids) === JSON.stringify(['p1', 'p2']),
      JSON.stringify(recibidas[0]?.body?.product_ids));
    check('sin truncar cuando cabe', recibidas[0]?.body?.truncated === false);

    // Un aviso sin ids no dice nada: no debe salir siquiera.
    recibidas.length = 0;
    const vacio = await notifyLabelPricesChanged('tenant-1', []);
    check('lista vacía: NO manda nada', vacio === false && recibidas.length === 0);

    // Y el recorte se DECLARA en vez de mandar una lista parcial como si fuera completa.
    recibidas.length = 0;
    const { notifyLabelPricesChanged: n2 } = cargarNotify({ STORE_NOTIFY_URL: `http://127.0.0.1:${port}`, STORE_INGEST_KEY: 'k', STORE_NOTIFY_MAX_IDS: '2' });
    await n2('tenant-1', ['a', 'b', 'c', 'd']);
    check('con más ids que el tope: recorta Y avisa truncated',
      recibidas[0]?.body?.truncated === true && recibidas[0]?.body?.product_ids.length === 2 && recibidas[0]?.body?.total === 4,
      JSON.stringify(recibidas[0]?.body));
    cerrar(srv);
  }

  console.log('\n── 3. El contrato de upsertLabels no cambió para los llamadores viejos ─');
  {
    const { upsertLabels } = require(RUTA_LABEL);
    const src = fs.readFileSync(RUTA_LABEL, 'utf8');
    // El importer on-prem `import-label-data.js` corre desde el working tree, así que un cambio de
    // tipo de retorno acá es un cambio en producción al guardar el archivo.
    check('sigue devolviendo un NÚMERO con lista vacía', (await upsertLabels(null, 't', [])) === 0);
    check('el parámetro de salida es OPCIONAL (5º, con default null)',
      /async function upsertLabels\(client, tenantId, tuples, BATCH = 1000, changedOut = null\)/.test(src));
    check('el UPSERT devuelve los product_id que escribió', /RETURNING product_id/.test(src));
    check('sólo empuja al out-param si le pasaron un array', /Array\.isArray\(changedOut\)/.test(src));
    check('y sigue devolviendo rowCount, no el array', /return up\.rowCount;/.test(src));
    check('el guard churn-free sigue puesto (sin él avisaría en cada tick)',
      /IS DISTINCT FROM/.test(src) && /source <> 'manual'/.test(src));
  }

  console.log('\n── 4. El hop-2 avisa DESPUÉS del commit y sin await ──────────────────');
  {
    const src = fs.readFileSync(RUTA_APPLY, 'utf8');
    const fn = /async function normalizeLabelsFromOds\([\s\S]*?\n\}/.exec(src);
    check('se encontró normalizeLabelsFromOds', !!fn);
    if (fn) {
      const cuerpo = fn[0];
      const iCommit = cuerpo.indexOf("client.query('COMMIT')");
      const iAviso = cuerpo.indexOf('notifyLabelPricesChanged');
      check('el aviso va DESPUÉS del COMMIT', iCommit > 0 && iAviso > iCommit, `commit@${iCommit} aviso@${iAviso}`);
      // Sin `await`: el hop-2 corre dentro del POST del carril @15s. Esperar el aviso le sumaría
      // latencia a la ingesta por algo que no es el dato.
      check('el aviso NO se espera con await', !/await notifyLabelPricesChanged/.test(cuerpo));
      check('y su rechazo está atrapado', /notifyLabelPricesChanged\([\s\S]{0,80}\)\.catch\(/.test(cuerpo));
      check('se le pasan los ids REALMENTE cambiados, no los que llegaron',
        /upsertLabels\(client, tenantId, tuples, 1000, cambiados\)/.test(cuerpo));
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} OK · ${fail} FAIL`);
  if (fallas.length) console.log('   Fallaron: ' + fallas.join(' · '));
  // `process.exitCode` y NO `process.exit()`, y esto sí importa: el bloque 1(c) deja un `fetch`
  // ABORTADO por timeout, y matar el proceso mientras undici desarma ese handle revienta libuv en
  // Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) → el proceso salía con
  // **127** con las 22 aserciones en verde, o sea el runner lo leía como falla. Medido.
  // Con el exitCode seteado, el loop drena solo y el código de salida es el correcto.
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.error('\n💥', e.message); process.exitCode = 1; });
