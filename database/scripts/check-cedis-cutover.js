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
 *     Las tres migraciones anteriores dejaron fuera entre 327 y 583 SKUs cada una
 *     (1,345 en total, $516,521), todos presentes en el catálogo de Kepler.
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
      `SELECT m.c6 AS folio, to_char(m.c9,'YYYY-MM-DD') AS fecha, m.c4 AS doctype,
              count(l.*)::int AS lineas,
              round(sum(l.c13::numeric),2) AS pesos,
              round(sum(l.c9::numeric),2) AS unidades
         FROM kepler_ods.kdm1 m
         JOIN kepler_ods.kdm2 l
           ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
          AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
        WHERE m.sucursal=$1 AND m.c1=$1 AND m.c2='N' AND m.c3='A' AND m.c4 IN ('45','30')
          -- Una fecha explicita REEMPLAZA la ventana, no se le suma: con el AND de los 30
          -- dias, pedir la carga de una sucursal vieja (06, el 2026-08-14) devolvia cero y
          -- el script decia "la carga no ocurrio" sobre una migracion que si ocurrio.
          -- (Sin acentos ni backticks: esto vive dentro de un template literal.)
          AND ($2::date IS NOT NULL OR (m.c9 >= current_date - 30 AND m.c9 <= current_date))
          AND ($2::date IS NULL OR m.c9::date = $2::date)
        GROUP BY 1,2,3 ORDER BY 2, 3`,
      [KEP_SUC, FECHA]);

    if (!cargas.length) {
      console.log(`⚠️  NO MEDIDO: no hay documentos N-A-45/N-A-30 en la sucursal Kepler '${KEP_SUC}'`
        + ` (almacén '${KEP_SUC}')${FECHA ? ` con fecha ${FECHA}` : ' en los últimos 30 días'}.`);
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
                         WHERE w.kepler_code = d.sucursal AND w.deleted_at IS NULL) AS ya_mapeada
           FROM docs d GROUP BY 1,2,3 ORDER BY 3 DESC, 1, 2 LIMIT 25`, []);

      const candidatas = otras.filter((o) => !o.ya_mapeada);
      // Firma de carga inicial: la entrada replica la captura (±1 línea).
      const marca = (o) => (o.cap_lineas && o.ent_lineas
        && Math.abs(o.cap_lineas - o.ent_lineas) <= 1) ? 'CARGA INICIAL' : 'conteo';

      if (!otras.length) {
        console.log('   ✔ no hay cargas ni conteos en ninguna sucursal en 15 días.');
      } else {
        console.log('   suc almacén  fecha        captura      entrada  tipo           ¿candidata?');
        for (const o of otras) {
          const tipo = marca(o);
          const cand = o.ya_mapeada
            ? `no — ya es ${o.sucursal}`
            : (tipo === 'CARGA INICIAL' ? '⛔ SÍ — revisar' : 'no — es un conteo');
          console.log(`   ${String(o.sucursal).padEnd(3)} ${String(o.almacen).padEnd(8)}`
            + ` ${o.fecha}  ${String(num(o.cap_lineas || 0)).padStart(7)} líns`
            + ` ${String(num(o.ent_lineas || 0)).padStart(7)} líns`
            + `  ${tipo.padEnd(13)} ${cand}`);
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
      console.log(`   ${c.fecha}  N-A-${c.doctype} folio ${c.folio}`
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
    const porFecha = new Map();
    for (const c of cargas) {
      if (!porFecha.has(c.fecha)) porFecha.set(c.fecha, {});
      porFecha.get(c.fecha)[c.doctype] = c;
    }
    let cap = null, ent = null, esCargaInicial = false, fechaElegida = null;
    for (const [f, par] of [...porFecha.entries()].sort().reverse()) {
      const firma = par['45'] && par['30'] && Math.abs(par['45'].lineas - par['30'].lineas) <= 1;
      if (firma) { cap = par['45']; ent = par['30']; esCargaInicial = true; fechaElegida = f; break; }
    }
    if (!cap) {  // no hay carga inicial en la ventana: se usa lo más reciente, DECLARÁNDOLO
      const [f, par] = [...porFecha.entries()].sort().reverse()[0];
      cap = par['45'] || null; ent = par['30'] || null; fechaElegida = f;
    }

    console.log(`\n   → documento analizado: ${fechaElegida}`);
    if (esCargaInicial) {
      console.log('     firma de CARGA INICIAL (la entrada replica la captura) ✔');
    } else {
      console.log('     ⚠️ NO tiene firma de carga inicial: parece un CONTEO (la entrada está');
      console.log('        muy por debajo de la captura). Los bloques 1 y 3 de abajo miden');
      console.log('        contra ESE documento, así que NO son cobertura de migración.');
      console.log('        Si la carga de esta sucursal es más vieja que la ventana, pasá --fecha.');
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
      if (razon != null && razon > 1.5) {
        alarmas++;
        console.log('   ⛔ ALARMA: el saldo es MUY superior a lo capturado → la carga parece haberse');
        console.log('      SUMADO al saldo previo en vez de reemplazarlo. Hay que corregirlo en Kepler');
        console.log('      ANTES de que el CEDIS empiece a mover mercancía.');
      } else if (razon != null) {
        console.log('   ✔ el saldo es del orden de lo capturado → parece haber reemplazado');
      }
      console.log('   ⚠️ Es una señal por ORDEN DE MAGNITUD, no una prueba: entre la captura y esta');
      console.log('      medición hay movimientos reales. Sirve para detectar el error grande.');
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
          WHERE m.sucursal=$1 AND m.c1=$1 AND m.c2='N' AND m.c3='A' AND m.c4='45'
            AND m.c9::date = $3::date)
       SELECT count(*) FILTER (WHERE w.sku IN (SELECT sku FROM carga))::int AS cargados,
              count(*) FILTER (WHERE w.sku NOT IN (SELECT sku FROM carga))::int AS faltan,
              round(sum(w.valor_inventario) FILTER (WHERE w.sku NOT IN (SELECT sku FROM carga)),2) AS pesos_faltan,
              round(sum(w.valor_inventario),2) AS pesos_total
         FROM wincaja.v_stock w
        WHERE w.source_branch=$2 AND w.existencia > 0 AND w.in_kepler_catalog`,
      [KEP_SUC, WIN_BRANCH, fechaElegida]);

    const pct = Number(cob.pesos_total) > 0 ? (100 * Number(cob.pesos_faltan) / Number(cob.pesos_total)) : 0;
    console.log(`   cargados ${num(cob.cargados)}  ·  NO llegaron ${num(cob.faltan)}`
      + `  ·  ${money(cob.pesos_faltan)} de ${money(cob.pesos_total)} (${pct.toFixed(1)}%)`);
    if (Number(cob.faltan) > 0) {
      alarmas++;
      console.log('   ⛔ Hay SKUs con existencia en Wincaja, presentes en el catálogo de Kepler,');
      console.log('      que no entraron. Referencia (medida el 2026-09-28 contra la CARGA de cada una;');
      console.log('      una cifra escrita a mano envejece sin avisar): 06 → 327 (0.9%) · 07 → 435 (4.3%)');
      console.log('      · 08 → 583 (1.6%). Lista completa abajo.');
      const det = await q(
        `WITH carga AS (
           SELECT DISTINCT l.c8 AS sku
             FROM kepler_ods.kdm1 m
             JOIN kepler_ods.kdm2 l
               ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
              AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
            WHERE m.sucursal=$1 AND m.c1=$1 AND m.c2='N' AND m.c3='A' AND m.c4='45'
              AND m.c9::date = $3::date)
         SELECT w.sku, round(w.existencia::numeric,2) AS existencia,
                round(w.valor_inventario::numeric,2) AS valor
           FROM wincaja.v_stock w
          WHERE w.source_branch=$2 AND w.existencia > 0 AND w.in_kepler_catalog
            AND w.sku NOT IN (SELECT sku FROM carga)
          ORDER BY w.valor_inventario DESC NULLS LAST LIMIT 40`,
        [KEP_SUC, WIN_BRANCH]);
      console.log('\n   SKU      existencia        valor');
      for (const r of det) {
        console.log(`   ${String(r.sku).padEnd(8)} ${String(num(r.existencia)).padStart(10)}  ${String(money(r.valor)).padStart(12)}`);
      }
      if (Number(cob.faltan) > det.length) console.log(`   … y ${num(Number(cob.faltan) - det.length)} más`);
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
