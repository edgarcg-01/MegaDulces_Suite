#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.21]` Oleada 8b, paso 3: el EVENTO — la cola `analytics.llaves_sucias`, los disparadores `tg_exs_*` en las 13
 * fuentes y `analytics.drenar_existencia()`. Ejerce el `up()` REAL de las tres migraciones (20261114124213 precio,
 * 20261117085622 factores y costo, 20261117094325 la cola), dentro de una transacción que se revierte, sobre el
 * escenario compartido de la oleada (`_lib/existencia-escenario.js`).
 *
 *   A. Instalado: cuatro disparadores por fuente; la cola SIN llave única por SKU (la ingesta no espera al que drena);
 *      ⭐ el interruptor nace APAGADO (una escritura pasa y no anota nada) — la prueba lo prende para lo demás.
 *   B. La primera corrida del día recalcula todo; la siguiente sin marcas no hace nada.
 *   C. ⭐ Cada fuente, escrita COMO LA INGESTA (lote con ON CONFLICT … WHERE IS DISTINCT FROM) o como la API: anota
 *      exactamente los SKUs que tocó, con su fuente; un cambio en una columna que ninguna regla lee no anota nada; un
 *      cambio de clave anota la vieja y la nueva; la compra (X-A), otra lista de precios y el histórico de Wincaja no
 *      anotan. Después de drenar, las cuatro tablas == sus vistas.
 *   D. Un almacén o un TRUNCATE anotan '*' y el que drena recalcula todo; arriba del umbral, también.
 *   E. ⭐ El disparador nunca frena la escritura: con la cola rota, la escritura pasa y la falla queda en
 *      llaves_sucias_errores.
 *   F. ⭐ Si el recálculo falla, la cola queda intacta y la falla queda escrita en existencia_corridas.
 *   G. Otro recalculando (candado tomado desde otra conexión): `ocupado`, sin esperar.
 *   H. Un día después vuelve a recalcular todo (la fecha mueve las ventanas de 90 y 365 días).
 *   I. Permisos: app_runtime ejecuta drenar_existencia y no escribe la cola.
 *   J. Lo que le cuesta a un lote de la ingesta (2,000 renglones de kdm2): con y sin disparadores.
 *   K. up() dos veces sin duplicar; down() lo quita todo.
 *
 * Mutantes (2026-11-17, en una copia fuera del árbol): mueren los 16 — el UPDATE que anota aunque no cambie nada que la
 * regla lea, el que no anota nunca, sólo la clave nueva de un cambio de clave, kdm2 sin el filtro de venta, kdm1 sin
 * buscar sus líneas, el disparador sin atrapar su error, sin el recálculo completo del día, precios de cualquier lista,
 * Wincaja con el histórico, TRUNCATE sin marca, la cola con llave única, el que drena sin atrapar la falla, el umbral
 * sin decirlo, el que drena sin respetar al que ya recalcula, el almacén sin marca total y el interruptor ignorado.
 * Equivalente en una sola sesión (declarado): tomar la cola sin el tope de `id` — sólo cambia con escrituras
 * concurrentes, y esta prueba corre en una transacción.
 *
 * NO MEDIDO aquí: que el NOTIFY llegue (los avisos sólo salen al confirmar, y esta prueba siempre revierte) — lo prueba
 * el paso 4, el que escucha.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/t621_precio \
 *     node database/tests/test-newdb-existencia-por-evento.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-existencia-por-evento', { url: URL });
const { Client } = require('pg');
const { montarExistencia, M } = require('./_lib/existencia-escenario');
const precio = require('../migrations-newdb/20261114124213_canon621_price_truth_por_llave.js');
const factores = require('../migrations-newdb/20261117085622_canon621_factores_y_costo_por_llave.js');
const cola = require('../migrations-newdb/20261117094325_canon621_cola_de_existencia_por_evento.js');

const RED = '00000000-0000-0000-0000-0000c0ffee02';
const OTRA = '00000000-0000-0000-0000-0000c0ffee99';
const PRECIO_COLS = 'tenant_id, warehouse_id, sucursal, product_id, sku, precio, fuente, lineas_pos, precio_config, rechazo, precio_lista, veredicto';
const OBJ = Object.fromEntries(factores.OBJETOS.map((o) => [o.objeto, o]));
const lista = (o) => OBJ[o].cols.map(([c]) => c).join(', ');
const PK1 = ['sucursal', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };
const firma = (rows) => rows.map((r) => JSON.stringify(r)).sort().join('\n');

(async () => {
  console.log('\n[CANON.6.21] existencia por evento (llaves_sucias · tg_exs_* · drenar_existencia)\n');
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
    if (firma(await q(`SELECT ${PRECIO_COLS} FROM analytics.price_truth`)) !== firma(await q(`SELECT ${PRECIO_COLS} FROM analytics.price_truth_de(NULL)`))) {
      malas.push('price_truth');
    }
    return malas;
  };
  const marcas = async () => [...new Set((await q(`SELECT sku || '@' || fuente AS m FROM analytics.llaves_sucias`)).map((r) => r.m))].sort();
  const limpia = () => c.query(`DELETE FROM analytics.llaves_sucias`);
  const drena = async () => { const r = await q(`SELECT * FROM analytics.drenar_existencia()`); return { modo: r[0]?.modo, motivo: r[0]?.motivo, r }; };
  // Las marcas que dejó UNA acción: las de id mayor al último antes de ella (sin borrar la cola: lo anotado antes se drena después).
  const evento = async (nombre, accion, esperado) => {
    const desde = (await q(`SELECT COALESCE(max(id), 0)::bigint AS m FROM analytics.llaves_sucias`))[0].m;
    await accion();
    const got = [...new Set((await q(`SELECT sku || '@' || fuente AS m FROM analytics.llaves_sucias WHERE id > $1`, [desde])).map((r) => r.m))].sort();
    ok(JSON.stringify(got) === JSON.stringify([...esperado].sort()), `${nombre}: anota ${esperado.length ? esperado.join(', ') : 'nada'}`, `anotó: ${got.join(', ') || 'nada'}`);
  };
  /** Como la ingesta: un lote a una tabla temporal y un INSERT … ON CONFLICT DO UPDATE … WHERE IS DISTINCT FROM. */
  const comoIngesta = async (tabla, pk, cols, filas) => {
    const todas = [...pk, ...cols];
    // La base de CI crea las tablas del ODS desde el CSV de columnas, SIN su llave: el ON CONFLICT la necesita.
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_prueba_${tabla.split('.')[1]} ON ${tabla} (${pk.join(', ')})`);
    await c.query(`DROP TABLE IF EXISTS pg_temp.stg_e`);
    await c.query(`CREATE TEMP TABLE stg_e AS SELECT ${todas.join(', ')} FROM ${tabla} WITH NO DATA`);
    for (const f of filas) await c.query(`INSERT INTO stg_e (${todas.join(', ')}) VALUES (${f.map((_, i) => `$${i + 1}`).join(', ')})`, f);
    return (await c.query(`INSERT INTO ${tabla} AS t (${todas.join(', ')}) SELECT ${todas.join(', ')} FROM stg_e
      ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${cols.map((x) => `${x} = EXCLUDED.${x}`).join(', ')}
      WHERE (${cols.map((x) => `t.${x}`).join(', ')}) IS DISTINCT FROM (${cols.map((x) => `EXCLUDED.${x}`).join(', ')})`)).rowCount;
  };
  const drenaYCompara = async (esperoModo, esperoMotivo, que) => {
    const d = await drena();
    const malas = await todasIguales();
    ok(d.modo === esperoModo && d.motivo === esperoMotivo && malas.length === 0 && (await marcas()).length === 0,
      `${que}: drena en ${esperoModo} (${esperoMotivo}), la cola queda vacía y las cuatro tablas == sus vistas`,
      `${d.modo}/${d.motivo} distintas: ${malas.join(',') || '—'}`);
    return d;
  };

  await c.query('BEGIN');
  try {
    const { wh, pid } = await montarExistencia(c);
    await precio.up(knexLike);
    await factores.up(knexLike);
    await cola.up(knexLike);

    console.log('A. Instalado');
    const presentes = [];
    for (const f of cola.FUENTES) if ((await q(`SELECT to_regclass($1) IS NOT NULL AS hay`, [f.tabla]))[0].hay) presentes.push(f);
    const nTg = (await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'tg_exs_%' AND NOT tgisinternal`))[0].n;
    ok(presentes.length === cola.FUENTES.length && nTg === 4 * presentes.length, `${presentes.length} fuentes con sus 4 disparadores (${nTg})`);
    const unicos = (await q(`SELECT count(*)::int n FROM pg_index WHERE indrelid = 'analytics.llaves_sucias'::regclass AND indisunique AND NOT indisprimary`))[0].n;
    ok(unicos === 0, 'la cola no tiene llave única por SKU: un disparador nunca espera al que drena');
    ok((await marcas()).length === 0, 'el escenario se sembró antes: la cola nace vacía');
    const apagado = (await q(`SELECT encendida FROM analytics.existencia_por_evento`))[0];
    await c.query(`UPDATE kepler_ods.kdii SET c84 = 13 WHERE sucursal = 'Z1' AND c1 = 'F621A'`);
    ok(apagado && apagado.encendida === false && (await marcas()).length === 0, 'el interruptor nace APAGADO: una escritura pasa y no anota nada');
    await c.query(`UPDATE kepler_ods.kdii SET c84 = 12 WHERE sucursal = 'Z1' AND c1 = 'F621A'`);
    await c.query(`UPDATE analytics.existencia_por_evento SET encendida = true, updated_at = now()`);

    console.log('G. Otro recalculando (antes de la primera corrida: después, esta transacción ya tiene el candado)');
    const otra = new Client({ connectionString: URL });
    await otra.connect();
    await otra.query(`SELECT pg_advisory_lock(hashtext('analytics.recalcular_existencia'))`);
    const t0 = Date.now(); const ocupado = await drena(); const espero = Date.now() - t0;
    await otra.query(`SELECT pg_advisory_unlock(hashtext('analytics.recalcular_existencia'))`);
    await otra.end();
    ok(ocupado.modo === 'ocupado' && espero < 2000, `con el candado tomado en otra conexión: ocupado, sin esperar (${espero} ms)`, JSON.stringify(ocupado.r));

    console.log('B. La primera corrida del día');
    await drenaYCompara('completo', 'primero_del_dia', 'sin corridas hoy');
    const vacio = await drena();
    ok(vacio.modo === 'vacio', 'sin marcas: vacio, no recalcula', JSON.stringify(vacio.r));

    console.log('C. Cada fuente anota lo que tocó (y sólo eso)');
    const hoy = new Date();
    await evento('kdm1, un encabezado de venta sin líneas todavía', () => comoIngesta('kepler_ods.kdm1', PK1, ['c9', 'c43'],
      [['Z1', 'K', 'U', 'D', 3, 9001, 'A', hoy, 'N']]), []);
    await evento('kdm2, una línea de venta de A y una de COMPRA de G', () => comoIngesta('kepler_ods.kdm2', [...PK1, 'c7'], ['c8', 'c9', 'c11', 'c12'],
      [['Z1', 'K', 'U', 'D', 3, 9001, 'A', 1, 'F621A', 1, 'PZA', 10], ['Z1', 'K', 'X', 'A', 20, 9002, 'A', 1, 'F621G', 1, 'PZA', 5]]), ['F621A@kdm2']);
    await evento('kdm1, la venta se cancela (c43)', () => comoIngesta('kepler_ods.kdm1', PK1, ['c9', 'c43'],
      [['Z1', 'K', 'U', 'D', 3, 9001, 'A', hoy, 'S']]), ['F621A@kdm1']);
    await evento('kdm1, cambia una columna que ninguna regla lee (c10)', () => c.query(`UPDATE kepler_ods.kdm1 SET c10 = 'x' WHERE c5 = 9001`), []);
    await evento('kdii, cambia el factor de Z en Z1 (lote de la ingesta)', () => comoIngesta('kepler_ods.kdii', ['sucursal', 'c1'], ['c84'], [['Z1', 'F621Z', 24]]), ['F621Z@kdii']);
    await evento('kdii, el mismo lote otra vez (nada cambió: la ingesta no reescribe)', () => comoIngesta('kepler_ods.kdii', ['sucursal', 'c1'], ['c84'], [['Z1', 'F621Z', 24]]), []);
    await evento('kdii, sólo una fecha que ninguna regla lee (c50)', () => c.query(`UPDATE kepler_ods.kdii SET c50 = now() WHERE c1 = 'F621A'`), []);
    await evento('kdik, cambia el costo de A', () => c.query(`UPDATE kepler_ods.kdik SET c16 = 5.9 WHERE sucursal = 'Z1' AND c1 = 'Z1' AND c2 = 'F621A'`), ['F621A@kdik']);
    await evento('kdik, sólo las entradas acumuladas (c5)', () => c.query(`UPDATE kepler_ods.kdik SET c5 = 100 WHERE c2 = 'F621A'`), []);
    await evento('kdpv_prod_util, un escalón nuevo de C', () => c.query(`INSERT INTO kepler_ods.kdpv_prod_util (sucursal, c1, c2, c3, c7) VALUES ('Z1', 'F621C', 'PZA', 1, 20)`), ['F621C@kdpv_prod_util']);
    await evento('kdpv_prov_prod, cambia la caja de G y sale un proveedor', async () => {
      await c.query(`UPDATE kepler_ods.kdpv_prov_prod SET c4 = 250 WHERE sucursal = 'Z1' AND c2 = 'F621G'`);
      await c.query(`DELETE FROM kepler_ods.kdpv_prov_prod WHERE sucursal = 'Z2' AND c2 = 'F621G'`);
    }, ['F621G@kdpv_prov_prod']);
    await drenaYCompara('llave', 'cola', 'tras las fuentes del ERP');

    await evento('products, cambio de clave de C (anota la vieja y la nueva)', () => c.query(`UPDATE catalog.products SET sku = 'F621C2' WHERE id = $1`, [pid.F621C]), ['F621C2@products', 'F621C@products']);
    await evento('products, sólo el nombre', () => c.query(`UPDATE catalog.products SET nombre = nombre || ' (renombrado)' WHERE id = $1`, [pid.F621A]), []);
    await evento('products, se borra Z', () => c.query(`UPDATE catalog.products SET deleted_at = now() WHERE id = $1`, [pid.F621Z]), ['F621Z@products']);
    await drenaYCompara('llave', 'cola', 'tras el catálogo');

    await evento('etiquetas, cambia la caja de G', () => c.query(`UPDATE commercial.product_label_prices SET box_size = 30 WHERE product_id = $1`, [pid.F621G]), ['F621G@product_label_prices']);
    await evento('etiquetas, sólo el texto', () => c.query(`UPDATE commercial.product_label_prices SET content = 'x' WHERE product_id = $1`, [pid.F621G]), []);
    await evento('sustitución manual de C (ya con su clave nueva)', () => c.query(`UPDATE commercial.product_unit_overrides SET box_factor = 8 WHERE product_id = $1`, [pid.F621C]), ['F621C2@product_unit_overrides']);
    await evento('factor capturado de A', () => c.query(`UPDATE analytics.product_box_factor SET box_factor = 16 WHERE product_id = $1`, [pid.F621A]), ['F621A@product_box_factor']);
    if ((await q(`SELECT to_regclass('commercial.price_lists') IS NOT NULL AS hay`))[0].hay) {
      await c.query(`INSERT INTO commercial.price_lists (id, tenant_id, code, name) VALUES ($1, $3, 'F621RED', 'Red (prueba)'), ($2, $3, 'F621OTRA', 'Otra (prueba)')
        ON CONFLICT (id) DO NOTHING`, [RED, OTRA, M]);
    }
    await evento('precio de lista RED de G', () => c.query(`INSERT INTO commercial.product_prices (tenant_id, price_list_id, product_id, price) VALUES ($1, $2, $3, 9)`, [M, RED, pid.F621G]), ['F621G@product_prices']);
    await evento('precio de OTRA lista para H', () => c.query(`INSERT INTO commercial.product_prices (tenant_id, price_list_id, product_id, price) VALUES ($1, $2, $3, 9)`, [M, OTRA, pid.F621H]), []);
    await evento('Wincaja, cambia el factor del artículo crudo de B', () => c.query(`UPDATE wincaja.articulos SET factor_venta = 6 WHERE source_branch = 'ZW' AND source_dataset = 'actual' AND articulo = ' F621B '`), ['F621B@articulos']);
    await evento('Wincaja, un renglón del HISTÓRICO', () => c.query(`INSERT INTO wincaja.articulos (tenant_id, source_branch, source_dataset, articulo, factor_venta) VALUES ($1, 'ZW', 'historico', 'F621H', 3)`, [M]), []);
    await drenaYCompara('llave', 'cola', 'tras etiquetas, sustituciones, factores, precios y Wincaja');
    await evento('kdm2, sale la línea de venta de A', () => c.query(`DELETE FROM kepler_ods.kdm2 WHERE c5 = 9001`), ['F621A@kdm2']);
    await drenaYCompara('llave', 'cola', 'tras el borrado');

    console.log('D. Lo que obliga a recalcular todo');
    await evento('almacenes, sólo el nombre', () => c.query(`UPDATE commercial.warehouses SET name = name || ' ·' WHERE id = $1`, [wh.Z1]), []);
    await evento('almacenes, Z3 vuelve a la vida', () => c.query(`UPDATE commercial.warehouses SET deleted_at = NULL WHERE id = $1`, [wh.Z3]), ['*@warehouses']);
    await drenaYCompara('completo', 'marca_total', 'con un almacén cambiado');
    await evento('TRUNCATE de una fuente', () => c.query(`TRUNCATE kepler_ods.kdpv_prod_util`), ['*@kdpv_prod_util']);
    await drenaYCompara('completo', 'marca_total', 'tras un TRUNCATE');
    await c.query(`INSERT INTO analytics.llaves_sucias (sku, fuente) SELECT 'NO-' || g, 'prueba' FROM generate_series(1, ${precio.MAX_POR_LLAVE + 1}) g`);
    await drenaYCompara('completo', 'umbral', `con ${precio.MAX_POR_LLAVE + 1} SKUs distintos`);

    console.log('E. El disparador nunca frena la escritura');
    await c.query('SAVEPOINT e');
    await c.query(`ALTER TABLE analytics.llaves_sucias RENAME TO llaves_sucias_rota`);
    let paso = null;
    try { paso = (await c.query(`UPDATE kepler_ods.kdii SET c84 = 36 WHERE sucursal = 'Z1' AND c1 = 'F621Z'`)).rowCount; } catch (e) { paso = e.message; }
    const err = await q(`SELECT tabla, operacion, sqlstate FROM analytics.llaves_sucias_errores ORDER BY id DESC LIMIT 1`);
    await c.query('ROLLBACK TO SAVEPOINT e');
    ok(paso === 1 && err[0]?.tabla === 'kepler_ods.kdii' && err[0]?.operacion === 'UPDATE', 'con la cola rota la escritura pasa y la falla queda en llaves_sucias_errores',
      `${paso} ${JSON.stringify(err[0])}`);

    console.log('F. Si el recálculo falla, la cola queda intacta');
    await c.query('SAVEPOINT f');
    await c.query(`UPDATE kepler_ods.kdik SET c16 = 6.1 WHERE sucursal = 'Z1' AND c1 = 'Z1' AND c2 = 'F621A'`);
    await c.query(`ALTER TABLE analytics.kepler_unit_cost RENAME TO kepler_unit_cost_rota`);
    const fallo = await drena();
    const quedan = await marcas();
    const corrida = await q(`SELECT modo, mensaje FROM analytics.existencia_corridas ORDER BY id DESC LIMIT 1`);
    await c.query('ROLLBACK TO SAVEPOINT f');
    ok(fallo.modo === 'error' && quedan.includes('F621A@kdik') && corrida[0]?.modo === 'error' && /kepler_unit_cost/.test(corrida[0]?.mensaje || ''),
      'drena en error, la marca sigue en la cola y la falla queda escrita', `${fallo.modo} ${quedan.join(',')} ${JSON.stringify(corrida[0])}`);

    console.log('H. Al día siguiente');
    await c.query(`UPDATE analytics.existencia_corridas SET created_at = created_at - interval '1 day'`);
    await drenaYCompara('completo', 'primero_del_dia', 'con la última completa de ayer');
    const corridas = await q(`SELECT modo, motivo, resultado FROM analytics.existencia_corridas ORDER BY id`);
    ok(corridas.length >= 8 && corridas.every((r) => r.modo !== 'error' && Array.isArray(r.resultado) && r.resultado.length === 4),
      `cada corrida quedó escrita con sus cuatro tablas (${corridas.length})`, JSON.stringify(corridas.map((r) => `${r.modo}/${r.motivo}`)));

    console.log('I. Permisos');
    const p = (await q(`SELECT has_function_privilege('app_runtime', 'analytics.drenar_existencia()', 'EXECUTE') AS d,
        has_table_privilege('app_runtime', 'analytics.llaves_sucias', 'INSERT') AS i, has_table_privilege('app_runtime', 'analytics.llaves_sucias', 'DELETE') AS b,
        has_table_privilege('app_runtime', 'analytics.existencia_corridas', 'SELECT') AS s`))[0];
    await c.query('SAVEPOINT i'); await c.query('SET LOCAL ROLE app_runtime');
    let comoApp; try { comoApp = (await drena()).modo; } catch (e) { comoApp = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT i');
    ok(p.d && !p.i && !p.b && p.s && comoApp === 'vacio', 'app_runtime ejecuta drenar_existencia (vacio) y no escribe la cola', `${JSON.stringify(p)} ${comoApp}`);

    console.log('J. Lo que le cuesta a un lote de la ingesta');
    const lote = async (desde) => {
      const filas = Array.from({ length: 2000 }, (_, i) => ['Z1', 'K', 'U', 'D', 3, desde + Math.floor(i / 10), 'A', i % 10, ['F621A', 'F621G', 'F621H'][i % 3], 1, 'PZA', 10]);
      const t = process.hrtime.bigint();
      await comoIngesta('kepler_ods.kdm2', [...PK1, 'c7'], ['c8', 'c9', 'c11', 'c12'], filas);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const con = await lote(20000);
    await c.query(`ALTER TABLE kepler_ods.kdm2 DISABLE TRIGGER tg_exs_ins`);
    const sin = await lote(30000);
    await c.query(`ALTER TABLE kepler_ods.kdm2 ENABLE TRIGGER tg_exs_ins`);
    console.log(`     2,000 renglones de kdm2: ${con.toFixed(0)} ms con disparador, ${sin.toFixed(0)} ms sin él (incluye armar el lote)`);
    ok(con < sin * 3 + 300, 'el disparador no multiplica el costo del lote', `${con} vs ${sin}`);
    await limpia();

    console.log('L. El sensor de Salud BD, en cada estado');
    let S = null;
    try {
      require('ts-node').register({ transpileOnly: true, skipProject: true,
        compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', ignoreDeprecations: '6.0' } });
      S = require(path.resolve(__dirname, '..', '..', 'apps/api/src/modules/db-health/db-health-existencia-evento.ts'));
    } catch (e) { noMedido(`no se pudo cargar el sensor con ts-node: ${e.message}`); }
    if (S) {
      // Lo mismo que hace db-health: la edad que devuelve el SQL, clasificada con warnH 24 / critH 48.
      const sensor = async () => {
        const r = (await q(S.EXISTENCIA_EVENTO_SQL))[0];
        const h = (Date.now() - new Date(r.last_update).getTime()) / 3.6e6;
        return { estado: h >= 48 ? 'critical' : h >= 24 ? 'warn' : 'ok', nota: r.note_extra };
      };
      const en = async (nombre, preparar, esperado, nota) => {
        await c.query('SAVEPOINT l');
        await preparar();
        const s = await sensor();
        await c.query('ROLLBACK TO SAVEPOINT l');
        ok(s.estado === esperado && nota.test(s.nota || ''), `${nombre}: ${esperado}`, `${s.estado} — ${s.nota}`);
      };
      await en('encendido, cola vacía y completa de hoy', async () => undefined, 'ok', /árbitro: \d+ filas escritas/);
      await en('apagado', () => c.query(`UPDATE analytics.existencia_por_evento SET encendida = false`), 'warn', /APAGADO/);
      await en('un disparador no pudo anotar', () => c.query(`INSERT INTO analytics.llaves_sucias_errores (tabla, operacion, sqlstate, mensaje)
        VALUES ('kepler_ods.kdii', 'UPDATE', '42P01', 'prueba')`), 'warn', /1 fallas de los disparadores en 24 h \(kepler_ods\.kdii:UPDATE\)/);
      await en('la última corrida falló', () => c.query(`INSERT INTO analytics.existencia_corridas (modo, motivo, mensaje) VALUES ('error', 'cola', 'XX000 prueba')`),
        'critical', /FALLÓ \(XX000 prueba\)/);
      await en('una marca de hace 20 min en la cola', () => c.query(`INSERT INTO analytics.llaves_sucias (sku, fuente, created_at) VALUES ('F621A', 'prueba', now() - interval '20 minutes')`),
        'critical', /1 marcas en la cola.*no está corriendo/);
      await en('una marca de hace 1 min (el worker va a tiempo)', () => c.query(`INSERT INTO analytics.llaves_sucias (sku, fuente, created_at) VALUES ('F621A', 'prueba', now() - interval '1 minute')`),
        'ok', /cola: 1 marcas/);
      await en('sin completa en 30 h', () => c.query(`UPDATE analytics.existencia_corridas SET created_at = created_at - interval '2 days'`),
        'warn', /sin recálculo completo en 30 h/);
    }

    console.log('K. Idempotencia y down()');
    await cola.up(knexLike);
    const nTg2 = (await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'tg_exs_%' AND NOT tgisinternal`))[0].n;
    ok(nTg2 === nTg, `up() otra vez: los mismos ${nTg} disparadores, sin duplicar`);
    await cola.down(knexLike);
    const queda = (await q(`SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'tg_exs_%') AS tg,
        to_regclass('analytics.llaves_sucias') AS c, to_regprocedure('analytics.drenar_existencia()') AS d,
        to_regclass('analytics.existencia_por_evento') AS i`))[0];
    let escribe = null; try { escribe = (await c.query(`UPDATE kepler_ods.kdii SET c84 = 40 WHERE sucursal = 'Z1' AND c1 = 'F621Z'`)).rowCount; } catch (e) { escribe = e.message; }
    ok(queda.tg === 0 && !queda.c && !queda.d && !queda.i && escribe === 1, 'down(): sin disparadores, cola, interruptor ni función, y las fuentes se escriben igual', `${JSON.stringify(queda)} ${escribe}`);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  salir();
})().catch((e) => { console.error('  ✗ excepción:', e.stack || e.message); process.exit(1); });
