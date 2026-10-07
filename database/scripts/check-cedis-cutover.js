'use strict';
/**
 * [IC.CEDIS] LA COMPUERTA DE LA MIGRACIÓN DEL CEDIS — se corre el día del cutover.
 *
 *   node database/scripts/check-cedis-cutover.js
 *   node database/scripts/check-cedis-cutover.js --fecha 2026-09-30
 *
 * SÓLO LEE. No escribe nada, ni en la plataforma ni en el ERP (ADR-040).
 *
 * POR QUÉ HAY QUE CORRERLA ESE DÍA Y NO DESPUÉS
 * ---------------------------------------------
 * El CEDIS nunca tuvo un inventario físico: no está en Kepler, y en Wincaja el ajuste más
 * grande de toda su historia tiene 40 líneas. Lo que cargue el día del cutover se vuelve su
 * teórico de partida **sin baseline contra el cual reclamar después**. En cuanto opere en
 * Kepler y se mueva, ya no se puede distinguir *lo que nunca cargó* de *lo que se vendió*.
 *
 * LAS DOS PREGUNTAS (§1.11c de FASE_IC_INVENTARIO_CONTINUO.md)
 * -----------------------------------------------------------
 *  1. COBERTURA — ¿qué SKUs con existencia en Wincaja `00` NO llegaron a Kepler?
 *     ⭐ [IC.CEDIS.3 2026-10-01] SE MIDE CONTRA EL ALMACÉN (`kdil`), no contra el documento
 *     de la carga. Medir contra la carga declaraba «no llegó» todo lo que entró por otra vía
 *     —una compra, un traspaso, o diez meses de operación previa— y en el CEDIS sobredeclaró
 *     **5.5×** ($516,534 contra $93,316 reales). Ver el bloque 0b para el supuesto que falló.
 *     ⚠️ Las cifras de las tres migraciones anteriores (327 / 435 / 583 SKUs, $516,521) se
 *     midieron con la métrica VIEJA: no son comparables con lo que imprime hoy.
 *
 *  2. ⛔ SALDO DE ARRANQUE — ¿la carga REEMPLAZÓ el saldo previo de Kepler `00`, o se SUMÓ?
 *     `N-A-30` es una *entrada*: por construcción suma a `c8`. Y la `00` no arranca de cero
 *     como arrancaron `07` y `08` — arrastra 5,014 SKUs y ~13.8M de unidades (más 108.8M de
 *     un pseudo-SKU contable, `00001` VENTAS AL 0%). Si la carga se suma a eso, el CEDIS
 *     empieza su vida en Kepler con una existencia absurda y nadie tiene con qué notarlo.
 *     Se detecta SIN baseline guardado: si reemplazó, el saldo post-carga ≈ lo capturado;
 *     si sumó, el saldo queda ≈ saldo_previo + lo capturado.
 *
 * Lo que no se puede medir se DECLARA (ADR-056): si todavía no hay carga, lo dice y sale 0 —
 * "no encontré nada" y "está bien" no son lo mismo, y este script no los confunde.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CEDIS_CODE = process.env.CEDIS_WAREHOUSE_CODE || '00';
const WIN_BRANCH = process.env.WINCAJA_CEDIS_BRANCH || '00';
const KEP_SUC = process.env.CEDIS_KEPLER_SUCURSAL || '00';
const PSEUDO = ['00001', '00002', '00022'];  // pseudo-SKUs contables (VENTAS AL 0%, TIEMPO AIRE)

const iFecha = process.argv.indexOf('--fecha');
const FECHA = iFecha > -1 ? process.argv[iFecha + 1] : null;
// --csv: la lista COMPLETA de faltantes en CSV, para pasársela a almacén. Sin esto el informe
// corta en 40 y dice "y N más", que sirve para leer en pantalla pero no para ir a cargarlos.
const CSV = process.argv.includes('--csv');

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const num = (n) => Number(n || 0).toLocaleString('en-US');

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = new Client({ connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, binds) => (await db.query(sql, binds)).rows;
  let alarmas = 0;

  try {
    console.log('\n════ [IC.CEDIS] compuerta de la migración del CEDIS ════\n');

    // ── 0. ¿Ya hay carga? ────────────────────────────────────────────────────
    // ⚠️ El join lleva `c1` (el ALMACÉN): el folio no es único entre almacenes de la misma
    // sucursal y sin esa columna las líneas se duplican (FASE_IC §1.9).
    const cargas = await q(
      `SELECT m.c1 AS almacen, m.c6 AS folio, to_char(m.c9,'YYYY-MM-DD') AS fecha, m.c4 AS doctype,
              count(l.*)::int AS lineas,
              round(sum(l.c13::numeric),2) AS pesos,
              round(sum(l.c9::numeric),2) AS unidades
         FROM kepler_ods.kdm1 m
         JOIN kepler_ods.kdm2 l
           ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
          AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
        -- NO se fija el almacen a c1 = sucursal: la carga puede caer en un SUB-ALMACEN y
        -- quedar invisible. Paso de verdad -- la unica carga de Padre Hidalgo esta en el
        -- almacen 01-006 (la Ruta 28), no en 01, y con el filtro fijo el script decia que
        -- no habia carga sobre una sucursal que si cargo (mal, pero cargo).
        WHERE m.sucursal=$1 AND m.c2='N' AND m.c3='A' AND m.c4 IN ('45','30')
          -- Una fecha explicita REEMPLAZA la ventana, no se le suma: con el AND de los 30
          -- dias, pedir la carga de una sucursal vieja (06, el 2026-08-14) devolvia cero y
          -- el script decia "la carga no ocurrio" sobre una migracion que si ocurrio.
          --
          -- Y se busca en [fecha-3, fecha+1], no en el dia exacto: LA FECHA DE CARGA NO ES
          -- LA FECHA DE CORTE. Medido en las tres migraciones, la carga es SIEMPRE el dia
          -- ANTERIOR al cutover_date (06 14/15-ago, 07 07/08-sep, 08 18/19-sep). Quien tome
          -- la fecha de v_branch_erp_cutover y la pase tal cual le erraria por un dia y
          -- veria NO MEDIDO sobre una migracion que si ocurrio.
          -- No es "barrer hasta encontrar algo": es una ventana chica alrededor de una fecha
          -- que alguien pidio a proposito, y el script DECLARA que dia termino usando.
          -- (Sin acentos ni backticks: esto vive dentro de un template literal.)
          AND ($2::date IS NOT NULL OR (m.c9 >= current_date - 30 AND m.c9 <= current_date))
          AND ($2::date IS NULL OR m.c9::date BETWEEN $2::date - 3 AND $2::date + 1)
        GROUP BY 1,2,3,4 ORDER BY 3, 1, 4`,
      [KEP_SUC, FECHA]);

    if (!cargas.length) {
      console.log(`⚠️  NO MEDIDO: no hay documentos N-A-45/N-A-30 en la sucursal Kepler '${KEP_SUC}'`
        + ` (en NINGUNO de sus almacenes)${FECHA ? `, alrededor de ${FECHA}` : ' en los últimos 30 días'}.`);
      console.log('    ⛔ Esto NO es un visto bueno: es que no hay nada que medir todavía.');

      // ⛔ "No hay nada acá" y "no hay nada" no son lo mismo, y confundirlos es JUSTO el modo
      // de fallo que esta compuerta existe para cerrar: si el CEDIS entra con otro código de
      // sucursal —o como otro almacén `c1` dentro de la misma, como la ruta '01-006' dentro
      // de '01'— este script diría NO MEDIDO para siempre y se leería como "todavía no pasó".
      // Así que antes de rendirse, BARRE TODO y muestra lo que encuentre.
      // El barrido CLASIFICA; no le pasa una lista cruda al humano para que la revise él.
      // Dos hechos alcanzan para decidir cada fila sin preguntarle a nadie:
      //   · si la sucursal YA está mapeada en commercial.warehouses, no puede ser el CEDIS
      //     entrando (ese almacén ya tiene dueño);
      //   · una CARGA INICIAL tiene firma propia — captura ≈ entrada línea por línea y peso
      //     por peso, y faltante $0 — mientras que un conteo trimestral tiene la entrada MUY
      //     por debajo de la captura. Es lo que distingue a Morelia (08) de los trimestrales.
      console.log('\n── Barrido: ¿el CEDIS entró con otro código? ──');
      const otras = await q(
        `WITH docs AS (
           SELECT m.sucursal, m.c1 AS almacen, m.c9::date AS f, m.c4 AS doctype,
                  count(l.*)::int AS lineas, sum(l.c13::numeric) AS pesos
             FROM kepler_ods.kdm1 m
             JOIN kepler_ods.kdm2 l
               ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
              AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
            WHERE m.c2='N' AND m.c3='A' AND m.c4 IN ('45','30')
              AND m.c9 >= current_date - 15 AND m.c9 <= current_date
            GROUP BY 1,2,3,4)
         SELECT d.sucursal, d.almacen, to_char(d.f,'YYYY-MM-DD') AS fecha,
                max(d.lineas) FILTER (WHERE d.doctype='45') AS cap_lineas,
                round(max(d.pesos) FILTER (WHERE d.doctype='45'),2) AS cap_pesos,
                max(d.lineas) FILTER (WHERE d.doctype='30') AS ent_lineas,
                EXISTS (SELECT 1 FROM commercial.warehouses w
                         WHERE w.kepler_code = d.sucursal AND w.deleted_at IS NULL) AS ya_mapeada,
                EXISTS (SELECT 1 FROM commercial.warehouses w
                         WHERE w.kepler_code = d.sucursal AND w.code = $1
                           AND w.deleted_at IS NULL) AS es_el_cedis
           FROM docs d GROUP BY 1,2,3 ORDER BY 3 DESC, 1, 2 LIMIT 25`, [CEDIS_CODE]);

      // ⚠️ El criterio NO es "está mapeada" sino "está mapeada a un almacén que NO es el
      // CEDIS". Una sucursal mapeada a OTRO warehouse ya tiene dueño y no puede ser el CEDIS
      // entrando; pero si alguien mapeara el CEDIS a un código nuevo antes de la carga, el
      // filtro ingenuo la descartaría justo por haber hecho bien el paso 3 del checklist.
      const candidatas = otras.filter((o) => !o.ya_mapeada || o.es_el_cedis);
      // Firma de carga inicial: la entrada replica la captura (±1 línea).
      const marca = (o) => (o.cap_lineas && o.ent_lineas
        && Math.abs(o.cap_lineas - o.ent_lineas) <= 1) ? 'CARGA INICIAL' : 'conteo';

      // Se lista el detalle SOLO si hay algo que revisar. Imprimir cuatro conteos
      // trimestrales ajenos todos los días, para terminar diciendo que ninguno importa, es
      // hacerle leer al humano lo que el script ya decidió.
      if (!otras.length) {
        console.log('   ✔ no hay cargas ni conteos en ninguna sucursal en 15 días.');
      } else if (!candidatas.length) {
        const cargas = otras.filter((o) => marca(o) === 'CARGA INICIAL').length;
        console.log(`   revisadas ${otras.length} (${cargas} con firma de carga, ${otras.length - cargas} conteos)`
          + ' — todas en sucursales que ya tienen dueño.');
      } else {
        console.log('   suc  almacén   fecha       captura  entrada  tipo           veredicto');
        for (const o of otras) {
          const tipo = marca(o);
          const cand = (!o.ya_mapeada || o.es_el_cedis)
            ? (tipo === 'CARGA INICIAL' ? '⛔ REVISAR' : 'no — es un conteo')
            : `no — ya es de ${o.sucursal}`;
          console.log(`   ${String(o.sucursal).padEnd(4)} ${String(o.almacen).padEnd(9)}`
            + ` ${o.fecha}  ${String(num(o.cap_lineas || 0)).padStart(7)}`
            + ` ${String(num(o.ent_lineas || 0)).padStart(8)}`
            + `  ${tipo.padEnd(14)} ${cand}`);
        }
      }

      if (!candidatas.length) {
        console.log('\n   ✔ VEREDICTO: ninguna es el CEDIS. Todas las sucursales con actividad ya');
        console.log('     están mapeadas en commercial.warehouses, así que ya tienen dueño.');
        console.log('     El cutover del CEDIS no ha ocurrido. Volver a correr el día D.');
      } else {
        alarmas++;
        console.log(`\n   ⛔ VEREDICTO: ${candidatas.length} sucursal(es) SIN mapear con actividad —`);
        console.log('     alguna podría ser el CEDIS entrando por otro lado. Volvé a correr con:');
        for (const c of candidatas) {
          console.log(`       CEDIS_KEPLER_SUCURSAL=${c.sucursal} node database/scripts/check-cedis-cutover.js`);
        }
      }

      // Y la otra mitad de la pregunta: ¿la sucursal destino ya existe en el ODS?
      const [existe] = await q(
        `SELECT count(*)::int AS filas,
                round(sum(GREATEST(c4::numeric + c8::numeric - c9::numeric,0)),0) AS saldo
           FROM kepler_ods.kdil WHERE sucursal=$1 AND c1=$1`, [KEP_SUC]);
      console.log(`\n   Estado de la sucursal '${KEP_SUC}' en el ODS hoy:`
        + ` ${num(existe.filas)} SKUs, saldo ${num(existe.saldo)} u`);
      console.log('   (ése es el saldo PREVIO contra el que se va a comparar el día D — punto 2)');
      console.log('');
      await db.end();
      process.exit(0);
    }

    console.log('── Documentos encontrados ──');
    for (const c of cargas) {
      console.log(`   ${c.fecha}  almacén ${String(c.almacen).padEnd(8)} N-A-${c.doctype} folio ${c.folio}`
        + `  ${num(c.lineas)} líneas · ${money(c.pesos)} · ${num(c.unidades)} u`);
    }

    // ⛔ UN DOCUMENTO NO ES UNA CARGA POR ESTAR DENTRO DE LA VENTANA.
    // La primera versión tomaba lo que hubiera en 30 días y lo trataba como la carga inicial.
    // Medido contra la sucursal 06: su carga fue el 2026-08-14 —fuera de la ventana— así que
    // el script agarró su CONTEO TRIMESTRAL del 09-04 y publicó "546 SKUs no llegaron (3.6%)"
    // como si fuera cobertura de migración. La cifra real de esa migración es 327 (0.9%).
    // El número no estaba mal: estaba midiendo OTRA COSA y no lo decía.
    // Se identifica por FIRMA, no por fecha: en una carga inicial la entrada replica la
    // captura (±1 línea) porque no hay teórico previo contra el cual descuadrar.
    // La clave es (almacén, fecha) — el eje almacén es parte de la identidad del documento.
    const porDoc = new Map();
    for (const c of cargas) {
      const k = `${c.fecha}|${c.almacen}`;
      if (!porDoc.has(k)) porDoc.set(k, {});
      porDoc.get(k)[c.doctype] = c;
    }
    let cap = null, ent = null, esCargaInicial = false, fechaElegida = null, almElegido = null;
    for (const [k, par] of [...porDoc.entries()].sort().reverse()) {
      const firma = par['45'] && par['30'] && Math.abs(par['45'].lineas - par['30'].lineas) <= 1;
      if (firma) {
        cap = par['45']; ent = par['30']; esCargaInicial = true;
        [fechaElegida, almElegido] = k.split('|');
        break;
      }
    }
    if (!cap) {  // no hay carga inicial: se usa lo más reciente, DECLARÁNDOLO
      const [k, par] = [...porDoc.entries()].sort().reverse()[0];
      cap = par['45'] || null; ent = par['30'] || null;
      [fechaElegida, almElegido] = k.split('|');
    }

    console.log(`\n   → documento analizado: ${fechaElegida}`);
    if (FECHA && fechaElegida !== FECHA) {
      const dias = Math.round((new Date(FECHA) - new Date(fechaElegida)) / 86400000);
      console.log(`     ⓘ pediste ${FECHA} y se usó ${fechaElegida} (${dias} día(s) antes).`);
      console.log('       La fecha de CARGA no es la de CORTE: en las tres migraciones medidas');
      console.log('       la carga cae el día ANTERIOR al cutover_date del resolvedor.');
    }
    if (esCargaInicial) {
      console.log('     firma de CARGA INICIAL (la entrada replica la captura) ✔');
    } else {
      console.log('     ⚠️ NO tiene firma de carga inicial: parece un CONTEO (la entrada está');
      console.log('        muy por debajo de la captura). Los bloques 1 y 3 de abajo miden');
      console.log('        contra ESE documento, así que NO son cobertura de migración.');
      console.log('        Si la carga de esta sucursal es más vieja que la ventana, pasá --fecha.');
    }

    // ── 0b. ⛔ ¿La sucursal ARRANCÓ DE CERO? ──────────────────────────────────
    // [IC.CEDIS.3 2026-10-01] EL SUPUESTO QUE SE ROMPIÓ, y que teñía dos bloques.
    //
    // Esta compuerta se escribió mirando a `06`, `07` y `08`: sucursales que llegaron a Kepler
    // con una CARGA INICIAL, desde cero. Con ese molde, "lo que no está en la carga no está en
    // el almacén" es cierto, y los bloques 1 y 2(b) lo dan por hecho.
    //
    // El CEDIS lo rompió: la sucursal `00` lleva **~10 meses operando en Kepler** —10 a 18 mil
    // documentos por mes desde dic-2025, con compras `X-A-15`, pagos `X-D-26`, traspasos
    // `U-D-13` y embarques `U-D-41`— y su N-A-45 del 30-sep fue un conteo PARCIAL de 127 SKUs,
    // no su migración. Medido el 2026-10-01, con el molde viejo la compuerta publicó:
    //   · «11,841,613 u de saldo sin explicar» → son 4,653 SKUs de mercancía real (SKWINKLES,
    //     KINDER, COCA COLA), o sea diez meses de operación;
    //   · «104 SKUs no llegaron, $516,534» → contra el ALMACÉN son 13 sin fila + 3 en cero =
    //     **$93,316**. Sobredeclaraba **5.5×**.
    //
    // Las dos salen de la misma confusión: preguntar «¿entró en la carga?» cuando lo que
    // decide es «¿está en el almacén?». Este bloque mide el supuesto en vez de asumirlo.
    const [prev] = await q(
      `SELECT count(*)::int AS docs,
              count(DISTINCT to_char(c9,'YYYY-MM'))::int AS meses,
              to_char(min(c9),'YYYY-MM-DD') AS desde
         FROM kepler_ods.kdm1
        WHERE sucursal=$1 AND c9::date < $2::date
          AND c9::date >= $2::date - 400`, [KEP_SUC, fechaElegida]);
    const [conSaldo] = await q(
      `SELECT count(*) FILTER (WHERE GREATEST(c4::numeric + c8::numeric - c9::numeric,0) > 0)::int AS skus
         FROM kepler_ods.kdil
        WHERE sucursal=$1 AND c1=$2 AND c3 <> ALL($3::text[])`, [KEP_SUC, almElegido, PSEUDO]);

    const operabaAntes = Number(prev && prev.docs) > 0;
    console.log('\n── 0b. ¿La sucursal arrancó de cero? ──');
    if (operabaAntes) {
      console.log(`   ⛔ NO: ya operaba en Kepler — ${num(prev.docs)} documentos en ${num(prev.meses)} mes(es),`
        + ` desde ${prev.desde}`);
      console.log(`   SKUs con saldo propio hoy : ${num(conSaldo.skus)}`);
      console.log('   → la CARGA no es la migración del almacén, es un movimiento más. Los bloques 1');
      console.log('     y 2(b) comparan contra la carga, así que acá pierden sentido: se reportan');
      console.log('     como CONTEXTO, no como alarma. El veredicto de cobertura lo da el bloque 3,');
      console.log('     que mide contra el ALMACÉN.');
    } else {
      console.log('   ✔ sí: no hay documentos previos → la carga ES la migración, y comparar');
      console.log('     contra ella es legítimo (el molde de 06, 07 y 08).');
    }

    // ── 1. La captura y la entrada tienen que cuadrar entre sí ───────────────
    console.log('\n── 1. ¿La carga cuadra consigo misma? ──');
    if (cap && ent) {
      // ⚠️ LÍNEAS y PESOS no son la misma alarma, y mezclarlos hace gritar al script por lo
      // que no es. Medido en la carga de 06: las líneas cuadran exacto (Δ 0) y los pesos
      // difieren $63,835 sobre $11.9M (0.54%) — eso es redondeo de costo entre los dos
      // documentos, no mercancía que no entró. Lo que sí dejó 1,964 líneas afuera en Padre
      // Hidalgo fue un descuadre DE LÍNEAS.
      const dLin = cap.lineas - ent.lineas;
      const dPes = Number(cap.pesos) - Number(ent.pesos);
      const pctPes = Number(cap.pesos) !== 0 ? Math.abs(100 * dPes / Number(cap.pesos)) : 0;
      console.log(`   captura ${num(cap.lineas)} líneas / ${money(cap.pesos)}`
        + `   ·   entrada ${num(ent.lineas)} líneas / ${money(ent.pesos)}`);

      if (Math.abs(dLin) <= 1) {
        console.log(`   ✔ LÍNEAS cuadran (Δ ${dLin}) — todo lo capturado tiene su entrada`);
      } else {
        alarmas++;
        console.log(`   ⛔ LÍNEAS NO cuadran: Δ ${num(dLin)} — hay capturas sin entrada.`);
        console.log('      Es lo que en Padre Hidalgo dejó 1,964 líneas afuera.');
      }
      if (pctPes < 1) {
        console.log(`   ✔ PESOS dentro de tolerancia (Δ ${money(dPes)}, ${pctPes.toFixed(2)}%)`
          + ' — diferencia de redondeo de costo, no de mercancía');
      } else {
        alarmas++;
        console.log(`   ⛔ PESOS descuadran ${pctPes.toFixed(2)}% (Δ ${money(dPes)})`
          + ' — demasiado para ser redondeo; revisar costos de la carga');
      }

      // ⛔ DIMENSIONAMIENTO — lo que la consistencia interna NO puede ver.
      // Un documento puede cuadrar consigo mismo y estar mal dimensionado: la carga de la
      // ruta 01-006 de Padre Hidalgo trae 324 líneas y cuadra PERFECTO (captura 324 ==
      // entrada 324, Δ $0), mientras Wincaja `10` tenía 2,963 SKUs con existencia. Cuadrar
      // consigo mismo no dice nada sobre el alcance. (Encontrado por [AUD-DAT.11].)
      const [orig] = await q(
        `SELECT count(*)::int AS skus FROM wincaja.v_stock
          WHERE source_branch=$1 AND existencia > 0 AND in_kepler_catalog`, [WIN_BRANCH]);
      if (Number(orig.skus) > 0) {
        const cob = 100 * cap.lineas / Number(orig.skus);
        console.log(`   dimensionamiento      : ${num(cap.lineas)} líneas cargadas`
          + ` contra ${num(orig.skus)} SKUs con existencia en Wincaja ${WIN_BRANCH}`
          + ` (${cob.toFixed(0)}%)`);
        if (cob < 70 && operabaAntes) {
          // [IC.CEDIS.3] NO es alarma acá: la carga no pretende cubrir el almacén, porque el
          // almacén ya existía. Comparar un conteo parcial contra todo Wincaja sólo mide que
          // son cosas distintas. La cobertura real la decide el bloque 3, contra el saldo.
          console.log('   ⓘ la carga es más chica que el inventario de origen, y acá eso NO es');
          console.log('     hallazgo: la sucursal ya operaba, así que este documento es un conteo');
          console.log('     parcial, no la migración. La cobertura se juzga en el bloque 3.');
        } else if (cob < 70) {
          alarmas++;
          console.log('   ⛔ ALARMA: la carga es MUCHO más chica que el inventario de origen.');
          console.log('      Cuadra consigo misma pero deja fuera la mayor parte del almacén.');
          console.log('      Es lo que le pasó a Padre Hidalgo: cargó una ruta y no el almacén.');
        } else {
          console.log('   ✔ el tamaño de la carga es del orden del inventario de origen');
        }
      } else {
        console.log(`   ⚠️ NO MEDIDO el dimensionamiento: Wincaja ${WIN_BRANCH} no tiene SKUs`
          + ' con existencia contra los cuales comparar');
      }
    } else {
      console.log(`   ⚠️  NO MEDIDO: falta ${cap ? 'la entrada N-A-30' : 'la captura N-A-45'}.`);
    }

    // ── 2. ⛔ ¿Reemplazó el saldo previo, o se sumó? ──────────────────────────
    console.log('\n── 2. ⛔ Saldo de arranque: ¿reemplazó o SUMÓ? ──');
    const [saldo] = await q(
      `SELECT round(sum(GREATEST(c4::numeric + c8::numeric - c9::numeric, 0)),2) AS total,
              round(sum(GREATEST(c4::numeric + c8::numeric - c9::numeric, 0))
                    FILTER (WHERE c3 <> ALL($2::text[])),2) AS sin_pseudo,
              count(*)::int AS skus
         FROM kepler_ods.kdil WHERE sucursal=$1 AND c1=$1`,
      [KEP_SUC, PSEUDO]);

    console.log(`   saldo actual en kdil  : ${num(saldo.total)} u  (sin pseudo-SKUs: ${num(saldo.sin_pseudo)} u, ${num(saldo.skus)} SKUs)`);
    if (cap) {
      console.log(`   lo que se capturó     : ${num(cap.unidades)} u`);
      const exceso = Number(saldo.sin_pseudo) - Number(cap.unidades);
      const razon = Number(cap.unidades) > 0 ? Number(saldo.sin_pseudo) / Number(cap.unidades) : null;
      console.log(`   diferencia            : ${num(exceso)} u  (razón ${razon ? razon.toFixed(2) : '—'}×)`);

      // ── La prueba DIRECTA, SKU por SKU ────────────────────────────────────────────────────
      // ⛔ La razón de arriba NO puede distinguir las dos cosas que la hacen grande, y se leen
      // igual aunque pidan acciones opuestas:
      //   (a) la carga se SUMÓ encima de SKUs que ya tenían saldo  → se corrige el documento;
      //   (b) el almacén ya traía saldo de OTROS SKUs, ajeno a la carga → se investiga el saldo.
      // Medido el 2026-09-30 en el CEDIS: razón 35.82× y, sin embargo, **los 127 SKUs cargados
      // estaban TODOS en cero antes de la entrada** — o sea (b), no (a). El diagnóstico que
      // imprimía esta compuerta ("la carga parece haberse SUMADO") mandaba a corregir en Kepler
      // un documento que está bien, y se citó como fundamento en la migración del cutover.
      // Un almacén que ya opera dispara esa razón SIEMPRE: dar de alta 127 SKUs nuevos en uno
      // que arrastra 5,019 no es sumar, es dar de alta.
      const [dir] = await q(
        `WITH carga AS (
           SELECT l.c8 AS sku, sum(l.c9::numeric) AS u
             FROM kepler_ods.kdm1 m
             JOIN kepler_ods.kdm2 l
               ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
              AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
            WHERE m.sucursal=$1 AND m.c1=$3 AND m.c2='N' AND m.c3='A' AND m.c4='30'
              AND m.c9::date = $2::date
            GROUP BY 1)
         SELECT count(*)::int AS skus,
                count(*) FILTER (WHERE s.previo > 0.01)::int AS con_saldo_previo,
                round(sum(GREATEST(s.previo,0)),2) AS u_previas
           FROM carga c
           LEFT JOIN LATERAL (
             SELECT GREATEST(l.c4::numeric + l.c8::numeric - l.c9::numeric,0) - c.u AS previo
               FROM kepler_ods.kdil l
              WHERE l.sucursal=$1 AND l.c1=$3 AND l.c3 = c.sku) s ON true`,
        [KEP_SUC, fechaElegida, almElegido]);

      if (!dir || !Number(dir.skus)) {
        console.log('   ⚠️ NO MEDIDO (a): no se pudieron recuperar los SKUs de la entrada N-A-30.');
        console.log('      No es un visto bueno: la prueba directa no corrió.');
      } else if (Number(dir.con_saldo_previo) > 0) {
        alarmas++;
        console.log(`   ⛔ ALARMA (a): ${num(dir.con_saldo_previo)} de ${num(dir.skus)} SKUs cargados YA tenían`);
        console.log(`      saldo antes de la entrada (${num(dir.u_previas)} u) → la carga se SUMÓ encima.`);
        console.log('      Hay que corregir el documento en Kepler ANTES de que el almacén se mueva.');
      } else {
        console.log(`   ✔ los ${num(dir.skus)} SKUs cargados estaban en CERO antes de la entrada:`);
        console.log('     la carga NO se sumó a nada. El documento está bien.');
      }

      // El saldo ajeno a la carga se reporta aparte, porque es OTRA pregunta y otro dueño.
      if (razon != null && razon > 1.5 && operabaAntes) {
        // [IC.CEDIS.3] El arrastre está EXPLICADO: la sucursal venía operando. Declararlo
        // «sin explicar» mandaba a investigar diez meses de inventario legítimo — y, peor,
        // a NO apuntar la existencia a Kepler, que es justo lo contrario de lo que toca.
        console.log(`   ⓘ el almacén trae ${num(exceso)} u que no vienen de esta carga, y están`);
        console.log(`     EXPLICADAS: la sucursal opera en Kepler desde ${prev.desde}. No es arrastre`);
        console.log('     ajeno, es su inventario. (Si algún día no operara antes, esto sería alarma.)');
      } else if (razon != null && razon > 1.5) {
        alarmas++;
        console.log(`   ⛔ ALARMA (b): el almacén arrastra ${num(exceso)} u de saldo que NO vienen de esta`);
        console.log('      carga. Mientras no se establezca de dónde salen, NO apuntar la existencia');
        console.log('      de este almacén a Kepler: publicaría ese arrastre como inventario real.');
      } else if (razon != null) {
        console.log('   ✔ el saldo es del orden de lo capturado → el almacén no arrastra saldo ajeno');
      }
      console.log('   ⚠️ (b) es una señal por ORDEN DE MAGNITUD: entre la captura y esta medición hay');
      console.log('      movimientos reales. (a) sí es una prueba directa, SKU por SKU.');
    }

    // ── 3. Cobertura: qué NO llegó desde Wincaja ─────────────────────────────
    console.log('\n── 3. Cobertura: ¿qué SKUs de Wincaja NO llegaron? ──');
    // Se mide contra el documento ELEGIDO por firma (misma fecha), no contra "lo que haya en
    // 30 días" — ver el comentario del bloque 0.
    const [cob] = await q(
      `WITH carga AS (
         SELECT DISTINCT l.c8 AS sku
           FROM kepler_ods.kdm1 m
           JOIN kepler_ods.kdm2 l
             ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
            AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
          WHERE m.sucursal=$1 AND m.c1=$4 AND m.c2='N' AND m.c3='A' AND m.c4='45'
            AND m.c9::date = $3::date),
       saldo AS (
         SELECT c3 AS sku, sum(GREATEST(c4::numeric + c8::numeric - c9::numeric, 0)) AS u
           FROM kepler_ods.kdil
          WHERE sucursal=$1 AND c1=$4
          GROUP BY c3)
       SELECT count(*)::int AS origen,
              count(*) FILTER (WHERE s.u > 0)::int AS en_almacen,
              count(*) FILTER (WHERE s.sku IS NULL)::int AS sin_fila,
              count(*) FILTER (WHERE s.sku IS NOT NULL AND s.u <= 0)::int AS en_cero,
              round(sum(w.valor_inventario) FILTER (WHERE s.sku IS NULL OR s.u <= 0),2) AS pesos_faltan,
              round(sum(w.valor_inventario),2) AS pesos_total,
              count(*) FILTER (WHERE w.sku IN (SELECT sku FROM carga))::int AS en_la_carga
         FROM wincaja.v_stock w
         LEFT JOIN saldo s ON s.sku = w.sku
        WHERE w.source_branch=$2 AND w.existencia > 0 AND w.in_kepler_catalog`,
      [KEP_SUC, WIN_BRANCH, fechaElegida, almElegido]);

    // [IC.CEDIS.3] SE MIDE CONTRA EL ALMACÉN, NO CONTRA LA CARGA. La pregunta operativa es
    // «¿el CEDIS tiene este SKU en Kepler?», y un SKU puede estar ahí sin haber pasado por el
    // documento del cutover: por una compra, un traspaso o —como el CEDIS— por diez meses de
    // operación previa. Medir contra la carga convertía todo eso en «no llegó».
    // Verificado el 2026-10-01 cruzando a mano la existencia de Wincaja contra `kdil`:
    // 215 de 231 ya tenían saldo; lo que falta de verdad son 13 sin fila + 3 en cero.
    const faltan = Number(cob.sin_fila) + Number(cob.en_cero);
    const pct = Number(cob.pesos_total) > 0 ? (100 * Number(cob.pesos_faltan) / Number(cob.pesos_total)) : 0;
    console.log(`   SKUs con existencia en Wincaja ${WIN_BRANCH}: ${num(cob.origen)}`);
    console.log(`   de ésos, en el ALMACÉN Kepler ${KEP_SUC}/${almElegido}:`);
    console.log(`     con saldo > 0 : ${num(cob.en_almacen)}`);
    console.log(`     fila en CERO  : ${num(cob.en_cero)}`);
    console.log(`     sin fila      : ${num(cob.sin_fila)}`);
    console.log(`   falta de verdad : ${num(faltan)} SKUs · ${money(cob.pesos_faltan)}`
      + ` de ${money(cob.pesos_total)} (${pct.toFixed(1)}%)`);
    console.log(`   ⓘ contexto: ${num(cob.en_la_carga)} de los ${num(cob.origen)} venían en la carga`
      + ` del ${fechaElegida} — dato del documento, NO el veredicto de cobertura`);
    // ⚠️ [IC.CEDIS.3] LAS DOS FORMAS DE FALTAR NO ENVEJECEN IGUAL, y por eso van separadas:
    //   · «sin fila»  → el SKU nunca existió en este almacén de Kepler. Es robusto: ningún
    //                   movimiento posterior borra la fila, así que sigue siendo un hueco
    //                   de migración por mucho que pase el tiempo.
    //   · «en cero»   → la fila está y el saldo quedó en 0. El día del cutover eso es «no
    //                   cargó»; dos semanas después puede ser sencillamente «se vendió».
    // Medido en la `08` el 2026-10-01, 12 días después de su corte: 455 sin fila contra 370
    // en cero. Juntarlas en un solo número haría pasar ventas normales por huecos.
    if (Number(cob.en_cero) > 0) {
      console.log(`   ⚠️ de los ${num(faltan)}, ${num(cob.en_cero)} están «en cero»: eso es hueco el día del`);
      console.log('      cutover, pero pasado un tiempo puede ser venta. Los que no admiten otra');
      console.log(`      lectura son los ${num(cob.sin_fila)} «sin fila».`);
    }

    // ⚠️ La existencia de Wincaja es la foto de HOY de una réplica congelada, no la del día
    // de la carga. Cuanto más vieja la carga, menos vale la comparación: para una migración
    // reciente es casi exacta; a tres meses ya hay otra historia en el medio. Se DECLARA en
    // vez de dejar que el % se lea con la misma confianza en los dos casos. ([AUD-DAT.11])
    const [fw] = await q(
      `SELECT to_char(max(fecha),'YYYY-MM-DD') AS ultimo,
              (current_date - max(fecha)::date) AS dias
         FROM wincaja.maestro_mov_almacen
        WHERE source_branch=$1 AND fecha <= current_date`, [WIN_BRANCH]);
    if (fw && fw.ultimo) {
      const desfase = Math.abs(Math.round((new Date(fw.ultimo) - new Date(fechaElegida)) / 86400000));
      console.log(`   ⓘ la foto de Wincaja ${WIN_BRANCH} es del ${fw.ultimo}`
        + ` y la carga del ${fechaElegida} → ${desfase} día(s) de desfase`);
      if (desfase > 21) {
        console.log('     ⚠️ desfase grande: este % es ORIENTATIVO, no cobertura exacta de la');
        console.log('        migración — entre una fecha y otra hubo movimientos reales.');
      }
    }
    if (faltan > 0) {
      alarmas++;
      console.log('   ⛔ Hay SKUs con existencia en Wincaja, presentes en el catálogo de Kepler,');
      console.log('      que NO están en el almacén de Kepler. Eso sí es un hueco: en cuanto el');
      console.log('      almacén se mueva, deja de poder distinguirse de una venta.');
      // ⚠️ [IC.CEDIS.3] NO se reimprime acá la referencia de 06/07/08 (327/435/583). Esas tres
      // cifras se midieron CONTRA LA CARGA, que es la métrica que este bloque acaba de dejar de
      // usar: ponerlas al lado del número nuevo invita a compararlas, y no son conmensurables.
      // Para tenerlas en la misma unidad hay que re-correr la compuerta sobre cada sucursal.
      console.log('      Lista completa abajo, con CÓMO falta cada uno.');
      // [IC.CEDIS.3] La lista también sale del ALMACÉN, y dice CÓMO falta cada uno: «sin fila»
      // (el SKU nunca existió en este almacén de Kepler) no es lo mismo que «en cero» (la fila
      // está y el saldo se consumió), y piden cosas distintas. Mezclarlas era parte del ruido.
      const det = await q(
        // ⚠️ Tres parámetros, no cuatro: esta consulta ya no mira el documento, así que la
        // fecha sobra. Un `$n` que se pasa y no se usa no es inocuo — pg no puede inferir su
        // tipo y revienta con «could not determine data type of parameter».
        `WITH saldo AS (
           SELECT c3 AS sku, sum(GREATEST(c4::numeric + c8::numeric - c9::numeric, 0)) AS u
             FROM kepler_ods.kdil
            WHERE sucursal=$1 AND c1=$3
            GROUP BY c3)
         SELECT w.sku, round(w.existencia::numeric,2) AS existencia,
                round(w.valor_inventario::numeric,2) AS valor,
                CASE WHEN s.sku IS NULL THEN 'sin fila' ELSE 'en cero' END AS como
           FROM wincaja.v_stock w
           LEFT JOIN saldo s ON s.sku = w.sku
          WHERE w.source_branch=$2 AND w.existencia > 0 AND w.in_kepler_catalog
            AND (s.sku IS NULL OR s.u <= 0)
          ORDER BY w.valor_inventario DESC NULLS LAST ${CSV ? '' : 'LIMIT 40'}`,
        [KEP_SUC, WIN_BRANCH, almElegido]);
      if (CSV) {
        console.log(`\n--- CSV: ${det.length} SKU(s) con existencia en Wincaja ${WIN_BRANCH} que NO entraron ---`);
        console.log('sku,existencia,valor,como');
        for (const r of det) console.log(`${r.sku},${r.existencia},${r.valor},${r.como}`);
        console.log('--- fin CSV ---');
      } else {
        console.log('\n   SKU      existencia        valor   cómo falta');
        for (const r of det) {
          console.log(`   ${String(r.sku).padEnd(8)} ${String(num(r.existencia)).padStart(10)}  ${String(money(r.valor)).padStart(12)}   ${r.como}`);
        }
        if (faltan > det.length) {
          console.log(`   … y ${num(faltan - det.length)} más — corré con --csv para la lista completa`);
        }
      }
    } else {
      console.log('   ✔ todo lo que Wincaja tenía con existencia llegó a Kepler');
    }

    // ── 4. Que el feed viejo no siga escribiendo ─────────────────────────────
    console.log('\n── 4. ¿El feed de Wincaja quedó retirado? ──');
    const [wh] = await q(
      `SELECT kepler_code FROM commercial.warehouses
        WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`, [TENANT, CEDIS_CODE]);
    const [vista] = await q(
      `SELECT to_char(cutover_date,'YYYY-MM-DD') AS d FROM analytics.v_branch_erp_cutover
        WHERE tenant_id=$1 AND wincaja_source_branch=$2`, [TENANT, WIN_BRANCH]);
    console.log(`   commercial.warehouses.kepler_code = ${wh && wh.kepler_code ? `'${wh.kepler_code}'` : 'NULL'}`);
    console.log(`   v_branch_erp_cutover              = ${vista ? vista.d : 'sin fila'}`);
    if (!(wh && wh.kepler_code) && !vista) {
      alarmas++;
      console.log('   ⛔ NINGUNA de las dos señales declara el cutover → el guard de los importers');
      console.log('      NO se va a apagar por la puerta A. Hoy lo frena la de frescura, pero eso');
      console.log('      es un accidente afortunado, no el diseño. Poner el paso 3 del checklist.');
    } else {
      console.log('   ✔ al menos una señal declara el cutover → el guard cierra la puerta A');
      if (!(wh && wh.kepler_code) || !vista) {
        console.log('   ⚠️ pero sólo UNA de las dos: dejarlas de acuerdo (FASE_IC §1.11c paso 3-4).');
      }
    }

    console.log(`\n════ ${alarmas === 0 ? '✔ sin alarmas' : `⛔ ${alarmas} alarma(s)`} ════\n`);
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
