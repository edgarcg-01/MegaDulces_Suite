#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.21]` Oleada 8b — `analytics.drenar_existencia()` elige el recálculo COMPLETO cuando recalcular por llave
 * costaría más que él (migración 20261117140515). Ejerce el `up()` REAL de las cuatro migraciones (precio, factores,
 * cola, esta) dentro de una transacción que se revierte, sobre el escenario de la oleada (`_lib/existencia-escenario.js`).
 *
 *   A. Instalado: las dos columnas de calibración; la función dice `costo`; app_runtime la sigue pudiendo ejecutar.
 *   B. ⭐ La decisión, con constantes ESCRITAS AQUÍ (no importadas: un cambio al modelo sin cambiar la prueba la pone
 *      en rojo): estimado = 1000 + 12 × SKUs + 0.1 × Σ lineas_pos de esos SKUs en price_truth.
 *        · referencia alta → por llave (cola), y la corrida guarda estimado y referencia;
 *        · referencia = estimado → por llave (es «más que», no «igual»); referencia = estimado − 1 → completo (costo);
 *        · las líneas de venta cuentan (un SKU muy vendido pasa la referencia sin cambiar el número de SKUs), y sólo
 *          las de los SKUs de la corrida;
 *        · sin ningún completo con tiempo, la referencia es 20 s;
 *        · el umbral, la marca total y el primero del día siguen mandando antes que el costo (sin estimado).
 *      Después de cada corrida, las cuatro tablas == sus vistas.
 *   C. El sensor de Salud BD toma su árbitro del primer completo del día, no de uno por costo.
 *   D. up() dos veces sin duplicar; down() deja la función de 20261117094325 LETRA POR LETRA, su comentario y sin las
 *      dos columnas.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/t621_precio \
 *     node database/tests/test-newdb-drenar-por-costo.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-drenar-por-costo', { url: URL });
const { Client } = require('pg');
const { montarExistencia } = require('./_lib/existencia-escenario');
const precio = require('../migrations-newdb/20261114124213_canon621_price_truth_por_llave.js');
const factores = require('../migrations-newdb/20261117085622_canon621_factores_y_costo_por_llave.js');
const cola = require('../migrations-newdb/20261117094325_canon621_cola_de_existencia_por_evento.js');
const costo = require('../migrations-newdb/20261117140515_canon621_drenar_por_costo.js');

// El modelo, escrito aquí a propósito (ver B).
const FIJO = 1000, POR_SKU = 12, POR_LINEA = 0.1, SIN_REFERENCIA = 20000;
const PRECIO_COLS = 'tenant_id, warehouse_id, sucursal, product_id, sku, precio, fuente, lineas_pos, precio_config, rechazo, precio_lista, veredicto';
const OBJ = Object.fromEntries(factores.OBJETOS.map((o) => [o.objeto, o]));
const lista = (o) => OBJ[o].cols.map(([c]) => c).join(', ');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };
const firma = (rows) => rows.map((r) => JSON.stringify(r)).sort().join('\n');

(async () => {
  console.log('\n[CANON.6.21] drenar_existencia por costo (20261117140515)\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const knexLike = { raw: (sql) => c.query(sql) };

  const todasIguales = async () => {
    const malas = [];
    for (const o of Object.keys(OBJ)) {
      if (firma(await q(`SELECT ${lista(o)} FROM analytics.${o}`)) !== firma(await q(`SELECT ${lista(o)} FROM ${OBJ[o].vista}`))) malas.push(o);
    }
    if (firma(await q(`SELECT ${PRECIO_COLS} FROM analytics.price_truth`)) !== firma(await q(`SELECT ${PRECIO_COLS} FROM analytics.price_truth_de(NULL)`))) malas.push('price_truth');
    return malas;
  };
  const marca = (skus) => c.query(`INSERT INTO analytics.llaves_sucias (sku, fuente) SELECT unnest($1::text[]), 'prueba'`, [skus]);
  const ultima = async () => (await q(`SELECT modo, motivo, llaves, estimado_ms, referencia_ms FROM analytics.existencia_corridas ORDER BY id DESC LIMIT 1`))[0];
  /** La referencia: el `ms` del último completo (lo que el que drena va a leer). */
  const fijaReferencia = (ms) => c.query(`UPDATE analytics.existencia_corridas SET ms = $1
    WHERE id = (SELECT max(id) FROM analytics.existencia_corridas WHERE modo = 'completo')`, [ms]);
  const estimadoDe = async (skus) => {
    const lp = Number((await q(`SELECT COALESCE(sum(lineas_pos), 0)::bigint AS s FROM analytics.price_truth WHERE sku = ANY ($1)`, [skus]))[0].s);
    return Math.round(FIJO + POR_SKU * skus.length + POR_LINEA * lp);
  };
  const drenaY = async (skus, esperoModo, esperoMotivo, que, extra) => {
    if (skus) await marca(skus);
    const r = await q(`SELECT * FROM analytics.drenar_existencia()`);
    const u = await ultima();
    const malas = await todasIguales();
    const vacia = Number((await q(`SELECT count(*)::int n FROM analytics.llaves_sucias`))[0].n) === 0;
    const okExtra = extra ? extra(u) : true;
    ok(r[0]?.modo === esperoModo && r[0]?.motivo === esperoMotivo && malas.length === 0 && vacia && okExtra,
      `${que}: ${esperoModo} (${esperoMotivo}); cola vacía y las cuatro tablas == sus vistas`,
      `${r[0]?.modo}/${r[0]?.motivo} · corrida ${JSON.stringify(u)} · distintas: ${malas.join(',') || '—'} · cola vacía: ${vacia}`);
    return u;
  };

  await c.query('BEGIN');
  try {
    await montarExistencia(c);
    await precio.up(knexLike);
    await factores.up(knexLike);
    await cola.up(knexLike);
    const antes = (await q(`SELECT p.prosrc, obj_description(p.oid, 'pg_proc') AS com FROM pg_proc p
      WHERE p.oid = 'analytics.drenar_existencia()'::regprocedure`))[0];
    await costo.up(knexLike);
    await c.query(`UPDATE analytics.existencia_por_evento SET encendida = true, updated_at = now()`);

    console.log('A. Instalado');
    const cols = (await q(`SELECT array_agg(attname::text ORDER BY attname) AS a FROM pg_attribute
      WHERE attrelid = 'analytics.existencia_corridas'::regclass AND attname IN ('estimado_ms', 'referencia_ms') AND NOT attisdropped`))[0].a || [];
    ok(cols.join(',') === 'estimado_ms,referencia_ms', 'existencia_corridas tiene estimado_ms y referencia_ms', cols.join(','));
    const ahora = (await q(`SELECT p.prosrc, obj_description(p.oid, 'pg_proc') AS com FROM pg_proc p
      WHERE p.oid = 'analytics.drenar_existencia()'::regprocedure`))[0];
    ok(/'costo'/.test(ahora.prosrc) && /costo/.test(ahora.com) && ahora.prosrc !== antes.prosrc, 'drenar_existencia() decide por costo y su comentario lo dice');
    const rol = (await q(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS hay`))[0].hay;
    if (rol) {
      ok((await q(`SELECT has_function_privilege('app_runtime', 'analytics.drenar_existencia()', 'EXECUTE') AS p`))[0].p,
        'app_runtime la sigue pudiendo ejecutar (CREATE OR REPLACE conserva el permiso)');
    } else noMedido('permiso de app_runtime: el rol no existe en esta base');

    console.log('B. La decisión por costo');
    await drenaY(null, 'completo', 'primero_del_dia', 'primera corrida del día');
    const skus = (await q(`SELECT DISTINCT sku FROM analytics.price_truth WHERE sku IS NOT NULL ORDER BY sku`)).map((r) => r.sku);
    if (skus.length < 2) throw new Error(`el escenario dejó ${skus.length} SKUs en price_truth: no alcanza para probar`);
    const uno = [skus[0]], dos = skus.slice(0, 2);

    await fijaReferencia(1e9);
    let e = await estimadoDe(uno);
    await drenaY(uno, 'llave', 'cola', `1 SKU, referencia muy alta (estimado ${e} ms)`,
      (u) => u.estimado_ms === e && u.referencia_ms === 1e9 && u.llaves === 1);

    // El completo más reciente sigue siendo el primero del día: su ms es la referencia.
    e = await estimadoDe(dos);
    await fijaReferencia(e);
    await drenaY(dos, 'llave', 'cola', `referencia = estimado (${e} ms): por llave, es «más que», no «igual»`,
      (u) => u.estimado_ms === e && u.referencia_ms === e);
    await fijaReferencia(e - 1);
    await drenaY(dos, 'completo', 'costo', `referencia = estimado − 1 (${e - 1} ms): completo por costo`,
      (u) => u.estimado_ms === e && u.referencia_ms === e - 1 && u.llaves === 2);

    // Las líneas de venta cuentan: el mismo SKU, más vendido, pasa la referencia.
    await fijaReferencia(5000);
    e = await estimadoDe(uno);
    await drenaY(uno, 'llave', 'cola', `1 SKU con sus líneas de hoy (estimado ${e} ms < 5,000)`, (u) => u.estimado_ms === e);
    // Sólo las líneas de los SKUs de la corrida: otro SKU muy vendido que no está en la cola no cuenta.
    await c.query('SAVEPOINT b');
    await c.query(`UPDATE analytics.price_truth SET lineas_pos = 90000 WHERE sku = $1`, [skus[1]]);
    e = await estimadoDe(uno);
    await marca(uno);
    const ajena = (await q(`SELECT * FROM analytics.drenar_existencia()`))[0];
    const uAjena = await ultima();
    await c.query('ROLLBACK TO SAVEPOINT b');
    ok(ajena?.motivo === 'cola' && uAjena.estimado_ms === e, `otro SKU con 90,000 líneas fuera de la cola no entra al estimado (${e} ms)`,
      `${ajena?.modo}/${ajena?.motivo} · estimado ${uAjena.estimado_ms}`);
    await c.query(`UPDATE analytics.price_truth SET lineas_pos = 50000 WHERE sku = $1`, [uno[0]]);
    e = await estimadoDe(uno);
    await drenaY(uno, 'completo', 'costo', `el mismo SKU con 50,000 líneas por almacén (estimado ${e} ms > 5,000)`,
      (u) => u.estimado_ms === e && e > 5000);

    // Sin ningún completo con tiempo: 20 s.
    await c.query(`UPDATE analytics.existencia_corridas SET ms = NULL WHERE modo = 'completo'`);
    e = await estimadoDe(dos);
    await drenaY(dos, 'llave', 'cola', `sin completo con tiempo: la referencia es ${SIN_REFERENCIA} ms`,
      (u) => u.referencia_ms === SIN_REFERENCIA && u.estimado_ms === e);

    // Lo que manda antes que el costo: ni siquiera estima.
    await fijaReferencia(1);
    const muchos = Array.from({ length: 801 }, (_, i) => `ZZ621-${String(i).padStart(4, '0')}`);
    await drenaY(muchos, 'completo', 'umbral', '801 SKUs: el umbral manda (sin estimado)', (u) => u.estimado_ms === null);
    await drenaY(['*', ...uno], 'completo', 'marca_total', "la marca '*' manda (sin estimado)", (u) => u.estimado_ms === null);
    await c.query(`UPDATE analytics.existencia_corridas SET created_at = created_at - interval '1 day'`);
    await drenaY(uno, 'completo', 'primero_del_dia', 'al día siguiente, el primero del día manda (sin estimado)', (u) => u.estimado_ms === null);

    console.log('C. El sensor toma su árbitro del primer completo del día');
    let S = null;
    try {
      require('ts-node').register({ transpileOnly: true, skipProject: true,
        compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', ignoreDeprecations: '6.0' } });
      S = require(path.resolve(__dirname, '..', '..', 'apps/api/src/modules/db-health/db-health-existencia-evento.ts'));
    } catch (err) { noMedido(`no se pudo cargar el sensor con ts-node: ${err.message}`); }
    if (S) {
      await c.query('SAVEPOINT c');
      await c.query(`UPDATE analytics.existencia_corridas SET resultado = '[{"objeto":"price_truth","insertadas":0,"actualizadas":7,"borradas":0}]'::jsonb
        WHERE id = (SELECT max(id) FROM analytics.existencia_corridas WHERE motivo = 'primero_del_dia')`);
      await c.query(`INSERT INTO analytics.existencia_corridas (modo, motivo, marcas, llaves, ms, resultado)
        VALUES ('completo', 'costo', 30, 20, 15000, '[{"objeto":"price_truth","insertadas":0,"actualizadas":999,"borradas":0}]'::jsonb)`);
      const r = (await q(S.EXISTENCIA_EVENTO_SQL))[0];
      await c.query('ROLLBACK TO SAVEPOINT c');
      ok(/árbitro: 7 filas escritas por la primera del día/.test(r.note_extra || ''),
        'con un completo por costo DESPUÉS del primero del día, el árbitro sigue siendo el del primero (7, no 999)', r.note_extra);
    }

    console.log('D. Idempotencia y down()');
    const fnAntes = (await q(`SELECT prosrc FROM pg_proc WHERE oid = 'analytics.drenar_existencia()'::regprocedure`))[0].prosrc;
    await costo.up(knexLike);
    const fnDespues = (await q(`SELECT prosrc FROM pg_proc WHERE oid = 'analytics.drenar_existencia()'::regprocedure`))[0].prosrc;
    const nCols = Number((await q(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid = 'analytics.existencia_corridas'::regclass
      AND attname IN ('estimado_ms', 'referencia_ms') AND NOT attisdropped`))[0].n);
    ok(fnAntes === fnDespues && nCols === 2, 'up() otra vez: la misma función y las mismas dos columnas');
    await costo.down(knexLike);
    const tras = (await q(`SELECT p.prosrc, obj_description(p.oid, 'pg_proc') AS com FROM pg_proc p
      WHERE p.oid = 'analytics.drenar_existencia()'::regprocedure`))[0];
    const quedan = Number((await q(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid = 'analytics.existencia_corridas'::regclass
      AND attname IN ('estimado_ms', 'referencia_ms') AND NOT attisdropped`))[0].n);
    ok(tras.prosrc === antes.prosrc && tras.com === antes.com && quedan === 0,
      'down(): la función y el comentario de 20261117094325 letra por letra, sin las dos columnas',
      `función igual: ${tras.prosrc === antes.prosrc} · comentario igual: ${tras.com === antes.com} · columnas: ${quedan}`);
    await marca(uno);
    const r = await q(`SELECT * FROM analytics.drenar_existencia()`);
    ok(r[0]?.modo === 'llave' && r[0]?.motivo === 'cola', 'tras el down(), la de antes drena por llave como siempre', `${r[0]?.modo}/${r[0]?.motivo}`);
  } catch (err) {
    fail++; console.log('  ✗ la prueba se cayó:', err.message);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
  salir();
})();
