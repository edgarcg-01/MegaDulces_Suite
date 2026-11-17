#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.21]` Oleada 8b, paso 2 (cierre): factor de caja por producto, factor de caja por almacén y costo unitario
 * POR LLAVE — `analytics.{resolved_product_box_factor,warehouse_box_factor,kepler_unit_cost}_de(skus)`, sus tablas y
 * `analytics.recalcular_existencia(skus)` con los cuatro objetos. Ejerce el `up()` REAL de las migraciones 20261114124213
 * (precio) y 20261117085622 (ésta), dentro de una transacción que se revierte.
 *
 * El escenario pone, para cada pieza donde la forma por llave mete el filtro, un dato que SÍ debe entrar y uno vecino que
 * no: la escalera de Kepler por SKU crudo con espacios (`kdii.c1 = ' F621B '`), el artículo de Wincaja crudo con
 * espacios, las etiquetas por producto, el factor capturado, la sustitución manual, el peldaño comprado, la escalera de
 * costo por proveedor (dos sucursales) y el costo de `kdik`.
 *
 *   A. Las cuatro vistas son su plantilla (si la base ya las traía, se compara; si no, se montan con la plantilla).
 *      ⭐ Negativa de la compuerta: cambiar UN carácter de una vista hace que el up() se niegue.
 *   B. ⭐ Por llave == vista completa filtrada, para los tres objetos: cada SKU solo, pares, todos, uno que no existe.
 *   C. Lo esperado por rama (que la igualdad de B no sea entre dos cosas iguales por accidente).
 *   D. Recálculo completo: cada tabla == su vista; la segunda pasada no escribe nada (mismo ctid). El precio sigue igual.
 *   E. ⭐ Un evento por fuente: cambia el costo de `kdik` → sólo esa fila de kepler_unit_cost; cambia el factor
 *      capturado → sólo esa fila del factor por producto y la del almacén de Wincaja (los de Kepler mandan su ficha).
 *   F. Producto borrado: sus filas salen de las cuatro tablas por llave.
 *   G. Cambio de clave: con la clave nueva sola, la fila del costo queda vieja (por eso el paso 3 anota las DOS);
 *      con las dos, todo == completo.
 *   H. ⭐ 800 SKUs siguen por llave (no ven un cambio ajeno); 801 pasan a completo (sí lo ven).
 *   I. Lista vacía o de puros blancos: cuatro filas en 0/0/0.
 *   J. Permisos: app_runtime lee las tablas y ejecuta recalcular_existencia; no escribe ni ejecuta las *_de. jit=off.
 *   K. up() dos veces; down() quita lo nuevo y deja recalcular_existencia sólo con el precio.
 *   L. ⭐ Compuerta estática: ninguna migración posterior cambia una de las cuatro vistas sin traer su plantilla.
 *
 * Lo que la prueba NO prueba: que la forma por llave filtre bien las piezas REALES de prod (`v_kepler_unit_ladder` y las
 * etiquetas consolidadas, si la base no las trae, se montan mínimas aquí). Eso se midió en prod (60 lotes idénticos,
 * cabecera de la migración) y lo vuelve a contar el recálculo completo de cada día.
 *
 * Mutantes (2026-11-17, en una copia fuera del árbol): mueren los 14 — filtrar crudo en vez de recortado en cada pieza
 * que lo recorta (escalera de Kepler, artículo de Wincaja, moda de rótulos, escalera de costo, productos de los dos
 * factores), el costo y la escalera de unidades filtrados por otra columna, el alcance sin los productos borrados, el
 * alcance del factor por almacén sin recortar, el del factor por producto abierto a todo, el upsert sin guarda de
 * cambio, el up() sin la compuerta de la plantilla y las *_de sin jit=off. Los filtros que sólo podan (quitar uno
 * entero) son equivalentes por construcción: la igualdad no los ve, el costo medido en prod sí.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/t621_precio \
 *     node database/tests/test-newdb-factores-por-llave.js
 */
const fs = require('fs');
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-factores-por-llave', { url: URL });
const { Client } = require('pg');
const { montarExistencia } = require('./_lib/existencia-escenario');
const precio = require('../migrations-newdb/20261114124213_canon621_price_truth_por_llave.js');
const NOMBRE = '20261117085622_canon621_factores_y_costo_por_llave.js';
const DIR = path.resolve(__dirname, '..', 'migrations-newdb');
const migracion = require(path.join(DIR, NOMBRE));

const M = '00000000-0000-0000-0000-00000000d01c';
const PRECIO_COLS = 'tenant_id, warehouse_id, sucursal, product_id, sku, precio, fuente, lineas_pos, precio_config, rechazo, precio_lista, veredicto';
const OBJ =Object.fromEntries(migracion.OBJETOS.map((o) => [o.objeto, o]));
const lista = (o) => OBJ[o].cols.map(([c]) => c).join(', ');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };
const firma = (rows) => rows.map((r) => JSON.stringify(r)).sort().join('\n');

(async () => {
  console.log('\n[CANON.6.21] factores y costo por llave (…_de · tablas · recalcular_existencia)\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const knexLike = { raw: (sql) => c.query(sql) };

  // Por llave (la función) y la vista completa filtrada a las mismas llaves, con las mismas columnas.
  const de = (o, skus) => q(`SELECT ${lista(o)} FROM analytics.${o}_de($1::text[])`, [skus]);
  const vista = (o, skus) => (skus == null
    ? q(`SELECT ${lista(o)} FROM ${OBJ[o].vista}`)
    : o === 'resolved_product_box_factor'
      ? q(`SELECT ${lista(o)} FROM ${OBJ[o].vista} WHERE product_id IN (SELECT id FROM catalog.products WHERE btrim(sku::text) = ANY ($1))`, [skus])
      : q(`SELECT ${lista(o)} FROM ${OBJ[o].vista} WHERE btrim(sku::text) = ANY ($1)`, [skus]));
  const tabla = (o) => q(`SELECT ${lista(o)} FROM analytics.${o}`);
  const ctids = async (o) => Object.fromEntries((await q(`SELECT ${OBJ[o].pk.join(` || '/' || `)} AS k, ctid::text AS t FROM analytics.${o}`)).map((r) => [r.k, r.t]));
  const recalcula = async (skus) => Object.fromEntries((await q(`SELECT * FROM analytics.recalcular_existencia($1::text[])`, [skus]))
    .map((r) => [r.objeto, `${r.insertadas}/${r.actualizadas}/${r.borradas}`]));
  const todasIguales = async () => {
    const malas = [];
    for (const o of Object.keys(OBJ)) if (firma(await tabla(o)) !== firma(await vista(o, null))) malas.push(o);
    if (firma(await q(`SELECT ${PRECIO_COLS} FROM analytics.price_truth`)) !== firma(await q(`SELECT ${PRECIO_COLS} FROM analytics.price_truth_de(NULL)`))) {
      malas.push('price_truth');
    }
    return malas;
  };

  await c.query('BEGIN');
  try {
    // ── Andamio y escenario (compartidos con la prueba del paso 3) ──────────────────────────────────────────────
    const { montadas, peldanosEnTabla, wh, pid } = await montarExistencia(c);

    // ── Las dos migraciones, por su up() real ─────────────────────────────────────────────────────────────────────
    await precio.up(knexLike);
    await migracion.up(knexLike);

    console.log('A. Las cuatro vistas son su plantilla; la compuerta frena si una cambia');
    console.log(`     (${montadas.length ? `montadas con la plantilla: ${montadas.length} — la base no las traía iguales` : 'la base ya las traía iguales a la plantilla'})`);
    await c.query('SAVEPOINT a');
    const cambiada = migracion.sinPuntoYComa(Object.fromEntries(migracion.PLANTILLAS)['analytics.v_kepler_unit_cost'](null)).replace('> (0)::numeric))', '>= (0)::numeric))');
    await c.query(`CREATE OR REPLACE VIEW analytics.v_kepler_unit_cost AS ${cambiada}`);
    let freno = null;
    try { await migracion.up(knexLike); } catch (e) { freno = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT a');
    ok(freno && /v_kepler_unit_cost/.test(freno) && /plantilla/.test(freno), 'una vista con UN carácter distinto: el up() se niega y la nombra', freno || 'no frenó');

    console.log('B. Por llave == la vista completa filtrada');
    const SKUS = ['F621A', 'F621B', 'F621C', 'F621D', 'F621E', 'F621G', 'F621H', 'F621Z', 'NO-EXISTE'];
    for (const o of Object.keys(OBJ)) {
      const casos = [...SKUS.map((s) => [s]), ['F621A', 'F621Z'], ['F621B', 'F621G'], SKUS];
      const malos = [];
      for (const k of casos) if (firma(await de(o, k)) !== firma(await vista(o, k))) malos.push(k.join(','));
      ok(malos.length === 0, `${o}: ${casos.length} listas idénticas a la vista filtrada`, malos.join(' | '));
    }

    console.log('C. Lo esperado por rama');
    const pbf = Object.fromEntries((await de('resolved_product_box_factor', SKUS)).map((r) => [Object.keys(pid).find((s) => pid[s] === r.product_id), r]));
    ok(pbf.F621C?.source === 'override' && Number(pbf.F621C?.box_factor) === 6, 'C: la sustitución manual manda (override, 6)', JSON.stringify(pbf.F621C));
    ok(pbf.F621A?.source === 'kepler_c84' && Number(pbf.F621A?.box_factor) === 12, 'A: el factor capturado de Kepler (kepler_c84, 12)', JSON.stringify(pbf.F621A));
    ok(pbf.F621B?.unit_base === 'KG' && pbf.F621B?.is_weight === true, 'B (clave con espacios): la escalera cruda le da KG y peso', JSON.stringify(pbf.F621B));
    ok(pbf.F621H?.source === 'default' && !pbf.F621D, 'H sin datos: default; D borrado: no sale', `${JSON.stringify(pbf.F621H)} ${JSON.stringify(pbf.F621D)}`);
    if (peldanosEnTabla) ok(pbf.F621E?.source === 'kepler_peldano_comprado' && Number(pbf.F621E?.box_factor) === 30, 'E: el peldaño comprado (30)', JSON.stringify(pbf.F621E));
    else noMedido('rama del peldaño comprado: los peldaños son matviews en esta base');
    const wbf = await de('warehouse_box_factor', SKUS);
    const en = (sku, w) => wbf.find((r) => r.product_id === pid[sku] && r.warehouse_id === wh[w]);
    ok(en('F621B', 'ZW')?.factor_source === 'wincaja_factor_venta' && Number(en('F621B', 'ZW')?.box_factor) === 4, 'B en ZW: el artículo crudo de Wincaja (4)', JSON.stringify(en('F621B', 'ZW')));
    ok(Number(en('F621A', 'Z1')?.box_factor) === 12 && /^kepler_ficha/.test(en('F621A', 'Z1')?.factor_source), 'A en Z1: la ficha de Kepler (12)', JSON.stringify(en('F621A', 'Z1')));
    ok(en('F621G', 'Z1')?.box_label === 'BOL' && en('F621G', 'Z1')?.base_label === 'PZA', 'G: rótulos de la escalera de costo (moda BOL, con los renglones crudos con espacios)', JSON.stringify(en('F621G', 'Z1')));
    ok(en('F621H', 'Z1')?.box_label === 'PAQ', 'H: la escalera de costo lo encuentra por su renglón de proveedor crudo con espacios (PAQ)', JSON.stringify(en('F621H', 'Z1')));
    ok(!wbf.some((r) => r.warehouse_id === wh.Z3), 'Z3 borrado: no sale');
    const kuc = await de('kepler_unit_cost', SKUS);
    const cu = (sku, w) => kuc.find((r) => r.product_id === pid[sku] && r.warehouse_id === wh[w])?.costo_unitario;
    ok(Number(cu('F621A', 'Z1')) === 5.5 && Number(cu('F621A', 'Z2')) === 6, 'A: costo por sucursal (5.5 y 6); la fila de otra sucursal no entra', `${cu('F621A', 'Z1')} ${cu('F621A', 'Z2')}`);
    ok(cu('F621G', 'Z1') === undefined && cu('F621B', 'Z1') === undefined, 'G con costo 0 y B (clave cruda con espacios) no salen, como en la vista');

    console.log('D. Recálculo completo y segunda pasada');
    const r1 = await recalcula(null);
    ok((await todasIguales()).length === 0, 'cada tabla == su vista (y el precio == su función)', JSON.stringify(r1));
    const antes = {}; for (const o of Object.keys(OBJ)) antes[o] = await ctids(o);
    const r2 = await recalcula(null);
    ok(Object.values(r2).every((v) => v === '0/0/0') && Object.keys(r2).length === 4, 'la segunda pasada no escribe nada en las cuatro', JSON.stringify(r2));
    let mismos = true; for (const o of Object.keys(OBJ)) if (JSON.stringify(await ctids(o)) !== JSON.stringify(antes[o])) mismos = false;
    ok(mismos, 'mismo ctid en las tres tablas nuevas (no se reescribió ninguna fila)');

    console.log('E. Un evento por fuente reescribe sólo su fila');
    await c.query(`UPDATE kepler_ods.kdik SET c16 = 5.75 WHERE sucursal = 'Z1' AND c2 = 'F621A'`);
    const kAntes = await ctids('kepler_unit_cost');
    const e1 = await recalcula(['F621A']);
    ok(e1.kepler_unit_cost === '0/1/0' && e1.resolved_product_box_factor === '0/0/0' && e1.warehouse_box_factor === '0/0/0', 'costo de kdik: kepler_unit_cost 0/1/0, los factores 0/0/0', JSON.stringify(e1));
    const kDespues = await ctids('kepler_unit_cost');
    const cambiaron = Object.keys(kAntes).filter((k) => kAntes[k] !== kDespues[k]);
    ok(cambiaron.length === 1 && cambiaron[0] === `${M}/${wh.Z1}/${pid.F621A}`, 'sólo la fila (Z1, A) cambió de ctid', cambiaron.join(','));
    // Qué filas del factor por almacén DEBEN cambiar lo dice la vista (antes y después), no un número supuesto: en
    // una base con más almacenes de Kepler sin ficha para A, también cambian las suyas.
    const llaveW = (r) => `${r.tenant_id}/${r.warehouse_id}/${r.product_id}`;
    const vAntes = Object.fromEntries((await vista('warehouse_box_factor', ['F621A'])).map((r) => [llaveW(r), JSON.stringify(r)]));
    await c.query(`UPDATE analytics.product_box_factor SET box_factor = 18 WHERE product_id = $1`, [pid.F621A]);
    const vDespues = Object.fromEntries((await vista('warehouse_box_factor', ['F621A'])).map((r) => [llaveW(r), JSON.stringify(r)]));
    const debenCambiar = Object.keys(vDespues).filter((k) => vAntes[k] !== vDespues[k]).sort();
    const wAntes = await ctids('warehouse_box_factor');
    const e2 = await recalcula(['F621A']);
    ok(e2.resolved_product_box_factor === '0/1/0' && e2.warehouse_box_factor === `0/${debenCambiar.length}/0` && e2.kepler_unit_cost === '0/0/0',
      `factor capturado: el del producto 0/1/0 y el de almacén 0/${debenCambiar.length}/0 (lo que la vista cambió)`, JSON.stringify(e2));
    const wDespues = await ctids('warehouse_box_factor');
    const wCambio = Object.keys(wAntes).filter((k) => wAntes[k] !== wDespues[k]).sort();
    ok(debenCambiar.includes(`${M}/${wh.ZW}/${pid.F621A}`) && !debenCambiar.includes(`${M}/${wh.Z1}/${pid.F621A}`)
      && JSON.stringify(wCambio) === JSON.stringify(debenCambiar),
      'cambiaron de ctid exactamente esas filas: ZW sí, Z1 no (ahí manda la ficha)', `${wCambio.length} vs ${debenCambiar.length}`);
    ok((await todasIguales()).length === 0, 'después de los dos eventos, todo == completo');

    console.log('F. Producto borrado');
    const filasZ = {};
    for (const o of Object.keys(OBJ)) filasZ[o] = (await q(`SELECT count(*)::int n FROM analytics.${o} WHERE product_id = $1`, [pid.F621Z]))[0].n;
    await c.query(`UPDATE catalog.products SET deleted_at = now() WHERE id = $1`, [pid.F621Z]);
    const f1 = await recalcula(['F621Z']);
    ok(Object.keys(OBJ).every((o) => filasZ[o] > 0 && f1[o] === `0/0/${filasZ[o]}`), 'sus filas salen de las tres tablas por llave', `${JSON.stringify(filasZ)} → ${JSON.stringify(f1)}`);
    // La clave guardada con espacios (' F621B '): el alcance del borrado la recorta.
    const filasB = {};
    for (const o of ['resolved_product_box_factor', 'warehouse_box_factor']) filasB[o] = (await q(`SELECT count(*)::int n FROM analytics.${o} WHERE product_id = $1`, [pid.F621B]))[0].n;
    await c.query(`UPDATE catalog.products SET deleted_at = now() WHERE id = $1`, [pid.F621B]);
    const f2 = await recalcula([' F621B ']);
    ok(Object.keys(filasB).every((o) => filasB[o] > 0 && f2[o] === `0/0/${filasB[o]}`), 'la clave guardada con espacios también sale (el alcance recorta)', `${JSON.stringify(filasB)} → ${JSON.stringify(f2)}`);
    ok((await todasIguales()).length === 0, 'y todo == completo');

    console.log('G. Cambio de clave');
    await c.query(`UPDATE catalog.products SET sku = 'F621C2' WHERE id = $1`, [pid.F621C]);
    await recalcula(['F621C2']);
    const viejas = await todasIguales();
    ok(viejas.includes('kepler_unit_cost'), 'con la clave nueva sola, la fila del costo con la clave vieja queda (por eso se anotan las dos)', JSON.stringify(viejas));
    await recalcula(['F621C', 'F621C2']);
    ok((await todasIguales()).length === 0, 'con la vieja y la nueva, todo == completo');

    console.log('H. El umbral a completo');
    const { MAX_POR_LLAVE } = precio;
    await c.query(`INSERT INTO kepler_ods.kdik (sucursal, c1, c2, c16) VALUES ('Z2', 'Z2', 'F621G', 9)`);
    const relleno = Array.from({ length: MAX_POR_LLAVE }, (_, i) => `NO-${i}`);
    const h1 = await recalcula(relleno);
    ok(h1.kepler_unit_cost === '0/0/0', `${MAX_POR_LLAVE} SKUs: sigue por llave (no ve el costo nuevo de G)`, JSON.stringify(h1));
    const h2 = await recalcula([...relleno, 'NO-X']);
    ok(h2.kepler_unit_cost === '1/0/0', `${MAX_POR_LLAVE + 1} SKUs: pasa a completo (sí lo ve)`, JSON.stringify(h2));

    console.log('I. Lista vacía');
    const i1 = await recalcula([]); const i2 = await recalcula(['  ', null]);
    ok([i1, i2].every((r) => Object.keys(r).length === 4 && Object.values(r).every((v) => v === '0/0/0')), 'vacía o de blancos: cuatro filas en 0/0/0', `${JSON.stringify(i1)} ${JSON.stringify(i2)}`);

    console.log('J. Permisos y jit');
    const priv = (await q(`SELECT ${Object.keys(OBJ).map((o, i) => `has_table_privilege('app_runtime', 'analytics.${o}', 'SELECT') AS s${i},
        has_table_privilege('app_runtime', 'analytics.${o}', 'INSERT') AS w${i}, has_function_privilege('app_runtime', 'analytics.${o}_de(text[])', 'EXECUTE') AS f${i}`).join(', ')},
        has_function_privilege('app_runtime', 'analytics.recalcular_existencia(text[])', 'EXECUTE') AS r`))[0];
    ok(Object.keys(OBJ).every((_, i) => priv[`s${i}`] && !priv[`w${i}`] && !priv[`f${i}`]) && priv.r, 'app_runtime lee las tablas y ejecuta recalcular; no escribe ni ejecuta las *_de', JSON.stringify(priv));
    await c.query('SAVEPOINT j'); await c.query('SET LOCAL ROLE app_runtime');
    let comoApp = null; try { comoApp = await recalcula(['F621A']); } catch (e) { comoApp = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT j');
    ok(typeof comoApp === 'object' && Object.keys(comoApp).length === 4, 'como app_runtime, recalcular_existencia corre (SECURITY DEFINER)', JSON.stringify(comoApp));
    const conf = await q(`SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'analytics' AND p.proname = ANY ($1)`, [[...Object.keys(OBJ).map((o) => `${o}_de`), 'recalcular_existencia']]);
    ok(conf.length === 4 && conf.every((r) => (r.proconfig || []).includes('jit=off'))
      && conf.filter((r) => r.proname.endsWith('_de')).every((r) => r.proconfig.includes('plan_cache_mode=force_custom_plan')), 'las cuatro funciones llevan jit=off (y las *_de plan a la medida)', JSON.stringify(conf));

    console.log('K. Idempotencia y down()');
    const tablasAntes = {}; for (const o of Object.keys(OBJ)) tablasAntes[o] = firma(await tabla(o));
    await migracion.up(knexLike);
    let igualesTrasUp = true; for (const o of Object.keys(OBJ)) if (firma(await tabla(o)) !== tablasAntes[o]) igualesTrasUp = false;
    ok(igualesTrasUp, 'up() otra vez: sin error y sin tocar lo guardado');
    await migracion.down(knexLike);
    const quedan = await q(`SELECT to_regclass('analytics.resolved_product_box_factor') a, to_regclass('analytics.warehouse_box_factor') b, to_regclass('analytics.kepler_unit_cost') c,
      to_regprocedure('analytics.warehouse_box_factor_de(text[])') f`);
    const soloPrecio = await recalcula(['F621A']);
    ok(!quedan[0].a && !quedan[0].b && !quedan[0].c && !quedan[0].f && Object.keys(soloPrecio).join() === 'price_truth', 'down(): quita lo nuevo y recalcular queda sólo con el precio', `${JSON.stringify(quedan[0])} ${JSON.stringify(soloPrecio)}`);

    console.log('L. Compuerta estática: ninguna migración posterior cambia una de las cuatro vistas sin su plantilla');
    const tocaVista = (txt) => /VIEW\s+(IF\s+EXISTS\s+)?analytics\.(v_product_box_factor|v_warehouse_box_factor|v_kepler_unit_cost|v_supplier_cost_ladder)\b/i.test(txt);
    const traePlantilla = (txt) => /PLANTILLAS|exigirPlantillasAlDia/.test(txt);
    ok(tocaVista('CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS') && !traePlantilla('CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS'),
      'el detector reconoce una vista cambiada sin plantilla (control)');
    const posteriores = fs.readdirSync(DIR).filter((n) => n.endsWith('.js') && n > NOMBRE);
    const sinPlantilla = posteriores.filter((n) => { const t = fs.readFileSync(path.join(DIR, n), 'utf8'); return tocaVista(t) && !traePlantilla(t); });
    ok(sinPlantilla.length === 0, `${posteriores.length} migraciones posteriores: ninguna cambia una de las cuatro vistas sin traer su plantilla`, sinPlantilla.join(', '));
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  salir();
})().catch((e) => { console.error('  ✗ excepción:', e.stack || e.message); process.exit(1); });
