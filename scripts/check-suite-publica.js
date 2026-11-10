#!/usr/bin/env node
'use strict';
/**
 * `[RES.6]` — **La suite se abre de verdad, por el camino que usa la gente.**
 *
 * ── Por qué existe, medido el 2026-11-10 ────────────────────────────────────────────────────
 * Yurécuaro y 8 Esquinas abrieron la suite en blanco durante horas. Producción estaba sana:
 * `/api/health` contestaba, los pods corrían, la base respondía. Lo que fallaba era UN archivo:
 * `main-*.js` daba 404 a esas sucursales y 200 desde la oficina.
 *
 * La causa no fue un error de nadie. Producción corre en DOS copias y un despliegue las cambia
 * de a una, así que durante un minuto conviven las dos versiones detrás de la misma puerta. En
 * esa ventana, un navegador recibió el `index.html` NUEVO (que nunca se cachea, siempre es
 * fresco) y pidió el archivo nuevo a la copia VIEJA, que todavía no lo tenía: 404. Cloudflare
 * guardó ese 404 —los archivos se declaran `immutable, max-age=1 año` porque llevan su huella en
 * el nombre— y lo siguió repartiendo. La oficina no se enteró porque no pasa por Cloudflare.
 *
 * ⭐ **Lo que ninguna compuerta vio: `/api/health` estaba VERDE todo el tiempo.** Mide que la API
 * conteste, no que la aplicación se pueda abrir. Son preguntas distintas y nadie hacía la segunda.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 * Pide el `index.html` por el MISMO origen que usa la gente, lee qué archivos declara, abre el
 * bundle principal, saca los trozos que importa, y comprueba que TODOS contesten 200. Medido el
 * día que se escribió: 3 archivos directos + 324 trozos = 327 por origen.
 *
 * ⛔ Lo que NO prueba:
 *   · Que la app monte (eso es JavaScript corriendo; acá sólo se comprueba que los bytes llegan).
 *   · Lo que ve OTRO nodo de la CDN. Cloudflare cachea por nodo: esto mide el que atiende a quien
 *     lo corre. Un 404 guardado en el nodo de Michoacán es INVISIBLE desde la oficina — que es
 *     exactamente por qué el incidente duró. Si una sucursal reporta pantalla en blanco y esto da
 *     verde, NO alcanza: hay que correrlo desde allá o mirar la consola del navegador.
 *   · Los trozos que se cargan tarde y no están nombrados en el bundle principal.
 *
 * Uso:
 *   node scripts/check-suite-publica.js                 # los dos orígenes
 *   node scripts/check-suite-publica.js <url>           # uno solo
 *   node scripts/check-suite-publica.js --self-test     # prueba negativa
 */

const https = require('node:https');

const ORIGENES = ['https://megadulcessuite.com', 'https://interno.megadulcessuite.com'];
const LOTE = 12;
const TIMEOUT = 20000;

/** Pide una URL y devuelve `{ code, body }`. `code: 0` = no se pudo ni preguntar. */
function pedirReal(url, metodo = 'GET') {
  return new Promise((ok) => {
    const req = https.request(url, { method: metodo, timeout: TIMEOUT }, (res) => {
      const trozos = [];
      res.on('data', (d) => trozos.push(d));
      res.on('end', () => ok({ code: res.statusCode, body: Buffer.concat(trozos).toString('utf8') }));
    });
    req.on('error', (e) => ok({ code: 0, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); ok({ code: 0, body: '', error: 'timeout' }); });
    req.end();
  });
}

/**
 * Recorre un origen. `pedir` se inyecta para que la prueba negativa no toque la red.
 * Devuelve `{ origen, total, fallos: [] }`.
 */
async function revisar(origen, pedir = pedirReal) {
  const idx = await pedir(`${origen}/`);
  if (idx.code !== 200) {
    return { origen, total: 0, fallos: [`el index no carga -> HTTP ${idx.code}${idx.error ? ` (${idx.error})` : ''}`] };
  }

  const directos = [...new Set([...idx.body.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]))];
  if (directos.length === 0) {
    // Un index que no declara un solo archivo no es "cero fallos": es un index que no sirve.
    return { origen, total: 0, fallos: ['el index no declara ningún archivo: o no es el index de la app, o vino vacío'] };
  }

  let universo = [...directos];
  const principal = directos.find((f) => /^main-/.test(f));
  if (principal) {
    const m = await pedir(`${origen}/${principal}`);
    if (m.code !== 200) return { origen, total: directos.length, fallos: [`${principal} -> HTTP ${m.code}`] };
    universo = universo.concat([...new Set(m.body.match(/chunk-[A-Za-z0-9_-]+\.js/g) || [])]);
  }

  const fallos = [];
  for (let i = 0; i < universo.length; i += LOTE) {
    const res = await Promise.all(
      universo.slice(i, i + LOTE).map((f) => pedir(`${origen}/${f}`, 'HEAD').then((r) => ({ f, r }))),
    );
    for (const { f, r } of res) if (r.code !== 200) fallos.push(`${f} -> HTTP ${r.code}${r.error ? ` (${r.error})` : ''}`);
  }
  return { origen, total: universo.length, fallos };
}

/** ⛔ Prueba negativa: sin esto, «0 fallos» puede significar «no miró nada». */
async function autoPrueba() {
  const INDEX = '<html><script src="main-ABC.js" type="module"></script><link href="styles-X.css"></html>';
  const MAIN = 'import"./chunk-UNO.js";import"./chunk-DOS.js";';
  const base = (faltante) => async (url) => {
    if (url.endsWith('/')) return { code: 200, body: INDEX };
    if (url.includes(faltante)) return { code: 404, body: '' };
    if (url.includes('main-ABC.js')) return { code: 200, body: MAIN };
    return { code: 200, body: '' };
  };

  const casos = [
    ['todo carga -> VERDE', async (u) => (u.endsWith('/') ? { code: 200, body: INDEX } : u.includes('main-ABC.js') ? { code: 200, body: MAIN } : { code: 200, body: '' }), 0],
    ['falta el bundle principal -> ROJO', base('main-ABC.js'), 1],
    ['falta UN trozo de 2 -> ROJO', base('chunk-DOS.js'), 1],
    ['falta la hoja de estilos -> ROJO', base('styles-X.css'), 1],
    ['el index no carga -> ROJO', async () => ({ code: 503, body: '' }), 1],
    ['el index viene vacío -> ROJO', async (u) => (u.endsWith('/') ? { code: 200, body: '<html></html>' } : { code: 200, body: '' }), 1],
  ];

  let mal = 0;
  for (const [nombre, pedir, esperado] of casos) {
    const r = await revisar('https://ejemplo', pedir);
    const rojo = r.fallos.length > 0 ? 1 : 0;
    const ok = rojo === esperado;
    if (!ok) mal++;
    console.log(`  ${ok ? '✅' : '❌'} ${nombre}${ok ? '' : `  (dio ${rojo ? 'rojo' : 'verde'})`}`);
  }
  if (mal) { console.error(`\n⛔ ${mal} caso(s) de la prueba negativa fallaron.`); process.exit(1); }
  console.log(`\n✅ ${casos.length} casos: la compuerta se pone roja exactamente donde debe.`);
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return autoPrueba();

  const origenes = args.filter((a) => a.startsWith('http'));
  const lista = origenes.length ? origenes : ORIGENES;
  let rojo = false;

  for (const o of lista) {
    const r = await revisar(o);
    if (r.fallos.length === 0) {
      console.log(`✅ ${r.origen} — ${r.total} archivo(s), todos cargan`);
    } else {
      rojo = true;
      console.error(`⛔ ${r.origen} — ${r.fallos.length} de ${r.total} NO cargan:`);
      r.fallos.slice(0, 15).forEach((f) => console.error(`     ${f}`));
      if (r.fallos.length > 15) console.error(`     … y ${r.fallos.length - 15} más`);
    }
  }

  if (rojo) {
    console.error('\n⛔ La suite NO se puede abrir entera por ese origen.');
    console.error('   Si es el camino público, lo más probable es un 404 guardado en la CDN tras un despliegue:');
    console.error('   purgá la caché de Cloudflare (Caching → Configuration → Purge Everything) y volvé a correr esto.');
    console.error('   ⚠️ Esto mide el nodo de la CDN que te atiende a VOS. Otra plaza puede estar rota igual.');
    process.exit(1);
  }
  console.log('\n✅ La suite se puede abrir entera por todos los orígenes revisados.');
})();
