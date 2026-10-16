/* eslint-disable no-console */
/**
 * `[VEC.25]` — **Compuerta: ninguna venta de ruta vecinal se cae por no estar clasificada.**
 *
 * ── Qué vigila, y por qué ────────────────────────────────────────────────────────────────────
 * Lo que motivó la fase, textual (Edgar, 2026-10-16): *«debe ser todo un sistema y no solo
 * parches por ruta»*. Esta prueba es la parte del sistema que AVISA: si mañana una ruta empieza a
 * facturar con un tipo de documento que nadie clasificó, acá se pone rojo con el importe en la
 * mano, en vez de que la venta desaparezca de la pantalla sin que nadie se entere.
 *
 * Ya pasó dos veces, medido:
 *   - `UD1301 «Factura Cred No Fiscal»` — $3,245,522.84 en 340 documentos de 2026, fuera de todo.
 *   - `1V006 «RUTA VECINAL MORELIA ABASTOS»` — $721,860.44, invisible por no emitir `U-D-10`.
 *
 * ── ⛔ La prueba NEGATIVA ────────────────────────────────────────────────────────────────────
 * El bloque 7 **rompe la compuerta a propósito**: borra lógicamente la clase de `UD1301` dentro
 * de una transacción, comprueba que la vista lo declara `sin_clasificar` con su importe, y hace
 * ROLLBACK. Sin eso, los otros seis bloques son una intención: pasarían igual contra una vista
 * que devolviera cero filas siempre.
 *
 * Uso:  node database/tests/test-newdb-clase-documento-venta.js
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;

let ok = 0, fail = 0, nomedido = 0;
const bien = (m) => { ok++; console.log('  ✓ ' + m); };
const mal = (m) => { fail++; console.log('  ✘ ' + m); };
const sinMedir = (m) => { nomedido++; console.log('  ○ NO MEDIDO — ' + m); };

async function main() {
  if (!URL) { sinMedir('sin PROD_DB_URL: no hay base contra la cual medir'); return salir(); }
  const c = new Client({ connectionString: URL });
  await c.connect();

  const hay = await c.query(`SELECT to_regclass('analytics.v_vecinal_route_doc_coverage') v,
                                    to_regclass('analytics.v_kepler_sale_doc_class') k`);
  if (!hay.rows[0].v || !hay.rows[0].k) {
    // ADR-056: la ausencia se DECLARA. No se reporta verde «nada que revisar».
    mal('las vistas de [VEC.25] no existen en esta base — la migración no está aplicada');
    for (let i = 0; i < 5; i++) sinMedir('depende de las vistas de [VEC.25]');
    await c.end(); return salir();
  }

  // 1 — El universo de tipos sale del ERP, no de una lista nuestra.
  const u = await c.query(`SELECT count(*)::int n,
      count(*) FILTER (WHERE clase = 'sin_clasificar')::int sin_clase
    FROM analytics.v_kepler_sale_doc_class`);
  if (u.rows[0].n >= 20) bien(`el catálogo publica ${u.rows[0].n} tipos de documento de venta`);
  else mal(`sólo ${u.rows[0].n} tipos: el universo no puede salir de una lista escrita a mano`);

  // 2 — ⭐ LA COMPUERTA: cero importe sin clasificar en rutas vecinales.
  const s = await c.query(`SELECT doc_code, doc_nombre, sum(importe)::float imp, sum(docs)::int docs
      FROM analytics.v_vecinal_route_doc_coverage
     WHERE clase = 'sin_clasificar' AND importe > 0
     GROUP BY 1,2 ORDER BY 3 DESC`);
  if (s.rowCount === 0) bien('ninguna venta de ruta vecinal queda sin clasificar');
  else {
    mal(`${s.rowCount} tipo(s) con venta vecinal SIN CLASIFICAR — hay que decidir su clase:`);
    for (const r of s.rows) {
      console.log(`      ${r.doc_code} ${r.doc_nombre ?? '(sin nombre en kdmm)'} · ` +
                  `${r.docs} doc(s) · $${r.imp.toLocaleString('es-MX')}`);
    }
  }

  // 3 — El universo de RUTAS es el catálogo, no «las que emitieron un ticket».
  const r = await c.query(`SELECT count(DISTINCT route_no)::int rutas,
      count(DISTINCT route_no) FILTER (WHERE importe > 0)::int con_venta
    FROM analytics.v_vecinal_route_doc_coverage`);
  if (r.rows[0].rutas > r.rows[0].con_venta) {
    bien(`${r.rows[0].rutas} rutas en el catálogo, ${r.rows[0].con_venta} con venta: ` +
         'una ruta sin venta se declara, no se omite');
  } else if (r.rows[0].rutas === r.rows[0].con_venta && r.rows[0].rutas > 0) {
    bien(`las ${r.rows[0].rutas} rutas del catálogo tienen venta`);
  } else {
    mal('el universo de rutas llegó vacío');
  }

  // 4 — Una ruta que NO cobra en caja igual aparece. Es el caso 1V006, el que faltaba.
  const v6 = await c.query(`SELECT clase, sum(importe)::float imp
      FROM analytics.v_vecinal_route_doc_coverage
     WHERE route_no = '1V006' AND importe > 0 GROUP BY 1 ORDER BY 2 DESC`);
  if (v6.rowCount === 0) {
    sinMedir('1V006 no tiene venta en esta base — no se puede comprobar el caso que lo motivó');
  } else if (v6.rows.some((x) => x.clase === 'credito')) {
    bien(`1V006 aparece con su venta a crédito ($${v6.rows.find((x) => x.clase === 'credito').imp
      .toLocaleString('es-MX')}) aunque nunca emitió un ticket de caja`);
  } else {
    mal(`1V006 aparece pero sin clase 'credito': ${v6.rows.map((x) => x.clase).join(', ')}`);
  }

  // 5 — El espejo NO se suma: sigue siendo la trampa más cara de este dominio.
  const e = await c.query(`SELECT sum(importe)::float imp FROM analytics.v_vecinal_route_doc_coverage
     WHERE clase = 'espejo_factura'`);
  const esp = e.rows[0].imp ?? 0;
  if (esp > 0) {
    bien(`el espejo está IDENTIFICADO y aparte ($${esp.toLocaleString('es-MX')}): ` +
         'sumarlo duplicaría la venta');
  } else {
    sinMedir('no hay documentos espejo en esta base');
  }

  /**
   * 6 — ⭐⭐ **El espejo no puede estar escondiendo venta.** Es la mitad peligrosa de la
   * clasificación: `credito` de menos se ve (falta plata), `espejo` de más **no se ve** —
   * simplemente no aparece.
   *
   * ── Lo que se midió el 2026-10-16, y por qué este bloque quedó así ───────────────────────
   * `UD0501` se había clasificado espejo **por el nombre**, sin medir. Son $4.36 M. Medido:
   *
   *   cruce documento a documento, mismo día e importe:
   *     UD05xx .. 93.9 % de los docs · placebo (+30 d) 0.1 %   <- control, el cruce es real
   *     UD12xx .. 61.1 % de los docs · placebo (+30 d) 0.1 %
   *
   *   exceso sobre los tickets, por grano:
   *     UD05xx .. día $273,151 · semana $187,023 · mes $108,004 · TODO $41,420
   *     UD12xx .. día  $20,478 · semana    $693 · mes       $0 · TODO      $0
   *
   * ⭐ `UD12xx` colapsa a CERO al grano mes: espejo puro, la diferencia era desfase de fecha.
   * De `UD05xx` queda un neto de **$41,420 (0.95 %)**, concentrado en `1V003` (+$27,382) y
   * `3V001` (+$14,038). ⛔ Hipótesis de tickets cancelados: **refutada**, esas rutas no tienen
   * ni uno. Lo que sí lo explica es el mes: la diferencia **oscila alrededor de cero**
   * (+1.2 %, −1.4 %, +0.2 %, +8.8 %, +4.0 %, **−8.3 %**, +10.4 %) y julio (+$41,727) casi se
   * cancela con septiembre (−$44,791). **La venta no va en negativo; un desfase sí.**
   *
   * Por eso la compuerta vigila el NETO acumulado, no el mes: un mes suelto no dice nada, y
   * exigirle cero haría ruido siete veces al año. Si el neto se despega, el espejo dejó de
   * serlo y hay venta escondida.
   */
  const ESPEJO_MAX_PCT = 2.0; // hoy 0.95 %. Si sube, alguien cambió el proceso.
  const porRuta = await c.query(`
    WITH d AS (
      SELECT btrim(h.c12) AS ruta, (h.c4)::int AS dt, h.c16 AS imp
        FROM kepler_ods.kdm1 h
       WHERE h.c2='U' AND h.c3='D' AND (h.c4)::int IN (10,5,12)
         AND btrim(COALESCE(h.c12,'')) ~ '^[0-9]V[0-9]'
         AND btrim(COALESCE(h.c1,''))=btrim(h.sucursal)
         AND COALESCE(NULLIF(btrim(h.c43),''),'')<>'C'),
    g AS (
      SELECT ruta,
             COALESCE(sum(imp) FILTER (WHERE dt=10),0) AS tk,
             COALESCE(sum(imp) FILTER (WHERE dt IN (5,12)),0) AS fx
        FROM d GROUP BY 1)
    SELECT sum(GREATEST(0, fx - tk))::float AS exceso,
           sum(fx)::float AS espejo FROM g`);
  {
    const x = porRuta.rows[0];
    const pct = x.espejo ? (100 * (x.exceso || 0) / x.espejo) : 0;
    const txt = `$${Math.round(x.exceso || 0).toLocaleString('es-MX')} sobre ` +
                `$${Math.round(x.espejo).toLocaleString('es-MX')} (${pct.toFixed(2)} %)`;
    if (pct <= ESPEJO_MAX_PCT) {
      bien(`el espejo no esconde venta: neto ${txt}, bajo el ${ESPEJO_MAX_PCT} % tolerado`);
    } else {
      mal(`⛔ el espejo EXCEDE a los tickets en ${txt}. Dejó de ser espejo: esa venta no ` +
          'aparece en ninguna pantalla. Revisar la clase de UD0501/UD1201.');
    }
  }

  /**
   * 7 — ⛔ PRUEBA NEGATIVA: se rompe la compuerta a propósito y se exige el rojo.
   *
   * ⚠️ Necesita una credencial que ESCRIBA. Desde el puesto de trabajo se lee prod en
   * `default_transaction_read_only`, así que ahí esto no se puede ejercer — y eso se DECLARA
   * `NO MEDIDO`, no se reporta verde ni se revienta la corrida. Para ejercerla de verdad va
   * desde dentro del pod de `api`, que es donde vive la credencial de escritura:
   *
   *   kubectl exec -n prod $API -c api -- sh -c \
   *     'PROD_DB_URL="$DATABASE_URL_NEW" node /app/database/tests/test-newdb-clase-documento-venta.js'
   */
  await c.query('BEGIN');
  try {
    const antes = await c.query(`SELECT count(*)::int n FROM analytics.v_vecinal_route_doc_coverage
       WHERE clase = 'sin_clasificar' AND importe > 0`);
    await c.query(`UPDATE analytics.kepler_sale_doc_class SET deleted_at = now()
                    WHERE tenant_id = $1::uuid AND doc_code = 'UD1301'`, [TENANT]);
    const despues = await c.query(`SELECT sum(importe)::float imp
       FROM analytics.v_vecinal_route_doc_coverage
      WHERE doc_code = 'UD1301' AND clase = 'sin_clasificar'`);
    if ((despues.rows[0].imp ?? 0) > 0 && antes.rows[0].n === 0) {
      bien(`prueba negativa: al quitar la clase de UD1301 la vista lo declara ` +
           `sin_clasificar con $${despues.rows[0].imp.toLocaleString('es-MX')} — la compuerta MIDE`);
    } else if ((despues.rows[0].imp ?? 0) > 0) {
      bien('prueba negativa: UD1301 se declara sin_clasificar al quitarle la clase');
    } else {
      mal('prueba negativa FALLIDA: se quitó la clase de UD1301 y la vista no lo declaró. ' +
          'La compuerta del bloque 2 no está midiendo nada.');
    }
  } catch (e) {
    if (/read-only/i.test(e.message)) {
      sinMedir('prueba negativa: esta credencial es de sólo lectura. Correrla desde el pod de ' +
               'api para ejercerla (ver el comentario del bloque 7)');
    } else {
      mal('prueba negativa: error inesperado — ' + e.message);
    }
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }

  await c.end();
  salir();
}

function salir() {
  console.log(`\n${ok} ✓ · ${fail} ✘ · ${nomedido} NO MEDIDO`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
