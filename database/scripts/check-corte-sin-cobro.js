'use strict';
/**
 * ⭐⭐ `[CGA-A.0]` — **Qué cortes de caja cerraron y su cobro NUNCA se aplicó.**
 *
 *   node database/scripts/check-corte-sin-cobro.js
 *   node database/scripts/check-corte-sin-cobro.js --dias=30
 *   node database/scripts/check-corte-sin-cobro.js --self-test
 *
 * Sólo lee. Código de salida **0 siempre**: esto informa, no frena. Un corte sin cobro es un
 * hecho de la operación que alguien tiene que resolver, no una regresión de código.
 *
 * ── Qué mide, y por qué hacía falta ─────────────────────────────────────────────────────────
 *
 * El circuito del efectivo de venta es: **corte de caja `U-D-23` → lo salda un cobro `U-A-5`**, y
 * ese cobro es lo que entra a Caja General. El hermano `check-cobranza-ruta-sin-puerta.js`
 * (`[CG.120]`) mide las rutas que venden y **no tienen por dónde** entrar. Éste mide el escalón
 * siguiente: las que **sí tienen puerta y el cobro no se hizo**.
 *
 * Son preguntas distintas y se arreglan en lugares distintos. Fundirlas manda a la mitad de los
 * casos a tocar la puerta equivocada.
 *
 * ── De dónde sale, medido contra prod el 2026-10-16 ─────────────────────────────────────────
 *
 * El circuito **funciona en sucursal y no existe en camioneta**:
 *
 *     sucursal  (c1 = '01'…'08')     426 cortes de octubre →  350 saldados (82 %)
 *     camioneta (c1 = '01-001'…)      67 cortes            →    0 saldados
 *
 * En `kepler_ods.kdm5` **no hay una sola fila con almacén compuesto**. La aplicación del cobro de
 * camioneta vive en el Kepler local de la unidad y no sincroniza — por eso existe el push a
 * `analytics.route_collections`, y por eso ⛔ **el ODS NO es superconjunto del importer**: puede
 * ver el corte, nunca el enlace cobro↔corte.
 *
 * Y hay un hueco con monto: de los 67 cortes de camioneta ($1,151,493.52), sólo **6 tienen cobro
 * `U-A-5`** en el ODS (02 al 05-oct, $117,972.97). Del 06-oct en adelante, el corte se emite y el
 * cobro **no aparece por ningún lado** — ni en el ODS, ni en el push, ni en el libro.
 *
 * ── Tres estados, no dos ────────────────────────────────────────────────────────────────────
 *
 * - `saldado` .......... tiene aplicación en `kdm5`. Nada que hacer.
 * - `sin_cobro` ........ sucursal, sin aplicación → **lo arregla quien captura en Kepler.**
 * - `fuera_del_ods` .... camioneta, sin aplicación → el enlace no puede estar acá. **Lo arregla
 *                        el push**, y si el push tampoco lo trae, el dinero no está en ningún
 *                        libro.
 *
 * ⛔ **No se cruza por importe.** La pregunta es estructural —existe o no existe la aplicación—,
 * y en este proyecto el cruce por importe ya está refutado con control de placebo dos veces.
 *
 * ⚠️⚠️ **El join correcto importa, y el modo de fallar NO es el que supuse.** `kdm5.c5` es el
 * SUBTIPO del documento pagador, no el folio; el folio saldado es `kdm5.c11` (text, con ceros a
 * la izquierda) contra `kdm1.c5` (numeric).
 *
 * Mi primera versión de esta prueba afirmaba que unir por `m.c5 = k.c5` «devuelve 0 saldados
 * siempre». **Falso, y la prueba negativa lo atrapó:** el join malo devuelve **431 de 498**
 * contra los 350 reales. No ciega — **SOBRE-CASA**, porque `c5` vale 1 en casi todo y el único
 * filtro que queda en pie es el almacén.
 *
 * ⭐ Y por eso es más peligroso de lo que yo creía: un join que devuelve 0 se nota; uno que
 * devuelve de más **esconde 81 cortes y $2,984,827.33** y deja la pantalla en verde. El
 * `--self-test` exige que los dos joins DIFIERAN y que el malo reporte de MÁS.
 *
 * (El 0 que vi al medir los cortes de camioneta era correcto por otra razón: `kdm5` no tiene
 * **ninguna** fila con almacén compuesto, así que ahí fallaba el filtro de almacén, no el de
 * folio. Se verificó después con el join bueno: 0 de 67.)
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
const DIAS = Number((process.argv.find((a) => a.startsWith('--dias=')) || '').split('=')[1]) || 30;
const SELF = process.argv.includes('--self-test');

const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

/** El join bueno: folio saldado `kdm5.c11` (text con ceros) contra `kdm1.c5` (numeric). */
const APLICADO = `EXISTS (
  SELECT 1 FROM kepler_ods.kdm5 m
   WHERE btrim(m.c1) = btrim(k.c1)
     AND btrim(m.c8) = 'D' AND m.c9 = 23
     AND btrim(m.c11) ~ '^[0-9]+$' AND btrim(m.c11)::numeric = k.c5
)`;

/** El join MALO: sobre-casa porque `c5` vale 1 en casi todo. Sólo lo usa `--self-test`. */
const APLICADO_MALO = `EXISTS (
  SELECT 1 FROM kepler_ods.kdm5 m
   WHERE btrim(m.c1) = btrim(k.c1) AND m.c5 = k.c5
)`;

const CORTES = `
  FROM kepler_ods.kdm1 k
 WHERE k.c2 = 'U' AND k.c3 = 'D' AND k.c4 = 23
   AND k.c9 >= current_date - $1::int AND k.c9 < current_date + 1`;

async function main(c) {
  const { rows: resumen } = await c.query(`
    SELECT CASE WHEN ${APLICADO} THEN 'saldado'
                WHEN btrim(k.c1) LIKE '%-%' THEN 'fuera_del_ods'
                ELSE 'sin_cobro' END AS estado,
           count(*)::int AS cortes, sum(k.c16) AS monto,
           to_char(min(k.c9),'YYYY-MM-DD') AS desde, to_char(max(k.c9),'YYYY-MM-DD') AS hasta
      ${CORTES}
     GROUP BY 1 ORDER BY 3 DESC NULLS LAST`, [DIAS]);

  const total = resumen.reduce((a, r) => a + r.cortes, 0);
  const dinero = resumen.reduce((a, r) => a + Number(r.monto || 0), 0);

  console.log(`\nCortes de caja U-D-23 de los últimos ${DIAS} días: ${total} · ${money(dinero)}\n`);
  console.log(`  ${pad('estado', 16)}${padL('cortes', 8)}${padL('monto', 18)}   ventana`);
  console.log(`  ${'-'.repeat(60)}`);
  for (const r of resumen) {
    console.log(`  ${pad(r.estado, 16)}${padL(r.cortes, 8)}${padL(money(r.monto), 18)}   ${r.desde} → ${r.hasta}`);
  }

  // El detalle de lo que NO está saldado, por almacén: es la lista de trabajo.
  const { rows: det } = await c.query(`
    SELECT btrim(k.c1) AS almacen,
           CASE WHEN btrim(k.c1) LIKE '%-%' THEN 'fuera_del_ods' ELSE 'sin_cobro' END AS estado,
           count(*)::int AS cortes, sum(k.c16) AS monto,
           to_char(min(k.c9),'YYYY-MM-DD') AS desde, to_char(max(k.c9),'YYYY-MM-DD') AS hasta
      ${CORTES} AND NOT ${APLICADO}
     GROUP BY 1, 2 ORDER BY 4 DESC`, [DIAS]);

  if (!det.length) {
    console.log('\n  Todos los cortes de la ventana están saldados.\n');
  } else {
    console.log(`\n  Sin cobro aplicado, por almacén:\n`);
    console.log(`  ${pad('almacén', 12)}${pad('estado', 16)}${padL('cortes', 8)}${padL('monto', 18)}   ventana`);
    console.log(`  ${'-'.repeat(72)}`);
    for (const r of det) {
      console.log(`  ${pad(r.almacen, 12)}${pad(r.estado, 16)}${padL(r.cortes, 8)}${padL(money(r.monto), 18)}   ${r.desde} → ${r.hasta}`);
    }
  }

  /**
   * Para los de camioneta, la única fuente posible del enlace es el push. Si el push tampoco lo
   * tiene, el dinero no está en ningún libro — y eso hay que decirlo, no dejarlo implícito.
   */
  const { rows: push } = await c.query(`
    SELECT count(*)::int AS cortes, sum(k.c16) AS monto,
           sum(k.c16) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM analytics.route_collections r
              WHERE r.almacen = btrim(k.c1) AND r.fecha::date = k.c9::date)) AS monto_huerfano,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM analytics.route_collections r
              WHERE r.almacen = btrim(k.c1) AND r.fecha::date = k.c9::date))::int AS con_push
      ${CORTES} AND btrim(k.c1) LIKE '%-%' AND NOT ${APLICADO}`, [DIAS]);

  const p = push[0] || { cortes: 0, monto: 0, con_push: 0 };
  if (p.cortes) {
    const huerfanos = p.cortes - p.con_push;
    console.log(`\n  Camioneta: ${p.cortes} cortes sin aplicación · ${p.con_push} tienen fila en el push`);
    if (huerfanos > 0) {
      console.log(`  ⛔ ${huerfanos} cortes (${money(p.monto_huerfano)}) NO están en ningún libro: ni el ODS ve su cobro, ni el push los trajo.`);
    }
  }

  // La frescura del push, para no leer "0 huérfanos" como salud cuando en realidad está muerto.
  const { rows: hb } = await c.query(`
    SELECT to_char(max(fecha),'YYYY-MM-DD') AS ultimo, count(*)::int AS filas
      FROM analytics.route_collections`);
  console.log(`\n  Push (analytics.route_collections): ${hb[0].filas} filas · último cobro ${hb[0].ultimo ?? 'NUNCA'}`);
  console.log('');
}

async function selfTest(c) {
  console.log('\n[self-test] El join malo (`m.c5 = k.c5`) tiene que SOBRE-CASAR y esconder problemas.\n');
  const q = async (expr) => (await c.query(
    `SELECT count(*) FILTER (WHERE ${expr})::int AS saldados, count(*)::int AS total ${CORTES}`, [365]
  )).rows[0];

  const bueno = await q(APLICADO);
  const malo = await q(APLICADO_MALO);

  console.log(`  join bueno  → ${bueno.saldados} de ${bueno.total} saldados`);
  console.log(`  join malo   → ${malo.saldados} de ${malo.total} saldados  (esconde ${malo.saldados - bueno.saldados})`);

  const fallos = [];
  if (!(bueno.saldados > 0)) fallos.push('el join BUENO devolvió 0 saldados: o el circuito murió, o el join se rompió');
  if (bueno.saldados === malo.saldados) fallos.push('el join malo da lo MISMO que el bueno: esta prueba no distingue nada');
  if (!(malo.saldados > bueno.saldados)) fallos.push(`el join malo reportó ${malo.saldados} y el bueno ${bueno.saldados}: se esperaba que el malo SOBRE-CASE`);

  console.log('');
  if (fallos.length) { for (const f of fallos) console.log(`  ✗ ${f}`); console.log(''); process.exit(1); }
  console.log(`  ✓ La prueba negativa distingue: el join malo daría por saldados ${malo.saldados - bueno.saldados} cortes que NO lo están.\n`);
}

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    await c.query(`SET default_transaction_read_only = on`);
    await c.query(`SET statement_timeout = '120s'`);
    if (SELF) await selfTest(c); else await main(c);
  } finally { await c.end(); }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
