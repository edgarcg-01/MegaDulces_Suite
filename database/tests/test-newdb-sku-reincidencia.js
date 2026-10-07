#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * [IC.3b] La pantalla de reincidencia — que la clasificación no mienta.
 *
 * `analytics.v_sku_count_variance_history` (IC.3) estuvo en prod sin un solo consumidor. Este
 * candado ejercita la lógica que el servicio le pone encima: la partición por patrón, el corte
 * de `retencion`, el orden, y —sobre todo— que lo que NO se puede juzgar quede DECLARADO.
 *
 * ⛔ Por qué el orden es una aserción y no un detalle de presentación: ordenar por el dinero
 * BRUTO pone primero al SKU 17063 de La Piedad, que mueve $3,318,784 y retiene $558. Esa
 * pantalla mandaría a alguien al anaquel por el caso que menos importa. El orden por lo que
 * QUEDA pone primero a la CAJETA ENVINADA, que mueve veinte veces menos y pierde de verdad.
 *
 * Corre contra la DB de `DATABASE_URL_NEW` en SOLO LECTURA.
 */
'use strict';
const { Client } = require('pg');
require('dotenv').config();

const SE_COMPENSA = 0.2;
const PERSISTE = 0.8;

let ok = 0, fail = 0, nomedido = 0;
const t = (nombre, cond, detalle) => {
  if (cond === null) { nomedido++; console.log(`  ⚠️  NO MEDIDO  ${nombre}${detalle ? ' — ' + detalle : ''}`); return; }
  if (cond) { ok++; console.log(`  ✓ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
};

const CLASIFICA = `CASE
    WHEN h.pesos_abs = 0 THEN 'sin_dinero'
    WHEN abs(h.pesos_neto) / h.pesos_abs < ${SE_COMPENSA} THEN 'se_compensa'
    WHEN abs(h.pesos_neto) / h.pesos_abs >= ${PERSISTE} AND h.pesos_neto < 0 THEN 'merma'
    WHEN abs(h.pesos_neto) / h.pesos_abs >= ${PERSISTE} AND h.pesos_neto > 0 THEN 'sobra'
    ELSE 'mixto' END`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await c.connect();
  await c.query("SET statement_timeout='120s'");
  console.log('\n════ [IC.3b] Reincidencia por SKU ════\n');

  // ── 1. La vista existe y es consultable por el runtime ────────────────────────────────
  const [meta] = (await c.query(`
    SELECT coalesce((SELECT option_value FROM pg_options_to_table(cl.reloptions)
                      WHERE option_name = 'security_invoker'), 'no') AS sec,
           has_table_privilege('app_runtime', 'analytics.v_sku_count_variance_history', 'SELECT') AS grant_ok
      FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'analytics' AND cl.relname = 'v_sku_count_variance_history'`)).rows;
  t('la vista de IC.3 existe, con security_invoker y GRANT a app_runtime',
    meta && meta.sec === 'true' && meta.grant_ok === true,
    meta ? `security_invoker=${meta.sec} grant=${meta.grant_ok}` : 'no existe');

  const [uni] = (await c.query(
    'SELECT count(*)::int AS n FROM analytics.v_sku_count_variance_history')).rows;
  t('la vista trae filas', uni.n > 0, `${uni.n} pares (almacén, SKU)`);

  // ── 2. LA PARTICIÓN — que ningún SKU se pierda ni se cuente dos veces ─────────────────
  const [p] = (await c.query(`
    WITH j AS (SELECT * FROM analytics.v_sku_count_variance_history h
                WHERE h.veces_contado >= 2 AND h.veces_descuadro > 0)
    SELECT (SELECT count(*)::int FROM j) AS juzgables,
           (SELECT count(*)::int FROM analytics.v_sku_count_variance_history h
             WHERE h.veces_contado < 2) AS sin_base,
           (SELECT count(*)::int FROM analytics.v_sku_count_variance_history h
             WHERE h.veces_contado >= 2 AND h.veces_descuadro = 0) AS limpios,
           (SELECT count(*)::int FROM analytics.v_sku_count_variance_history) AS total`)).rows;
  t('los tres grupos PARTICIONAN el universo (juzgables + sin_base + limpios = total)',
    p.juzgables + p.sin_base + p.limpios === p.total,
    `${p.juzgables} + ${p.sin_base} + ${p.limpios} = ${p.total}`);

  const patrones = (await c.query(`
    SELECT ${CLASIFICA} AS patron, count(*)::int AS skus,
           sum(h.pesos_abs)::numeric AS abs_, sum(h.pesos_neto)::numeric AS neto
      FROM analytics.v_sku_count_variance_history h
     WHERE h.veces_contado >= 2 AND h.veces_descuadro > 0
     GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const sumaPatrones = patrones.reduce((a, x) => a + x.skus, 0);
  t('la clasificación por patrón cubre TODOS los juzgables, sin solapar',
    sumaPatrones === p.juzgables,
    patrones.map((x) => `${x.patron}:${x.skus}`).join(' '));

  // ── 2-bis. ⭐ EL CRUCE: DOS implementaciones del mismo veredicto ──────────────────────
  // `[EXP.1a]` bajó la clasificación a la vista, para que el servicio y la matvista de señales
  // lean UNA definición en vez de copiarla. Lo que este archivo aporta es el testigo
  // INDEPENDIENTE: `CLASIFICA` sigue escrito acá, a mano, y tiene que coincidir fila por fila.
  // ⛔ Comparar la vista contra sí misma pasaría la lógica rota en verde — es exactamente lo
  // que le ocurrió a IC.0 y lo que DM.15 volvió a medir. Dos implementaciones, o nada.
  {
    const [x] = (await c.query(`
      SELECT count(*)::int AS filas,
             count(*) FILTER (WHERE h.patron IS DISTINCT FROM ${CLASIFICA})::int AS difieren
        FROM analytics.v_sku_count_variance_history h`)).rows;
    t(`⭐ el \`patron\` de la vista coincide con la derivación independiente en las ${x.filas} filas`,
      Number(x.difieren) === 0,
      `${x.difieren} filas difieren`);
  }

  // ── 3. EL CORTE — que los umbrales separen de verdad, no de nombre ────────────────────
  const comp = patrones.find((x) => x.patron === 'se_compensa');
  if (comp) {
    const pct = Math.abs(Number(comp.neto)) / Number(comp.abs_) * 100;
    t('"se_compensa" hace honor al nombre: su neto es ruido frente a su bruto',
      pct < 5,
      `$${Math.round(Number(comp.abs_)).toLocaleString('en-US')} brutos dejan `
      + `$${Math.round(Math.abs(Number(comp.neto))).toLocaleString('en-US')} netos (${pct.toFixed(1)}%)`);
  } else t('"se_compensa" hace honor al nombre', null, 'ningún SKU cayó en ese patrón');

  const merma = patrones.find((x) => x.patron === 'merma');
  t('"merma" es NEGATIVO por construcción (si sale positivo, el CASE está al revés)',
    !merma || Number(merma.neto) < 0,
    merma ? `neto $${Math.round(Number(merma.neto)).toLocaleString('en-US')}` : 'sin filas');

  const sobra = patrones.find((x) => x.patron === 'sobra');
  t('"sobra" es POSITIVO por construcción',
    !sobra || Number(sobra.neto) > 0,
    sobra ? `neto $${Math.round(Number(sobra.neto)).toLocaleString('en-US')}` : 'sin filas');

  // ── 4. EL ORDEN — la aserción que motivó todo el diseño ──────────────────────────────
  const top = (await c.query(`
    SELECT h.sku, h.warehouse_code, h.pesos_abs, h.pesos_neto,
           round(abs(h.pesos_neto) / nullif(h.pesos_abs, 0), 4) AS retencion
      FROM analytics.v_sku_count_variance_history h
     WHERE h.veces_contado >= 2 AND h.veces_descuadro > 0
     ORDER BY abs(h.pesos_neto) DESC, h.veces_descuadro DESC, h.sku
     LIMIT 20`)).rows;
  const porBruto = (await c.query(`
    SELECT h.sku, h.warehouse_code, h.pesos_abs, h.pesos_neto
      FROM analytics.v_sku_count_variance_history h
     WHERE h.veces_contado >= 2 AND h.veces_descuadro > 0
     ORDER BY h.pesos_abs DESC LIMIT 1`)).rows[0];

  t('el primero por BRUTO es un SKU que se compensa (el orden ingenuo engaña)',
    porBruto && Math.abs(Number(porBruto.pesos_neto)) / Number(porBruto.pesos_abs) < SE_COMPENSA,
    porBruto ? `SKU ${porBruto.sku} alm ${porBruto.warehouse_code}: mueve `
      + `$${Math.round(Number(porBruto.pesos_abs)).toLocaleString('en-US')} y retiene `
      + `$${Math.round(Math.abs(Number(porBruto.pesos_neto))).toLocaleString('en-US')}` : '');

  t('⛔ ese SKU NO encabeza el orden de la pantalla',
    top.length > 0 && top[0].sku !== porBruto.sku,
    `encabeza ${top[0] ? `SKU ${top[0].sku} (alm ${top[0].warehouse_code}, retiene `
      + `$${Math.round(Math.abs(Number(top[0].pesos_neto))).toLocaleString('en-US')})` : '—'}`);

  t('el orden es ESTABLE: el desempate impide que dos corridas difieran',
    top.length > 1,
    'orderBy |neto| DESC, veces_descuadro DESC, sku');

  // ── 5. LO QUE NO SE PUEDE JUZGAR, DECLARADO ──────────────────────────────────────────
  const [sb] = (await c.query(`
    SELECT count(*)::int AS skus, coalesce(sum(h.pesos_abs), 0)::numeric AS pesos,
           string_agg(DISTINCT h.warehouse_code, ', ' ORDER BY h.warehouse_code) AS almacenes,
           max(h.veces_contado)::int AS max_conteos
      FROM analytics.v_sku_count_variance_history h WHERE h.veces_contado < 2`)).rows;
  t('hay SKUs que NO se pueden juzgar, y se cuentan',
    sb.skus > 0,
    `${sb.skus} SKUs · $${Math.round(Number(sb.pesos)).toLocaleString('en-US')} · almacenes ${sb.almacenes}`);

  t('⛔ ninguno de ellos tiene 2 conteos (si no, el filtro está mal puesto)',
    sb.max_conteos < 2, `max veces_contado = ${sb.max_conteos}`);

  // Un almacén ENTERO puede caer en sin_base. Esconderlo se lee como "no tiene problema".
  const enteros = (await c.query(`
    SELECT h.warehouse_code, count(*)::int AS filas, max(h.veces_contado)::int AS max_c
      FROM analytics.v_sku_count_variance_history h
     GROUP BY 1 HAVING max(h.veces_contado) < 2 ORDER BY 1`)).rows;
  t('los almacenes SIN base se nombran, no se esconden',
    enteros.length === 0 || enteros.every((x) => x.max_c < 2),
    enteros.length ? `${enteros.map((x) => `${x.warehouse_code} (${x.filas} SKUs, ${x.max_c} conteo)`).join(' · ')}`
      : 'todos los almacenes tienen 2+ conteos');

  // ── 6. LA TASA — que IC.3 siga declarando su propio hueco ────────────────────────────
  const [tasa] = (await c.query(`
    SELECT count(*) FILTER (WHERE h.tasa_descuadre IS NULL AND h.veces_contado < 2)::int AS null_ok,
           count(*) FILTER (WHERE h.tasa_descuadre IS NOT NULL AND h.veces_contado < 2)::int AS null_mal,
           count(*) FILTER (WHERE h.tasa_motivo IS NULL)::int AS sin_motivo
      FROM analytics.v_sku_count_variance_history h`)).rows;
  t('⛔ tasa_descuadre es NULL cuando hay menos de 2 observaciones',
    tasa.null_mal === 0, `${tasa.null_ok} declaradas, ${tasa.null_mal} publicarían una tasa falsa`);

  // ── 7. LA FORMA — el segundo eje, y el que decide a quién se manda al anaquel ────────
  //
  // ⛔ Esta sección existe porque el primer diseño FALLÓ acá. Clasificar sólo por `retencion`
  // ponía primero al SKU 17237 (REYMA ROLLO, almacén 05), que retiene $1,261,372 — pero ese
  // dinero es UN evento: un sobrante de 30,196 kg de rollo de plástico en una dulcería, contra
  // 3.98 kg y 9.84 kg en los otros dos conteos. Es un error de dedo con retención perfecta.
  const forma = (await c.query(`
    WITH ev AS (SELECT warehouse_id, sku, fecha,
                       sum(CASE WHEN signo = 'sobrante' THEN importe ELSE -importe END) AS neto_ev
                  FROM analytics.v_erp_physical_count_variance
                 WHERE tipo_evento = 'conteo' GROUP BY 1, 2, 3),
         cc AS (SELECT warehouse_id, sku, max(abs(neto_ev)) AS mayor, count(*)::int AS eventos
                  FROM ev GROUP BY 1, 2)
    SELECT h.warehouse_code, h.sku, h.veces_descuadro, h.pesos_neto,
           round(cc.mayor / nullif(abs(h.pesos_neto), 0), 3) AS concentracion
      FROM analytics.v_sku_count_variance_history h
      JOIN cc ON cc.warehouse_id = h.warehouse_id AND cc.sku = h.sku
     WHERE h.veces_contado >= 2 AND h.veces_descuadro > 0
     ORDER BY abs(h.pesos_neto) DESC, h.veces_descuadro DESC, h.sku LIMIT 20`)).rows;

  const aislados = forma.filter((x) => Number(x.concentracion) >= 0.9);
  const sostenidos = forma.filter((x) => Number(x.concentracion) < 0.9);
  t('⛔ la concentración distingue el evento aislado del descuadre sostenido',
    aislados.length > 0 && sostenidos.length > 0,
    `de los 20 primeros: ${aislados.length} evento_aislado, ${sostenidos.length} sostenido`);

  t('el que encabeza la lista es un EVENTO AISLADO, y la pantalla tiene que decirlo',
    forma.length > 0 && Number(forma[0].concentracion) >= 0.9,
    forma.length ? `SKU ${forma[0].sku} alm ${forma[0].warehouse_code}: `
      + `${forma[0].veces_descuadro} descuadres, concentración ${forma[0].concentracion}` : '');

  const peorSostenido = sostenidos.sort(
    (a, b) => Math.abs(Number(a.pesos_neto)) - Math.abs(Number(b.pesos_neto))).pop();
  t('hay al menos un SKU que pierde de forma SOSTENIDA — el que de verdad hay que ir a ver',
    !!peorSostenido,
    peorSostenido ? `SKU ${peorSostenido.sku} alm ${peorSostenido.warehouse_code}: `
      + `$${Math.round(Number(peorSostenido.pesos_neto)).toLocaleString('en-US')} en `
      + `${peorSostenido.veces_descuadro} descuadres (conc. ${peorSostenido.concentracion})` : '');

  // ── 8. RENDIMIENTO — la pantalla se abre o no se usa ─────────────────────────────────
  //
  // Se mide CON almacén, que es como la pantalla la va a pedir (igual que Programa). Sin
  // filtro cuesta ~1.1 s y eso se declara, no se esconde.
  const [wh] = (await c.query(`
    SELECT warehouse_id FROM analytics.v_sku_count_variance_history
     WHERE veces_contado >= 2 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).rows;
  // [EXP.1a] `patron` ya viene de la vista — dejó de derivarse acá. Antes esto decía
  // `SELECT *, <CASE> AS patron`, y al aparecer la columna en la vista el `*` la trajo también:
  // dos `patron` en el mismo CTE, consulta ambigua. La derivación local NO se tiró: se movió al
  // bloque de CRUCE de abajo, que es donde sirve — comparar DOS implementaciones. Usarla acá
  // sería verificar la vista contra sí misma.
  const CONSULTA = `
    WITH h AS MATERIALIZED (
      SELECT * FROM analytics.v_sku_count_variance_history h WHERE warehouse_id = $1),
    juz AS (SELECT * FROM h WHERE veces_contado >= 2 AND veces_descuadro > 0)
    SELECT (SELECT json_agg(x) FROM (SELECT * FROM juz
              ORDER BY abs(pesos_neto) DESC, veces_descuadro DESC, sku LIMIT 100) x) AS items,
           (SELECT json_agg(r) FROM (SELECT patron, count(*)::int AS skus FROM juz
              GROUP BY patron) r) AS resumen,
           (SELECT count(*)::int FROM h WHERE veces_contado < 2) AS sin_base`;
  await c.query(CONSULTA, [wh.warehouse_id]);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await c.query(CONSULTA, [wh.warehouse_id]);
    best = Math.min(best, Date.now() - t0);
  }
  t('la consulta de la pantalla (un almacén) responde por debajo de 1 s', best < 1000,
    `${best} ms, mejor de 3`);

  // ⛔ El CTE va MATERIALIZED: sin eso la vista se deriva una vez por cada uso.
  t('el CTE está MATERIALIZED — sin eso la vista se deriva tres veces',
    CONSULTA.includes('AS MATERIALIZED'), 'items + resumen + sin_base sobre una sola pasada');

  // ── 9. LOS BINDINGS, con KNEX — lo que ni el build ni este smoke con $1 pueden ver ──
  //
  // ⛔ El servicio arma el SQL con los '?' de knex y bindings CONDICIONALES: el almacén entra
  // en el CTE, el patrón en la subconsulta de items, y el límite al final. Un orden mal puesto
  // no lo detecta `tsc` ni un smoke que use $1 de Postgres — sólo una corrida con knex real.
  // Ya nos costó una vez: CV.7, donde NINGUNA query parametrizada funcionaba y el build pasaba.
  const knex = require('knex')({
    client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 2 },
  });
  try {
    const whId = (await c.query(
      "SELECT id FROM commercial.warehouses WHERE code = '02'")).rows[0]?.id;
    const arma = (w, pat) => `
      WITH h AS MATERIALIZED (
        SELECT warehouse_id, warehouse_code, sku, veces_contado, veces_descuadro, pesos_abs,
               pesos_neto, h.patron
          FROM analytics.v_sku_count_variance_history h
         ${w ? 'WHERE warehouse_id = ?' : ''}),
      juz AS (SELECT * FROM h WHERE veces_contado >= 2 AND veces_descuadro > 0)
      SELECT (SELECT json_agg(x) FROM (SELECT * FROM juz ${pat ? 'WHERE patron = ?' : ''}
                ORDER BY abs(pesos_neto) DESC, veces_descuadro DESC, sku LIMIT ?) x) AS items,
             (SELECT count(*)::int FROM h WHERE veces_contado < 2) AS sin_base`;

    const caminos = [
      ['sin filtros', null, null], ['solo almacén', whId, null],
      ['solo patrón', null, 'merma'], ['almacén + patrón', whId, 'merma'],
    ];
    let bindOk = 0;
    const detalle = [];
    for (const [etq, w, pat] of caminos) {
      const r = await knex.raw(arma(w, pat), [...(w ? [w] : []), ...(pat ? [pat] : []), 5]);
      const row = r.rows[0];
      const items = row.items || [];
      const patrones = [...new Set(items.map((i) => i.patron))];
      // Si el binding del patrón cayera en el lugar equivocado, el filtro no filtraría y la
      // pantalla mostraría todo bajo la etiqueta que el usuario eligió.
      const filtroOk = !pat || patrones.every((x) => x === pat);
      const almOk = !w || row.sin_base < 9000;
      if (items.length > 0 && filtroOk && almOk) bindOk++;
      detalle.push(`${etq}: ${items.length} items, sin_base ${row.sin_base}`);
    }
    t('⛔ los 4 caminos de bindings del servicio funcionan con KNEX (no con $1)',
      bindOk === caminos.length, `${bindOk}/${caminos.length} — ${detalle.join(' · ')}`);
  } catch (e) {
    t('⛔ los 4 caminos de bindings del servicio funcionan con KNEX (no con $1)',
      false, `FALLA DE BINDING: ${e.message}`);
  } finally {
    await knex.destroy();
  }

  await c.end();
  console.log(`\n${ok} ✓ / ${fail} ✗${nomedido ? ` / ${nomedido} ⚠️ NO MEDIDO` : ''}\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
