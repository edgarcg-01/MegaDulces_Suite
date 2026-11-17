#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.21]` Oleada 8b — el modelo de costo de `analytics.drenar_existencia()` es DATO (`analytics.existencia_costo`,
 * migración 20261117160520). Ejerce el `up()` REAL de las cinco migraciones (precio, factores, cola, costo, ésta) dentro
 * de una transacción que se revierte, sobre el escenario de la oleada.
 *
 *   A. La tabla con UN renglón sembrado con el ajuste de prod (335 + 40 por SKU + 0.027 por línea; 20 s sin referencia).
 *   B. ⭐ La función estima con ESE renglón (constantes escritas aquí, no importadas).
 *   C. ⭐ Recalibrar es un UPDATE: cambia la decisión sin migración.
 *   D. Sin renglón, la función usa los valores sembrados y NO falla; la referencia sin completo sale del renglón.
 *   E. up() otra vez no duplica ni pisa lo calibrado a mano.
 *   F. down(): la función y el comentario de 20261117140515 letra por letra, y sin la tabla.
 *   Después de cada corrida, las cuatro tablas == sus vistas.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/t621_precio \
 *     node database/tests/test-newdb-costo-como-dato.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-costo-como-dato', { url: URL });
const { Client } = require('pg');
const { montarExistencia } = require('./_lib/existencia-escenario');
const precio = require('../migrations-newdb/20261114124213_canon621_price_truth_por_llave.js');
const factores = require('../migrations-newdb/20261117085622_canon621_factores_y_costo_por_llave.js');
const cola = require('../migrations-newdb/20261117094325_canon621_cola_de_existencia_por_evento.js');
const costo = require('../migrations-newdb/20261117140515_canon621_drenar_por_costo.js');
const dato = require('../migrations-newdb/20261117160520_canon621_costo_como_dato.js');

// El ajuste de prod, escrito aquí a propósito.
const FIJO = 335, POR_SKU = 40, POR_LINEA = 0.027, SIN_REFERENCIA = 20000;
const PRECIO_COLS = 'tenant_id, warehouse_id, sucursal, product_id, sku, precio, fuente, lineas_pos, precio_config, rechazo, precio_lista, veredicto';
const OBJ = Object.fromEntries(factores.OBJETOS.map((o) => [o.objeto, o]));
const lista = (o) => OBJ[o].cols.map(([c]) => c).join(', ');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };
const firma = (rows) => rows.map((r) => JSON.stringify(r)).sort().join('\n');

(async () => {
  console.log('\n[CANON.6.21] el modelo de costo es dato (20261117160520)\n');
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
  const funcion = async () => (await q(`SELECT p.prosrc, obj_description(p.oid, 'pg_proc') AS com FROM pg_proc p WHERE p.oid = 'analytics.drenar_existencia()'::regprocedure`))[0];
  const marca = (skus) => c.query(`INSERT INTO analytics.llaves_sucias (sku, fuente) SELECT unnest($1::text[]), 'prueba'`, [skus]);
  const ultima = async () => (await q(`SELECT modo, motivo, llaves, estimado_ms, referencia_ms FROM analytics.existencia_corridas ORDER BY id DESC LIMIT 1`))[0];
  const fijaReferencia = (ms) => c.query(`UPDATE analytics.existencia_corridas SET ms = $1 WHERE id = (SELECT max(id) FROM analytics.existencia_corridas WHERE modo = 'completo')`, [ms]);
  const lineas = async (skus) => Number((await q(`SELECT COALESCE(sum(lineas_pos), 0)::bigint AS s FROM analytics.price_truth WHERE sku = ANY ($1)`, [skus]))[0].s);
  const drenaY = async (skus, esperoModo, esperoMotivo, que, juzga) => {
    if (skus) await marca(skus);
    let r;
    try { r = await q(`SELECT * FROM analytics.drenar_existencia()`); } catch (e) { ok(false, que, `falló: ${e.message}`); return null; }
    const u = await ultima(); const malas = await todasIguales();
    ok(r[0]?.modo === esperoModo && r[0]?.motivo === esperoMotivo && malas.length === 0 && (juzga ? juzga(u) : true),
      `${que}: ${esperoModo} (${esperoMotivo}); las cuatro tablas == sus vistas`, `${r[0]?.modo}/${r[0]?.motivo} · ${JSON.stringify(u)} · ${malas.join(',') || '—'}`);
    return u;
  };

  await c.query('BEGIN');
  try {
    await montarExistencia(c);
    await precio.up(knexLike); await factores.up(knexLike); await cola.up(knexLike); await costo.up(knexLike);
    const antes = await funcion();
    await dato.up(knexLike);
    await c.query(`UPDATE analytics.existencia_por_evento SET encendida = true, updated_at = now()`);

    console.log('A. La tabla');
    const fila = await q(`SELECT fijo_ms::float8 f, por_sku_ms::float8 s, por_linea_ms::float8 l, sin_referencia_ms::float8 r FROM analytics.existencia_costo`);
    ok(fila.length === 1 && fila[0].f === FIJO && fila[0].s === POR_SKU && fila[0].l === POR_LINEA && fila[0].r === SIN_REFERENCIA,
      `un renglón sembrado con el ajuste de prod (${FIJO} + ${POR_SKU} por SKU + ${POR_LINEA} por línea; ${SIN_REFERENCIA} sin referencia)`, JSON.stringify(fila));
    const ahora = await funcion();
    ok(/existencia_costo/.test(ahora.prosrc) && /existencia_costo/.test(ahora.com), 'la función lee la tabla y su comentario lo dice');
    for (const rol of (await q(`SELECT rolname FROM pg_roles WHERE rolname IN ('app_runtime', 'dev_ro')`)).map((r) => r.rolname)) {
      ok((await q(`SELECT has_table_privilege($1, 'analytics.existencia_costo', 'SELECT') AS p`, [rol]))[0].p, `${rol} la puede leer`);
    }

    console.log('B. La función estima con el renglón');
    await drenaY(null, 'completo', 'primero_del_dia', 'primera corrida del día');
    const skus = (await q(`SELECT DISTINCT sku FROM analytics.price_truth WHERE sku IS NOT NULL ORDER BY sku`)).map((r) => r.sku);
    const dos = skus.slice(0, 2);
    await c.query(`UPDATE analytics.price_truth SET lineas_pos = 1000 WHERE sku = $1`, [dos[0]]);
    await fijaReferencia(1e9);
    let e = Math.round(FIJO + POR_SKU * 2 + POR_LINEA * await lineas(dos));
    await drenaY(dos, 'llave', 'cola', `2 SKUs, uno con 1,000 líneas por almacén (estimado ${e} ms)`, (u) => u.estimado_ms === e && u.referencia_ms === 1e9);

    console.log('C. Recalibrar es un UPDATE');
    e = Math.round(FIJO + POR_SKU * 2 + POR_LINEA * await lineas(dos));
    await fijaReferencia(e + 5000);
    await drenaY(dos, 'llave', 'cola', `con el renglón de hoy: por llave (${e} < ${e + 5000})`, (u) => u.estimado_ms === e);
    await c.query(`UPDATE analytics.existencia_costo SET fijo_ms = 10000, updated_at = now(), updated_by = 'prueba'`);
    const e2 = Math.round(10000 + POR_SKU * 2 + POR_LINEA * await lineas(dos));
    await fijaReferencia(e + 5000);
    await drenaY(dos, 'completo', 'costo', `fijo a 10,000 con un UPDATE, sin migración: completo por costo (${e2} > ${e + 5000})`, (u) => u.estimado_ms === e2);

    console.log('D. Sin renglón no falla');
    await c.query(`UPDATE analytics.existencia_costo SET fijo_ms = ${FIJO}, sin_referencia_ms = 7777`);
    await c.query(`UPDATE analytics.existencia_corridas SET ms = NULL WHERE modo = 'completo'`);
    await drenaY(dos, 'llave', 'cola', 'sin completo con tiempo: la referencia sale del renglón (7,777)', (u) => u.referencia_ms === 7777);
    await c.query(`DELETE FROM analytics.existencia_costo`);
    e = Math.round(FIJO + POR_SKU * 2 + POR_LINEA * await lineas(dos));
    await drenaY(dos, 'llave', 'cola', `sin renglón: los valores sembrados (estimado ${e}, referencia ${SIN_REFERENCIA})`,
      (u) => u.estimado_ms === e && u.referencia_ms === SIN_REFERENCIA);

    console.log('E. Idempotencia');
    await dato.up(knexLike);
    await c.query(`UPDATE analytics.existencia_costo SET por_sku_ms = 55, nota = 'a mano'`);
    await dato.up(knexLike);
    const tras = await q(`SELECT por_sku_ms::float8 s, nota FROM analytics.existencia_costo`);
    ok(tras.length === 1 && tras[0].s === 55 && tras[0].nota === 'a mano', 'up() otra vez: un solo renglón y no pisa lo calibrado a mano', JSON.stringify(tras));

    console.log('F. down()');
    await dato.down(knexLike);
    const despues = await funcion();
    const tabla = (await q(`SELECT to_regclass('analytics.existencia_costo') AS t`))[0].t;
    ok(despues.prosrc === antes.prosrc && despues.com === antes.com && !tabla,
      'down(): la función y el comentario de 20261117140515 letra por letra, sin la tabla',
      `función igual: ${despues.prosrc === antes.prosrc} · comentario igual: ${despues.com === antes.com} · tabla: ${tabla}`);
  } catch (err) {
    fail++; console.log('  ✗ la prueba se cayó:', err.message);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
  salir();
})();
