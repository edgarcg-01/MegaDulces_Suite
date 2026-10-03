#!/usr/bin/env node
'use strict';
/**
 * `[PO.0]` — **La compuerta del corte del 1 de octubre de 2026.**
 *
 *   node database/scripts/check-corte-01oct.js
 *   DATABASE_URL_NEW=<url-de-prod> node database/scripts/check-corte-01oct.js
 *
 * SÓLO LEE. No escribe nada, ni en la plataforma ni en el ERP (ADR-040).
 *
 * ## El hecho de negocio que vigila
 * Del 2026-01-01 al 2026-09-30 la sucursal `00` fue el **concentrador** por el que pasó la
 * migración Wincaja→Kepler. **Desde el 2026-10-01 dejó de serlo**: el `00` sólo recibe CEDIS,
 * logística y corporativo, y cada centro de costo opera por su cuenta.
 *
 * Varias vistas del repo codificaron la era vieja con un `sucursal = '00'` cableado. Para
 * enero–septiembre eso era **correcto**. Desde octubre deja fuera a los centros nuevos **sin un
 * solo error**: las pantallas no se rompen, muestran menos filas.
 *
 * ## Las dos preguntas, y por qué hacen falta LAS DOS
 *  1. **¿Qué vistas siguen ancladas al `00`?** (lee el catálogo, siempre se puede medir)
 *  2. **¿Hay documentos post-corte fuera del `00`?** (necesita el ODS poblado)
 *
 * ⛔ Son **dos problemas distintos que producen la misma pantalla vacía**: el filtro y la
 * ingesta. Si la respuesta 2 es «cero», el problema NO es el filtro — es que la réplica de esas
 * plazas no está llegando, y desanclar las vistas no cambiaría nada. Arreglar uno sin verificar
 * el otro deja el trabajo a medias y pareciendo completo.
 *
 * ## Lo que no se puede medir se DECLARA (ADR-056)
 * Si el ODS no tiene datos, el bloque 2 reporta **NO MEDIDO** y sale 0. «No encontré nada» y
 * «está bien» no son lo mismo, y este script no los confunde.
 *
 * Plan completo: docs/IMPLEMENTACION/FASES/FASE_PO_POST_CORTE_01OCT.md
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

/** El día en que el `00` dejó de concentrar. Una sola vez, acá. */
const CORTE = process.env.CORTE_CENTROS || '2026-10-01';
const CONCENTRADOR = '00';

let fail = 0, nomedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚪ NO MEDIDO — ${m}`); nomedido++; };

/** Detecta el ancla al concentrador y la forma correcta, sobre el texto real de la vista. */
const ANCLA = /(?:\w+\.)?sucursal\s*=\s*'00'|btrim\(\s*(?:\w+\.)?c1\s*\)\s*=\s*'00'/gi;
const FORMA_OK = /btrim\(\s*(\w+)\.c1\s*\)\s*=\s*\1\.sucursal/i;

(async () => {
  console.log(`\n[PO.0] El corte del ${CORTE} — el 00 dejó de concentrar\n`);

  // ── 1) ¿Qué vistas siguen ancladas al concentrador? ────────────────────────────────
  console.log('1) vistas y matvistas ancladas a la sucursal 00');
  const objs = await knex.raw(`
    select n.nspname sch, c.relname obj, c.relkind k, pg_get_viewdef(c.oid, true) def
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('v','m')
       and n.nspname in ('analytics','kepler_ods','finance','commercial','catalog')
     order by 1,2`);

  const ancladas = [];
  for (const r of objs.rows) {
    const hits = String(r.def).match(ANCLA) || [];
    if (!hits.length) continue;
    ancladas.push({
      objeto: `${r.sch}.${r.obj}`,
      tipo: r.k === 'm' ? 'matvista' : 'vista',
      anclas: hits.length,
      // La forma canónica: el documento es de SU plaza. Si ya la usa, el ancla que queda
      // suele ser un JOIN acotado al CEDIS (legítimo) y no el filtro del universo.
      forma_correcta: FORMA_OK.test(r.def) ? 'sí' : 'NO',
    });
  }

  console.log(`   revisadas: ${objs.rows.length} · ancladas: ${ancladas.length}`);
  if (ancladas.length) console.table(ancladas);

  const pendientes = ancladas.filter((a) => a.forma_correcta === 'NO');
  ok(objs.rows.length > 0, 'se pudo leer el catálogo de vistas');
  if (pendientes.length) {
    console.log(`\n   ⛔ ${pendientes.length} vista(s) SIN la forma canónica \`btrim(c1) = sucursal\`:`);
    for (const p of pendientes) console.log(`      · ${p.objeto}  (${p.anclas} ancla(s))`);
    console.log('      Desde el corte, lo que emiten los centros nuevos queda fuera de estas vistas.');
  } else {
    console.log('\n   ✅ ninguna vista quedó con el filtro del universo anclado al 00.');
  }

  // ── 2) ¿Hay documentos POST-corte fuera del concentrador? ──────────────────────────
  console.log(`\n2) documentos en el ODS con fecha >= ${CORTE}, por sucursal`);
  const hayOds = (await knex.raw(`select to_regclass('kepler_ods.kdm1') x`)).rows[0].x;
  if (!hayOds) {
    nm('`kepler_ods.kdm1` no existe en esta base');
  } else {
    // ⚠️ Se usa `c68` (fecha de CAPTURA) y NO `c9`: ERP_KEPLER documenta que `c9` (fecha del
    // documento) PUEDE VENIR EN EL FUTURO — medido hasta 2026-12-31. Un corte sobre `c9`
    // clasificaria documentos de septiembre como posteriores al corte.
    // ⚠️ Las dos columnas son `timestamp` en el ODS, no texto: se castean en vez de
    //    cortarlas con substr(). Un `btrim()` sobre timestamp revienta la consulta entera.
    const total = Number((await knex('kepler_ods.kdm1').count('* as n').first()).n);
    if (total === 0) {
      nm('`kepler_ods.kdm1` está vacía: no se puede contar lo que hay fuera del 00');
      console.log('      (en la base de trabajo esto es normal — prod vive en el servidor `md`)');
    } else {
      const filas = (await knex.raw(`
        select btrim(sucursal) sucursal,
               count(*)::int docs,
               to_char(min(coalesce(c68, c9)::timestamp), 'YYYY-MM-DD') primero,
               to_char(max(coalesce(c68, c9)::timestamp), 'YYYY-MM-DD') ultimo
          from kepler_ods.kdm1
         where coalesce(c68, c9)::timestamp >= ?::date
         group by 1 order by 2 desc`, [CORTE])).rows;

      if (!filas.length) {
        console.log(`   no hay NINGÚN documento con fecha >= ${CORTE} en el ODS.`);
        console.log('   ⛔ Esto NO confirma que el filtro esté bien: puede ser que la ingesta de');
        console.log('      los centros nuevos todavía no llegue. Son dos problemas distintos y');
        console.log('      los dos se ven igual desde acá — hay que revisar el carril de réplicas.');
        nm('sin documentos post-corte no se puede decidir si el filtro estorba');
      } else {
        console.table(filas);
        const fuera = filas.filter((f) => f.sucursal !== CONCENTRADOR);
        const nFuera = fuera.reduce((a, f) => a + f.docs, 0);
        const nDentro = filas.filter((f) => f.sucursal === CONCENTRADOR)
          .reduce((a, f) => a + f.docs, 0);
        console.log(`   dentro del ${CONCENTRADOR}: ${nDentro} · fuera: ${nFuera} (${fuera.length} plaza(s))`);
        ok(nFuera > 0,
          nFuera > 0
            ? `hay ${nFuera} documento(s) post-corte fuera del ${CONCENTRADOR}: las vistas ancladas NO los ven`
            : `⛔ CERO documentos fuera del ${CONCENTRADOR}: revisar la INGESTA antes que el filtro`);
      }
    }
  }

  // ── 3) La prueba negativa de la compuerta ──────────────────────────────────────────
  // Sin esto, el bloque 1 se pondría verde con una expresión regular rota: no distinguiría
  // «ninguna vista anclada» de «no detecto el patrón».
  console.log('\n3) ⭐ prueba negativa: el detector reconoce un ancla cuando la hay');
  const falsa = `SELECT * FROM kepler_ods.kdm1 WHERE kdm1.sucursal = '00' AND btrim(kdm1.c1) = '00'`;
  const buena = `SELECT * FROM kepler_ods.kdm1 ap WHERE btrim(ap.c1) = ap.sucursal`;
  ok((falsa.match(ANCLA) || []).length === 2, 'detecta las 2 anclas de una vista vieja');
  ok(!FORMA_OK.test(falsa), 'y NO la confunde con la forma canónica');
  ok(FORMA_OK.test(buena), 'reconoce la forma canónica `btrim(x.c1) = x.sucursal`');
  ok((buena.match(ANCLA) || []).length === 0, 'y en la forma canónica no ve anclas');

  console.log(`\n${fail ? `❌ ${fail} fallo(s)` : '✅ todo verde'}${nomedido ? ` · ⚪ ${nomedido} no medido(s)` : ''}`);
  console.log('   Plan: docs/IMPLEMENTACION/FASES/FASE_PO_POST_CORTE_01OCT.md\n');

  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('ERR', e.message); await knex.destroy(); process.exit(1); });
