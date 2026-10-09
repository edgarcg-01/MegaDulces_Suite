/* eslint-disable no-console */
/**
 * `[RD.53]` CANDADO: el latido del push de ruta mide **fecha entregada**, no filas entregadas.
 *
 * ── El defecto, medido en vivo el 2026-10-08 ─────────────────────────────────────────────
 *
 *   camioneta    el latido decia                    lo que de verdad habia llegado
 *   ruta_504     4.3 h sin reportar · 5,348 filas   su venta mas nueva era del 2026-10-01
 *   ruta_505     571.6 h sin reportar               2026-09-10
 *
 * Las otras nueve, al dia. O sea que el latido **veia a la 505 y NO veia a la 504** — la que
 * sube todos los dias y entrega otra vez la misma ventana vieja. Costó que la quincena 20 le
 * pagara **$0 en vez de $1,092.46** al chofer de esa ruta.
 *
 * ── Lo que vigila ────────────────────────────────────────────────────────────────────────
 *  1. Las dos fallas se llaman distinto (`no_sube` ≠ `sube_pero_sin_fechas_nuevas`): se
 *     arreglan distinto — una es el carril, la otra es el Kepler de la camioneta.
 *  2. ⭐ MUTACION: un push que reentrega una ventana VIEJA no puede mover `max_fecha` ni la
 *     marca de avance. Si la moviera, el latido volveria a decir "al dia" sobre datos viejos,
 *     que es exactamente el defecto.
 *  3. CONTROL POSITIVO: un push con una fecha NUEVA sí tiene que moverlas. Sin esto, una
 *     funcion que nunca actualizara nada pasaria la prueba 2.
 *  4. `client_ip` sigue ahi: la version nueva de la funcion se copio de la que CORRE, no del
 *     archivo del repo, que estaba viejo y la habria borrado en silencio.
 *
 *   DATABASE_URL_KEPLER_CONSOLIDADO=… node database/tests/test-newdb-route-push-heartbeat.js
 */
const path = require('path');
const { Client } = require('pg');
// ⚠️ Esta prueba NO va contra `postgres_platform` sino contra `kepler_consolidado`, que es
// donde aterriza el push de las camionetas. Su URL no la exporta el runner: se lee del `.env`.
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

// ⚠️ Si falta la URL, esto DECLARA y sale en verde con un NO MEDIDO -- no revienta. Una prueba
// que se cae por el entorno (y no por el codigo que vigila) enseña a ignorar la suite entera,
// que es peor que no tenerla. La ausencia se dice; no se disfraza de falla ni de exito.
const URL = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || null;
if (!URL) {
  console.log('\n=== [RD.53] el latido del push de ruta ===');
  console.log('  ⓘ NO MEDIDO · falta DATABASE_URL_KEPLER_CONSOLIDADO — esta prueba va contra');
  console.log('    `kepler_consolidado` (donde aterriza el push de las camionetas), no contra');
  console.log('    `postgres_platform`. Sin esa URL no hay nada que vigilar.\n');
  process.exit(0);
}

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const db = new Client({ connectionString: URL, statement_timeout: 120000 });
  await db.connect();
  console.log(`\n=== [RD.53] el latido del push de ruta · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  if (!(await db.query(`SELECT to_regclass('ingest.v_route_push_salud') v`)).rows[0].v) {
    noMedido('la vista de salud', 'no existe (falta runner-heartbeat-fecha.sql)');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`); await db.end(); process.exit(fail ? 1 : 0);
  }

  // ── 1. La funcion conserva lo que ya hacia ────────────────────────────────────────────────
  const { rows: [fn] } = await db.query(
    `SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='ingest' AND p.proname='merge_route_sales'`);
  check('la funcion conserva client_ip', /client_ip/.test(fn.d),
    'el archivo del repo estaba viejo: copiarlo habria borrado la columna con la que se identifico la 504');
  check('la funcion captura la fecha entregada', /max\(fecha\)/.test(fn.d));

  // ── 2. Las dos fallas tienen nombre propio ────────────────────────────────────────────────
  const { rows: salud } = await db.query(
    `SELECT truck, veredicto, dias_de_atraso FROM ingest.v_route_push_salud ORDER BY truck`);
  const porVer = salud.reduce((a, r) => { a[r.veredicto] = (a[r.veredicto] || 0) + 1; return a; }, {});
  console.log(`      ${salud.length} camioneta(s): ${Object.entries(porVer).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  check('ninguna camioneta queda sin veredicto', salud.every((r) => !!r.veredicto));
  check('una camioneta atrasada NO se publica como al_dia',
    salud.every((r) => !(r.dias_de_atraso > 1 && r.veredicto === 'al_dia')),
    salud.filter((r) => r.dias_de_atraso > 1 && r.veredicto === 'al_dia').map((r) => r.truck).join(', '));

  // ── 3. MUTACION y CONTROL POSITIVO, con rollback ──────────────────────────────────────────
  const CAMION = '__test_rd53__';
  let puedeEscribir = true;
  try { await db.query('BEGIN'); await db.query('SELECT 1'); await db.query('ROLLBACK'); }
  catch { puedeEscribir = false; }

  const { rows: [ro] } = await db.query('SHOW default_transaction_read_only');
  if (ro.default_transaction_read_only === 'on' || !puedeEscribir) {
    noMedido('mutacion y control positivo',
      'la sesion es de SOLO LECTURA: hay que correrlo con el rol que usa el push');
  } else {
    await db.query('BEGIN');
    try {
      const empujar = async (fecha) => {
        await db.query(
          `INSERT INTO ingest.route_sales_stg
             (truck, almacen, folio, fecha, forma_pago, sku, producto, unidad, cantidad, precio_neto, importe)
           VALUES ($1,'A','F-1',$2::date,'EFECTIVO','SKU','P','PZA',1,1,1)`, [CAMION, fecha]);
        await db.query('SELECT ingest.merge_route_sales($1)', [CAMION]);
        const { rows: [h] } = await db.query(
          `SELECT max_fecha::text mx, max_fecha_avanzo_en av FROM ingest.route_push_heartbeat WHERE truck=$1`,
          [CAMION]);
        return h;
      };

      const h1 = await empujar('2026-06-10');
      check('CONTROL POSITIVO: el primer push fija la fecha y la marca de avance',
        h1.mx === '2026-06-10' && h1.av !== null, JSON.stringify(h1));

      const h2 = await empujar('2026-06-20');
      check('CONTROL POSITIVO: una fecha NUEVA avanza las dos',
        h2.mx === '2026-06-20' && h2.av !== null && +new Date(h2.av) >= +new Date(h1.av),
        JSON.stringify(h2));

      const h3 = await empujar('2026-06-05');
      check('MUTACION: un push con ventana VIEJA no retrocede max_fecha', h3.mx === '2026-06-20',
        `quedo en ${h3.mx}: un push parcial estaria empeorando el latido`);
      check('MUTACION: un push con ventana VIEJA no mueve la marca de avance',
        +new Date(h3.av) === +new Date(h2.av),
        'la movio: el latido volveria a decir "al dia" sobre datos viejos — es el defecto entero');
    } finally {
      await db.query('ROLLBACK');
    }
    const { rows: [limpio] } = await db.query(
      `SELECT count(*)::int n FROM ingest.route_push_heartbeat WHERE truck=$1`, [CAMION]);
    check('el rollback no dejo nada', limpio.n === 0, `quedaron ${limpio.n}`);
  }

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
