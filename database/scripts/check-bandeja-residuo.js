/* eslint-disable no-console */
/**
 * ⭐⭐ `[CGA-A.20]` — **Qué quedó en la bandeja que nadie recogió.**
 *
 *   node database/scripts/check-bandeja-residuo.js
 *   node database/scripts/check-bandeja-residuo.js --self-test
 *
 * Lee el runner (`kepler_consolidado`). No escribe nada. **Exit 1** cuando hay filas en
 * `ingest.route_collections_stg` más viejas que la ventana: eso es efectivo que la camioneta
 * ya entregó y que el merge nunca consumió.
 *
 * ── Por qué existe, medido el 2026-10-19 — `GOTCHAS` §87 ───────────────────────────────────
 *
 * La ruta 27 cerró su día, imprimió su ticket (`UA0501-0000017`, **$19,939.00**) y la venta no
 * aparecía en la suite. El dato **sí** había llegado al runner: 27 filas en `stg`, fecha 19-oct,
 * **27 de 27 válidas** para los filtros del merge. Lo que no pasó es el merge.
 *
 * ⛔ **Y los dos latidos que ya existen decían que todo estaba bien**, porque los dos están del
 * MISMO lado del corte:
 *
 *     route_push_heartbeat         ← lo escribe el .cmd al subir       ✔ verde
 *     [ aquí quedó el dato ]       ← la bandeja, que nadie mira
 *     route_collections_heartbeat  ← lo escribe el merge al correr     ✔ verde (del intento ANTERIOR)
 *
 * `check-camioneta-sin-cobro.js` cruza esos dos y por eso dio sana a la unidad: **no falló por un
 * umbral, falló porque sus dos testigos están del mismo lado del tramo que se rompió.**
 *
 * ⭐ **La regla, que es la de §87:** un latido mide el proceso que lo ESCRIBE, nunca el que lo
 * alimenta. Lo único que prueba entrega en un carril por bandeja es **la bandeja vacía** — y eso
 * no se puede preguntar a ningún latido, hay que ir a mirar la bandeja.
 *
 * ⚠️ Lo que este detector NO contesta: si el importe es correcto (eso es
 * `check-cobro-monto-desfasado.js`), ni si la unidad empujó (eso es
 * `check-camioneta-sin-cobro.js`). Acá se mide UNA cosa: **lo que quedó sin consumir**.
 */
'use strict';
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const SELF = process.argv.includes('--self-test');

/**
 * ⚠️ La bandeja está llena de forma LEGÍTIMA entre el `\copy` y el `merge`, que en el `.cmd` van
 * seguidos: segundos. Veinte minutos es dos corridas del cron de prod (cada 10) y varios órdenes
 * de magnitud por encima de la ventana normal — por debajo de eso se marcaría ruido.
 */
const RESIDUO_MIN = 20;

const mins = (t) => (t ? (Date.now() - new Date(t).getTime()) / 6e4 : null);
const edad = (m) => (m == null ? '—' : m < 60 ? `${Math.round(m)} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m / 1440)} d`);
const money = (v) => (v == null ? '—' : '$' + Number(v).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pad = (s, n) => String(s ?? '').padEnd(n);

/**
 * ⭐ El clasificador es PURO para que la prueba negativa lo pueda romper sin tocar la base.
 * Devuelve `null` cuando la fila no es un problema.
 */
function veredicto(fila, umbralMin = RESIDUO_MIN) {
  const edadMin = mins(fila.mas_viejo);
  if (edadMin == null || edadMin < umbralMin) return null;
  // ⛔ El caso grave: la bandeja tiene residuo Y el latido del consumidor está VERDE. Eso es
  // exactamente la mentira de §87 — y es peor que un latido rojo, porque nadie va a mirar.
  const latidoMin = mins(fila.merge_last_ok);
  const latidoFresco = latidoMin != null && latidoMin < edadMin;
  return latidoFresco ? 'residuo_con_latido_verde' : 'residuo';
}

const SQL = `
  SELECT s.truck,
         count(*)::int                AS filas,
         sum(s.importe)               AS importe,
         min(s._loaded_at)            AS mas_viejo,
         max(s.fecha)::date           AS fecha_max,
         h.last_ok                    AS merge_last_ok,
         h.rows_last                  AS merge_filas
    FROM ingest.route_collections_stg s
    LEFT JOIN ingest.route_collections_heartbeat h ON h.truck = s.truck
   GROUP BY s.truck, h.last_ok, h.rows_last
   ORDER BY min(s._loaded_at)`;

async function main(c) {
  const { rows } = await c.query(SQL);

  console.log(`\n=== Bandeja de cobros de ruta: lo que quedó sin consumir  [CGA-A.20] ===`);
  console.log(`    umbral: ${RESIDUO_MIN} min  ·  fuente: ingest.route_collections_stg (runner)\n`);

  if (rows.length === 0) {
    console.log('  ✓ La bandeja está vacía. Eso es lo único que prueba que el merge corrió.\n');
    return 0;
  }

  const malas = [];
  console.log(`  ${pad('camioneta', 11)}${pad('filas', 7)}${pad('importe', 16)}${pad('en la bandeja', 15)}${pad('latido del merge', 18)}veredicto`);
  console.log(`  ${'-'.repeat(86)}`);
  for (const r of rows) {
    const v = veredicto(r);
    const linea = `  ${pad(r.truck, 11)}${pad(r.filas, 7)}${pad(money(r.importe), 16)}`
      + `${pad(edad(mins(r.mas_viejo)), 15)}${pad(edad(mins(r.merge_last_ok)), 18)}`
      + (v === 'residuo_con_latido_verde' ? '⛔ ATASCADO, y el latido dice ok'
        : v === 'residuo' ? '⛔ atascado'
          : '· en tránsito (normal)');
    console.log(linea);
    if (v) malas.push({ ...r, v });
  }

  if (!malas.length) {
    console.log(`\n  ✓ Todo lo que hay en la bandeja entró hace menos de ${RESIDUO_MIN} min: está en tránsito.\n`);
    return 0;
  }

  const total = malas.reduce((a, r) => a + Number(r.importe || 0), 0);
  console.log(`\n  ⛔ ${malas.length} camioneta(s) con efectivo atascado · ${money(total)}`);
  console.log('     La camioneta lo entregó y el merge no lo consumió. En la suite NO se ve.');
  for (const m of malas) {
    console.log(`     · ${m.truck}: ${m.filas} fila(s) hasta ${String(m.fecha_max).slice(0, 10)}`
      + (m.v === 'residuo_con_latido_verde'
        ? ` — y route_collections_heartbeat dice "ok" de hace ${edad(mins(m.merge_last_ok))} (§87)` : ''));
  }
  console.log(`\n     Destrabar:  SELECT ingest.merge_route_collections('<camioneta>');\n`);
  return 1;
}

/**
 * ⛔ Prueba negativa: un detector sin ella es una intención. Se rompe el umbral a propósito
 * —`0 min`, que es el error de «cualquier cosa en la bandeja está mal»— y se verifica que el
 * clasificador cambia de opinión sobre filas que acaban de entrar.
 */
async function selfTest() {
  const ahora = new Date();
  const haceMin = (m) => new Date(ahora.getTime() - m * 6e4);
  const casos = [
    { n: 'recién copiada (en tránsito)', f: { truck: 'r1', mas_viejo: haceMin(1), merge_last_ok: haceMin(300) }, esperado: null },
    { n: 'atascada 3 h, latido viejo', f: { truck: 'r2', mas_viejo: haceMin(180), merge_last_ok: haceMin(400) }, esperado: 'residuo' },
    { n: 'atascada 3 h, latido VERDE', f: { truck: 'r3', mas_viejo: haceMin(180), merge_last_ok: haceMin(20) }, esperado: 'residuo_con_latido_verde' },
    { n: 'atascada, sin latido nunca', f: { truck: 'r4', mas_viejo: haceMin(180), merge_last_ok: null }, esperado: 'residuo' },
    { n: 'bandeja sin fecha de carga', f: { truck: 'r5', mas_viejo: null, merge_last_ok: haceMin(10) }, esperado: null },
  ];

  console.log('\n=== self-test  [CGA-A.20] ===\n');
  let fallos = 0;
  for (const cso of casos) {
    const got = veredicto(cso.f);
    const ok = got === cso.esperado;
    if (!ok) fallos++;
    console.log(`  ${ok ? '✓' : '✗'} ${pad(cso.n, 34)} → ${got ?? 'null'}  (esperado ${cso.esperado ?? 'null'})`);
  }

  // ── La rotura a propósito: con umbral 0, lo que está en tránsito pasa a contarse. Si el
  //    detector NO cambia de opinión, es que el umbral no se está usando y la compuerta es decorativa.
  const enTransito = casos[0].f;
  const conUmbralNormal = veredicto(enTransito);
  const conUmbralRoto = veredicto(enTransito, 0);
  console.log('\n  ── prueba negativa: se baja el umbral a 0 min ──');
  console.log(`     en tránsito con umbral ${RESIDUO_MIN}: ${conUmbralNormal ?? 'null'}  ·  con umbral 0: ${conUmbralRoto ?? 'null'}`);
  if (conUmbralNormal !== null || conUmbralRoto === null) {
    console.log('     ✗ el umbral NO distingue: la compuerta no mide lo que dice medir');
    fallos++;
  } else {
    console.log('     ✓ distingue: el umbral es lo que separa «en tránsito» de «atascado»');
  }

  console.log('');
  if (fallos) { console.log(`  ✗ ${fallos} fallo(s)\n`); return 1; }
  console.log('  ✓ los 5 casos y la prueba negativa\n');
  return 0;
}

(async () => {
  if (SELF) process.exit(await selfTest());
  const url = process.env.DATABASE_URL_KEPLER_CONSOLIDADO;
  if (!url) { console.error('⛔ falta DATABASE_URL_KEPLER_CONSOLIDADO en el .env'); process.exit(1); }
  const c = new Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 10000 });
  await c.connect();
  let code = 0;
  try {
    await c.query(`SET default_transaction_read_only = on`);
    code = await main(c);
  } finally { await c.end(); }
  process.exit(code);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
