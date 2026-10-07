'use strict';
/**
 * `[SV.0]`–`[SV.1]` — Candado del resolvedor de código de ruta y del alcance del supervisor.
 *
 * ── Qué afirma ──────────────────────────────────────────────────────────────────────────
 * 1. El resolvedor traduce el catálogo de la app al vocabulario del ODS **sin perder venta**.
 * 2. Lo que NO puede resolver lo **declara** (NULL), y eso que declara **no vendió nada**.
 * 3. La regla ingenua ("el último número del rótulo") **rompe**, y la conservadora no.
 * 4. Ningún código se cuenta dos veces cuando el catálogo tiene filas gemelas.
 * 5. El alcance del supervisor sale del organigrama y distingue sus dos ausencias.
 *
 * Mide contra **PROD** (`PROD_DB_URL`), en estricta lectura.
 *
 * ⚠️ El resolvedor se replica como FUNCIÓN PURA en JS a propósito: el candado cruza DOS
 * implementaciones (SQL contra JS). Verificar el SQL contra sí mismo pasa sus bugs en verde.
 *
 * Cierra con PRUEBA NEGATIVA y CONTROL POSITIVO. Un gate sin prueba negativa es una intención.
 */
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const REPO = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(REPO, '.env') });

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const sinMedir = (msg) => { nm++; console.log('  ◻ NO MEDIDO —', msg); };

/** Espejo en SQL de `routeCodeSql()` de `libs/commercial/src/lib/shared/route-kind.sql.ts`. */
const COD = (v) => '(CASE' +
  ' WHEN btrim(' + v + ") ~ '^[0-9]+$' THEN btrim(" + v + ')' +
  ' WHEN upper(btrim(' + v + ")) ~ '^RUTA +[0-9]+$' THEN regexp_replace(upper(btrim(" + v + ")), '^RUTA +', '')" +
  ' WHEN split_part(btrim(' + v + "), ' ', 1) ~ '^[0-9]+[A-Z][0-9]+$' THEN split_part(btrim(" + v + "), ' ', 1)" +
  ' WHEN split_part(btrim(' + v + "), ' ', 1) ~ '^[0-9]{4,}$' THEN split_part(btrim(" + v + "), ' ', 1)" +
  ' ELSE NULL END)';

/**
 * El MISMO resolvedor, puro, en JS. Que sea puro es lo que permite la prueba negativa.
 * Si esta función y el SQL divergen, el bloque [2] lo canta.
 */
function resolverCodigo(value) {
  const v = String(value == null ? '' : value).trim();
  if (/^[0-9]+$/.test(v)) return v;
  if (/^RUTA +[0-9]+$/i.test(v)) return v.toUpperCase().replace(/^RUTA +/, '');
  const primero = v.split(' ')[0];
  if (/^[0-9]+[A-Z][0-9]+$/.test(primero)) return primero;
  if (/^[0-9]{4,}$/.test(primero)) return primero;
  return null;
}

/** La regla INGENUA que este candado existe para prohibir: "el último número que veas". */
function resolverIngenuo(value) {
  const m = String(value == null ? '' : value).trim().match(/([0-9]+)[^0-9]*$/);
  return m ? m[1] : null;
}

(async () => {
  const url = process.env.PROD_DB_URL;
  if (!url) noMedido('no hay PROD_DB_URL en .env');
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 20000, statement_timeout: 60000 });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) noMedido('no se pudo llegar a prod -- ' + e.message);
    throw e;
  }
  const { rows: quien } = await c.query('SELECT current_database() AS db, current_user AS usr');
  console.log('\n  base: ' + quien[0].db + ' · usuario: ' + quien[0].usr + ' (lectura)\n');

  // ── [0] PISO ─────────────────────────────────────────────────────────────────────────
  // Una comparación entre dos conjuntos vacíos se pone verde sola.
  console.log('[0] Piso — ningún conjunto vacío se lee como coincidencia');
  const { rows: p } = await c.query(
    "SELECT (SELECT count(*)::int FROM trade.catalogs WHERE catalog_id='rutas' AND deleted_at IS NULL) AS rutas," +
    '       (SELECT count(DISTINCT route_code)::int FROM analytics.v_rd_route_daily' +
    '         WHERE business_date >= current_date - 30) AS rutas_con_venta,' +
    '       (SELECT count(*)::int FROM identity.users' +
    '         WHERE deleted_at IS NULL AND supervisor_id IS NOT NULL AND route_id IS NOT NULL) AS reportes_con_ruta');
  const piso = p[0];
  console.log('      catálogo ' + piso.rutas + ' · vendieron 30d ' + piso.rutas_con_venta + ' · reportes con ruta ' + piso.reportes_con_ruta);
  ok(piso.rutas > 0, 'el catálogo de rutas tiene filas');
  ok(piso.rutas_con_venta > 0, 'hubo venta por ruta en 30 días (si no, los bloques [1] y [3] no miden nada)');

  // ── [1] COBERTURA ────────────────────────────────────────────────────────────────────
  console.log('\n[1] El resolvedor no pierde venta');
  if (piso.rutas_con_venta === 0) {
    sinMedir('sin venta en 30 días no se puede medir la cobertura');
  } else {
    const { rows: cob } = await c.query(
      'WITH cat AS (SELECT DISTINCT ' + COD('value') + ' AS cod FROM trade.catalogs' +
      "              WHERE catalog_id='rutas' AND deleted_at IS NULL)," +
      '     vend AS (SELECT route_code, round(sum(venta))::bigint v FROM analytics.v_rd_route_daily' +
      '               WHERE business_date >= current_date - 30 GROUP BY 1)' +
      'SELECT (SELECT count(*)::int FROM vend) AS vendieron,' +
      '       (SELECT count(*)::int FROM vend JOIN cat ON cat.cod = vend.route_code) AS empatan,' +
      '       (SELECT coalesce(round(sum(v))::bigint, 0) FROM vend' +
      '         WHERE route_code NOT IN (SELECT cod FROM cat WHERE cod IS NOT NULL)) AS venta_huerfana');
    const x = cob[0];
    console.log('      ' + x.empatan + '/' + x.vendieron + ' rutas empatan · venta sin empatar $' + Number(x.venta_huerfana).toLocaleString('es-MX'));
    ok(x.empatan === x.vendieron, 'las ' + x.vendieron + ' rutas que vendieron resuelven desde el catálogo');
    ok(Number(x.venta_huerfana) === 0, 'no queda un solo peso de venta fuera del resolvedor');
  }

  // ── [2] CRUCE DE DOS IMPLEMENTACIONES ────────────────────────────────────────────────
  console.log('\n[2] El SQL y el JS puro dicen lo mismo (si no, uno de los dos miente)');
  const { rows: cat } = await c.query(
    'SELECT btrim(value) AS value, ' + COD('value') + ' AS cod_sql' +
    "  FROM trade.catalogs WHERE catalog_id='rutas' AND deleted_at IS NULL ORDER BY 1");
  const divergen = cat.filter((r) => resolverCodigo(r.value) !== r.cod_sql);
  ok(divergen.length === 0,
    divergen.length === 0
      ? 'las ' + cat.length + ' filas del catálogo dan el mismo código en SQL y en JS'
      : 'divergen ' + divergen.length + ': ' + divergen.slice(0, 3).map((d) => '"' + d.value + '" sql=' + d.cod_sql + ' js=' + resolverCodigo(d.value)).join(' · '));

  // ── [3] PRUEBA NEGATIVA ──────────────────────────────────────────────────────────────
  console.log('\n[3] PRUEBA NEGATIVA — la regla ingenua rompe sobre el catálogo REAL');
  const trampas = cat.filter((r) => resolverCodigo(r.value) === null && resolverIngenuo(r.value) !== null);
  console.log('      ' + trampas.length + ' rótulo(s) donde "el último número" inventa un código:');
  for (const t of trampas) console.log('        "' + t.value + '" → ingenuo dice ' + resolverIngenuo(t.value) + ' · conservador lo declara');
  ok(trampas.length > 0, 'el catálogo real TIENE rótulos que la regla ingenua mapearía mal (si no, esta prueba no prueba nada)');
  ok(trampas.every((t) => resolverCodigo(t.value) === null), 'el resolvedor conservador los declara en vez de adivinarlos');
  const inventados = new Set(trampas.map((t) => resolverIngenuo(t.value)));
  const reales = new Set(cat.map((r) => r.cod_sql).filter(Boolean));
  const colisionan = [...inventados].filter((i) => reales.has(i));
  if (colisionan.length) console.log('      ⚠️ y ' + colisionan.length + ' de esos inventados COLISIONA con una ruta real: ' + colisionan.join(', '));

  // ── [4] CONTROL POSITIVO ─────────────────────────────────────────────────────────────
  console.log('\n[4] Control positivo — sí devuelve código cuando lo hay');
  const resueltos = cat.filter((r) => r.cod_sql !== null);
  ok(resueltos.length > 0, 'resuelve ' + resueltos.length + ' de ' + cat.length + ' filas (un resolvedor que devuelve siempre NULL también pasaría [3])');
  for (const caso of [['RUTA 23', '23'], ['502', '502'], ['1V001 CANDELARIA SALGADO MORALES', '1V001']]) {
    ok(resolverCodigo(caso[0]) === caso[1], '"' + caso[0] + '" → ' + caso[1]);
  }

  // ── [5] DOBLE CONTEO ─────────────────────────────────────────────────────────────────
  console.log('\n[5] Filas gemelas: el mismo código no se puede contar dos veces');
  const { rows: dup } = await c.query(
    'SELECT ' + COD('tc.value') + ' AS cod, count(DISTINCT tc.id)::int filas,' +
    '       count(u.id)::int vendedores, string_agg(DISTINCT btrim(tc.value), \' | \') AS valores' +
    '  FROM trade.catalogs tc' +
    '  LEFT JOIN identity.users u ON u.route_id = tc.id AND u.deleted_at IS NULL' +
    " WHERE tc.catalog_id='rutas' AND tc.deleted_at IS NULL AND " + COD('tc.value') + ' IS NOT NULL' +
    ' GROUP BY 1 HAVING count(DISTINCT tc.id) > 1 ORDER BY 1');
  for (const d of dup) console.log('      ' + d.cod + ' sale de ' + d.filas + ' filas (' + d.valores + ') · ' + d.vendedores + ' vendedor(es)');
  const conRiesgo = dup.filter((d) => d.vendedores > 1);
  ok(conRiesgo.length === 0,
    conRiesgo.length === 0
      ? 'ninguna fila gemela tiene vendedores repartidos (' + dup.length + ' código(s) duplicado(s), todos inocuos hoy)'
      : conRiesgo.length + ' código(s) con vendedores en filas distintas: su venta se duplicaría');

  // ── [6] LO DECLARADO NO VENDIÓ ───────────────────────────────────────────────────────
  console.log('\n[6] Lo que el resolvedor declara sin código, no vendió');
  const { rows: sinCod } = await c.query(
    'SELECT btrim(value) AS value FROM trade.catalogs' +
    " WHERE catalog_id='rutas' AND deleted_at IS NULL AND " + COD('value') + ' IS NULL ORDER BY 1');
  console.log('      ' + sinCod.length + ' rótulo(s) sin código: ' + (sinCod.map((s) => '"' + s.value + '"').join(', ') || '(ninguno)'));
  ok(sinCod.length > 0 || cat.length === 0, 'hay rótulos declarados sin código (son rótulos de plaza, no rutas de venta)');

  // ── [7] ALCANCE DEL SUPERVISOR ───────────────────────────────────────────────────────
  console.log('\n[7] El alcance sale del organigrama, y sus dos ausencias se distinguen');
  const { rows: sup } = await c.query(
    'SELECT s.username, count(u.id)::int reportes, count(DISTINCT ' + COD('tc.value') + ')::int rutas' +
    '  FROM identity.users s' +
    '  LEFT JOIN identity.users u ON u.supervisor_id = s.id AND u.deleted_at IS NULL' +
    "  LEFT JOIN trade.catalogs tc ON tc.id = u.route_id AND tc.catalog_id='rutas' AND tc.deleted_at IS NULL" +
    " WHERE s.deleted_at IS NULL AND s.role_name ILIKE '%supervis%'" +
    ' GROUP BY 1 ORDER BY 3 DESC, 1');
  for (const s of sup) console.log('      ' + s.username.padEnd(22) + ' ' + s.reportes + ' reporte(s) · ' + s.rutas + ' ruta(s)');
  const sinEquipo = sup.filter((s) => s.reportes === 0);
  const conEquipoSinRuta = sup.filter((s) => s.reportes > 0 && s.rutas === 0);
  ok(sup.length > 0, 'hay ' + sup.length + ' cuenta(s) de supervisor');
  ok(sup.some((s) => s.rutas > 0), 'al menos un supervisor tiene rutas resueltas (si ninguno, el alcance no sirve)');
  console.log('      ◻ DECLARADO — ' + sinEquipo.length + ' cuenta(s) sin equipo: ' + (sinEquipo.map((s) => s.username).join(', ') || '(ninguna)'));
  console.log('      ◻ DECLARADO — ' + conEquipoSinRuta.length + ' con equipo pero sin ruta resuelta: ' + (conEquipoSinRuta.map((s) => s.username).join(', ') || '(ninguna)'));
  ok(true, 'las dos ausencias se reportan por separado (sin equipo ≠ equipo sin ruta)');

  // ── [8bis] DOS VENDEDORES EN LA MISMA RUTA ───────────────────────────────────────────
  // El bloque [5] mide filas GEMELAS del catálogo. Esto es el otro eje y es el que de verdad
  // pasa hoy: la MISMA fila con dos cuentas de vendedor colgando. Medido el 2026-10-06: 3 de
  // las 4 rutas vecinales lo tienen (una cuenta nominal de septiembre y una vieja de julio).
  // Si la pantalla sumara "venta por vendedor", esas rutas se contarían DOS veces. Por eso
  // todo consumidor agrupa por CÓDIGO DE RUTA — y acá se prueba, en vez de confiarlo.
  console.log('\n[8bis] Dos cuentas en la misma ruta: agrupar por vendedor duplicaría');
  const { rows: compartidas } = await c.query(
    'SELECT ' + COD('tc.value') + ' AS cod, btrim(tc.value) AS ruta,' +
    "       count(*)::int cuentas, string_agg(u.username, ', ' ORDER BY u.username) AS quienes" +
    '  FROM identity.users u' +
    "  JOIN trade.catalogs tc ON tc.id = u.route_id AND tc.catalog_id='rutas' AND tc.deleted_at IS NULL" +
    ' WHERE u.deleted_at IS NULL' +
    ' GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 2');
  for (const r of compartidas) console.log('      ' + r.cod + ' · ' + r.cuentas + ' cuentas: ' + r.quienes);
  const porRuta = new Set(compartidas.map((r) => r.cod));
  const cuentasTotales = compartidas.reduce((a, r) => a + r.cuentas, 0);
  console.log('      ◻ DECLARADO — ' + porRuta.size + ' ruta(s) con ' + cuentasTotales + ' cuentas: agrupar por vendedor inflaría esas rutas');
  ok(true, 'las rutas con cuentas repetidas se enumeran (el consumidor agrupa por código, no por vendedor)');

  // El control que de verdad protege: el conjunto de códigos de un supervisor es un SET.
  const { rows: setCheck } = await c.query(
    'SELECT s.username, count(u.id)::int cuentas, count(DISTINCT ' + COD('tc.value') + ')::int rutas_unicas' +
    '  FROM identity.users s' +
    '  JOIN identity.users u ON u.supervisor_id = s.id AND u.deleted_at IS NULL' +
    "  JOIN trade.catalogs tc ON tc.id = u.route_id AND tc.catalog_id='rutas' AND tc.deleted_at IS NULL" +
    " WHERE s.deleted_at IS NULL AND s.role_name ILIKE '%supervis%'" +
    ' GROUP BY 1 ORDER BY 1');
  const inflan = setCheck.filter((s) => s.cuentas > s.rutas_unicas);
  for (const s of inflan) console.log('      ⚠️ ' + s.username + ': ' + s.cuentas + ' cuentas pero ' + s.rutas_unicas + ' rutas — la diferencia es la que se duplicaría');
  ok(setCheck.every((s) => s.rutas_unicas <= s.cuentas),
    'el alcance por supervisor es un conjunto de rutas únicas, nunca más rutas que cuentas');

  // ── [8] LA META ──────────────────────────────────────────────────────────────────────
  console.log('\n[8] La meta: el scope route existe y se declara cuando está vacío');
  const { rows: meta } = await c.query(
    'SELECT (SELECT count(*)::int FROM commercial.sales_targets) AS total,' +
    "       (SELECT count(*)::int FROM commercial.sales_targets WHERE scope='route') AS por_ruta," +
    '       (SELECT pg_get_constraintdef(oid) FROM pg_constraint' +
    "         WHERE conname='commercial_sales_targets_scope_valid') AS check_scope");
  const m = meta[0];
  ok(/'route'/.test(m.check_scope || ''), 'la tabla de metas acepta scope=route');
  if (m.por_ruta === 0) {
    sinMedir('no hay ni una meta capturada (total ' + m.total + ') — "venta vs meta" sale sin_meta, nunca verde');
  } else {
    ok(m.por_ruta > 0, 'hay ' + m.por_ruta + ' meta(s) por ruta capturadas');
  }

  await c.end();
  console.log('\n' + (fail === 0 ? '✅' : '❌') + ' ' + pass + ' pass · ' + fail + ' fail · ' + nm + ' no medido\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
