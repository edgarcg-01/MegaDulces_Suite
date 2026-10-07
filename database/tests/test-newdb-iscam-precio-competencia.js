/* eslint-disable no-console */
/**
 * `[PR.M6]` — Candado del precio de la competencia.
 *
 * Esta cifra no viene en el archivo: se **deriva**, y por eso lo que hay que vigilar no es que
 * exista sino que **signifique algo**. Tres aserciones cargan el peso:
 *
 *  1. ⭐ Que NO sea una identidad algebraica. Si la razón precio_nuestro/precio_competencia
 *     diera 1.000 en todas partes, estaría midiendo una tautología y no un precio. Se exige
 *     dispersión.
 *  2. ⛔ **Prueba negativa**: una celda sin valor en la entrega NO puede salir publicada como
 *     "al_mercado". La primera versión tenía un `ELSE` que hacía exactamente eso con **11,709**
 *     celdas del archivo.
 *  3. ⚠️ Que la confianza siga saliendo de donde está el ruido —nuestro propio volumen—, y no
 *     del tamaño del mercado.
 */
'use strict';

const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* en el contenedor la URL viene del entorno */ }
const { Client } = require('pg');

const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const V = 'analytics.v_iscam_precio_competencia';
const SLICE = `region='Región III' AND subcanal='Mayoreo Puro' AND mercado='DULCES'`;
let ok = 0, fail = 0, nomedido = 0;
const check = (c, m) => { if (c) { ok++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const skip = (m) => { nomedido++; console.log('  — NO MEDIDO: ' + m); };

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await db.connect();
  await db.query(`SET app.tenant_id = '${TENANT}'`);
  const q = async (s, p) => (await db.query(s, p)).rows;

  console.log('\n[1] La forma');
  const vi = await q(`SELECT c.reloptions::text o FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='v_iscam_precio_competencia'`);
  check(vi.length === 1, 'la vista existe');
  check(vi.length === 1 && /security_invoker=(true|on)/.test(vi[0].o || ''),
    'tiene security_invoker: sin él lee con los permisos del creador y saltea el RLS');

  console.log('\n[2] ⭐ No es una identidad algebraica');
  const d = await q(`
    SELECT count(*)::int n,
      round(stddev(precio_nuestro/precio_competencia)::numeric,4) desv,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY precio_nuestro/precio_competencia)::numeric,4) p50,
      round(min(precio_nuestro/precio_competencia)::numeric,3) mn,
      round(max(precio_nuestro/precio_competencia)::numeric,3) mx
    FROM ${V} WHERE ${SLICE} AND precio_competencia > 0 AND precio_nuestro IS NOT NULL`);
  if (!d.length || !d[0].n) { skip('sin celdas calculables: la dispersión no se puede medir'); }
  else {
    const x = d[0];
    console.log(`     n=${x.n} · mediana ${x.p50} · desviacion ${x.desv} · de ${x.mn} a ${x.mx}`);
    check(Number(x.desv) > 0.05,
      `la razón tiene dispersión real (${x.desv}): si fuera ~0 estaría midiendo una tautología`);
    check(Number(x.mn) < 0.9 && Number(x.mx) > 1.1,
      'hay submarcas claramente por debajo Y por encima del precio de la competencia');
    check(Number(x.n) > 300, `${x.n} submarcas con precio comparable`);
  }

  console.log('\n[3] ⛔ PRUEBA NEGATIVA: lo que no se pudo medir NO sale como "al mercado"');
  const mal = await q(`
    SELECT count(*)::int n FROM ${V}
    WHERE veredicto IN ('al_mercado','arriba_del_mercado','abajo_del_mercado')
      AND (precio_nuestro IS NULL OR precio_competencia IS NULL OR precio_competencia = 0)`);
  check(mal[0].n === 0,
    `ninguna celda sin precio sale con veredicto de comparación (${mal[0].n} lo hacen)`);
  const sinVal = await q(`SELECT count(*)::int n FROM ${V} WHERE veredicto='sin_valor_en_la_entrega'`);
  if (!sinVal[0].n) {
    skip('esta entrega no trae celdas sin valor: la rama existe pero no se pudo ejercer');
  } else {
    console.log(`     ${sinVal[0].n.toLocaleString('es-MX')} celdas traen solo volumen, sin valor`);
    check(sinVal[0].n > 0,
      'las celdas sin valor tienen veredicto PROPIO — antes caían por el ELSE y decían "al_mercado"');
  }

  console.log('\n[4] Las cuatro ausencias se distinguen');
  const ver = await q(`SELECT veredicto, confianza, count(*)::int n,
      round(sum(venta_nuestra)/1e6,2) mdp
    FROM ${V} WHERE ${SLICE} GROUP BY 1,2 ORDER BY 4 DESC NULLS LAST`);
  if (!ver.length) { skip('sin filas en el universo propio'); }
  else {
    ver.forEach((r) => console.log(`     ${String(r.veredicto).padEnd(32)}${String(r.confianza || '—').padEnd(7)}`
      + `${String(r.n).padStart(5)}  ${r.mdp === null ? '—' : '$' + r.mdp + 'M'}`));
    const claves = new Set(ver.map((r) => r.veredicto));
    check(claves.has('no_la_vendemos') && claves.has('somos_el_unico_vendedor_medido'),
      'no venderla y ser el único vendedor medido se publican por separado: no son la misma ausencia');
    const arriba = ver.filter((r) => r.veredicto === 'arriba_del_mercado')
      .reduce((a, r) => a + Number(r.mdp || 0), 0);
    const abajo = ver.filter((r) => r.veredicto === 'abajo_del_mercado')
      .reduce((a, r) => a + Number(r.mdp || 0), 0);
    check(arriba > 0 && abajo > 0,
      `$${arriba.toFixed(2)}M de venta por ARRIBA del precio de la competencia y $${abajo.toFixed(2)}M por abajo`);
  }

  console.log('\n[5] ⚠️ La confianza sale de donde está el ruido');
  const conf = await q(`
    SELECT confianza, count(*)::int n,
      round(stddev(precio_nuestro/precio_competencia)::numeric,3) desv
    FROM ${V} WHERE ${SLICE} AND confianza IS NOT NULL AND precio_competencia > 0
    GROUP BY 1 ORDER BY 1`);
  if (conf.length < 2) { skip('no hay las dos bandas de confianza'); }
  else {
    conf.forEach((r) => console.log(`     ${String(r.confianza).padEnd(6)} n=${String(r.n).padStart(4)} · desviacion ${r.desv}`));
    const alta = conf.find((r) => r.confianza === 'alta');
    const baja = conf.find((r) => r.confianza === 'baja');
    // ⭐ La banda no es una etiqueta decorativa: la de confianza alta tiene que ser MENOS
    //   dispersa. Si dejara de serlo, el criterio se desfasó del dato que lo justificaba.
    check(Number(alta.desv) < Number(baja.desv),
      `la banda "alta" es menos dispersa que la "baja" (${alta.desv} contra ${baja.desv})`);
  }

  console.log('\n[6] ⛔ La advertencia de unidad viaja con el dato');
  const adv = await q(`SELECT advertencia FROM ${V} WHERE ${SLICE} LIMIT 1`);
  if (!adv.length) { skip('sin filas'); }
  else {
    check(/no esta verificada|NO esta verificada/i.test(adv[0].advertencia)
      && /DENTRO de la misma/i.test(adv[0].advertencia),
    'cada fila dice que la unidad no está verificada y que sólo se compara dentro de la submarca');
  }

  console.log('\n[7] La pantalla tiene que poder leerla');
  const t0 = Date.now();
  await q(`SELECT submarca, precio_nuestro, precio_competencia, dif_pct, confianza
    FROM ${V} WHERE ${SLICE} AND veredicto='arriba_del_mercado' AND confianza='alta'
    ORDER BY venta_nuestra DESC LIMIT 50`);
  const ms = Date.now() - t0;
  check(ms < 1000, `las submarcas caras con confianza alta en ${ms} ms (la compuerta es 1 s)`);

  await db.end();
  console.log(`\n${ok} ✓ / ${fail} ✗ / ${nomedido} no medido`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
