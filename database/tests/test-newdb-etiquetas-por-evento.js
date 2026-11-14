#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.19]` La etiqueta de anaquel y el EAN del catálogo se mantienen AL LLEGAR el cambio de `kdii`, sin
 * `import-label-data.js` cada 30 min. La etiqueta ya la escribía el hop-2 (`normalizeLabelsFromOds`); lo que el script
 * aportaba de más era el EAN de `catalog.products.barcode` cuando la ficha trae el SKU en `c7` y el EAN en `c95`. Eso
 * pasa a `normalizeProductsFromOds`. Contra una base real, dentro de una transacción que se revierte:
 *
 *   J. NEGATIVA: con la normalización apagada, un SKU nuevo de Kepler no da de alta producto ni etiqueta.
 *   B. Alta con marcador en c7 y EAN en c95: el producto nace con el EAN.
 *   C. Producto con un código basura (CB11…): toma el EAN.
 *   D. El EAN ya lo tiene otro producto, vivo con otro SKU (D1) o borrado (D2): no se toma; queda el marcador.
 *   E. Dos del mismo lote con el mismo EAN libre: se lo queda el de SKU menor.
 *   F. Un EAN-8 que ya tiene (el caso BOING de CANON.6.7): se respeta, 0 escrituras.
 *   G. ⭐ Ya tiene el EAN de c95 y c7 trae basura larga: NO se escribe nada (sin la guarda, la regla de identidad
 *      escribiría la basura y el paso del EAN lo regresaría: dos escrituras por evento).
 *   H. c7 de la plaza canónica YA es EAN: gana ése, no el c95 de otra plaza (lo de siempre).
 *   I. Gana el EAN de la plaza MENOR que nadie tenga (la 00 lo tiene otro producto → el de la 01, no el de la 02).
 *   K. El nombre lo frena la unique (marca, nombre): el EAN entra igual (no depende del nombre).
 *   L. Un alta del MISMO lote se queda con el EAN por su c7: el existente que lo traía en c95 no lo duplica.
 *   M. Sin churn: la segunda pasada escribe 0.
 *   R. El camino real (`raw-upsert` de kdii): producto con EAN y su etiqueta (precio y código) en una sola llegada.
 *   A. El árbitro (`ARBITRO_ETIQUETAS_SQL`, el MISMO .ts de db-health): un precio distinto, una etiqueta que falta y un
 *      producto sin su EAN suman 3; una fila `manual` no cuenta; corrido el hop-2, vuelve a la base.
 *
 * Sin base: NO MEDIDO, nunca ✔. Sin ts-node: A queda NO MEDIDO.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-etiquetas-por-evento', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const { applyRawUpsert, normalizeProductsFromOds } = require('../../services/feeds-ingest/apply-handlers');
const RAIZ = path.resolve(__dirname, '..', '..');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const TXT = ['sucursal', 'c1', 'c2', 'c3', 'c7', 'c11', 'c80', 'c83', 'c95'];
const NUM = ['c81', 'c84', 'c90', 'c91', 'c92'];
const KDII = { table: 'kdii', pk: ['c1'], columns: TXT.map((name) => ({ name, type: 'text' })).concat(NUM.map((name) => ({ name, type: 'numeric' }))) };
const kd = (sucursal, c1, c2, c7, c95, c90 = 10) => ({ sucursal, c1, c2, c3: 'L619', c7, c11: 'PZA', c80: null, c83: null, c95,
  c81: null, c84: null, c90, c91: null, c92: null });

(async () => {
  console.log('\n[CANON.6.19] etiquetas y EAN por evento (kdii / kdpv_prod_util)\n');
  let A = null;
  try {
    require('ts-node').register({ transpileOnly: true, skipProject: true,
      compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', ignoreDeprecations: '6.0' } });
    A = require(path.join(RAIZ, 'apps/api/src/modules/db-health/db-health-arbitro-catalogo.ts'));
  } catch (e) { A = null; console.log(`  (sin ts-node: ${String(e.message).slice(0, 80)})`); }
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const db = dentroDeLaPrueba(c);
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  // `errores` junta lo que la ingesta imprime por console.error: ahí avisa si un normalizador falló (y se reintentó).
  const errores = [];
  const callado = async (fn) => { const l = console.log; const e = console.error; console.log = () => {}; console.error = (...a) => { errores.push(a.join(' ')); };
    try { return await fn(); } finally { console.log = l; console.error = e; } };
  const prod = async (sku) => (await q(`SELECT id, nombre, barcode FROM catalog.products WHERE tenant_id=$1 AND sku=$2 AND deleted_at IS NULL`, [M, sku]))[0] || null;
  const bc = async (sku) => ((await prod(sku)) || {}).barcode;
  const arbitro = async () => {
    const nota = String((await q(A.ARBITRO_ETIQUETAS_SQL))[0].note_extra || '');
    const m = /^(\d+) sin tomar/.exec(nota);
    return { n: /^NO MEDIDO/.test(nota) ? null : /: 0 difieren de/.test(nota) || /^CUMPLIÓ/.test(nota) ? 0 : m ? Number(m[1]) : undefined, nota };
  };

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual; las columnas que lee la regla se agregan) ─────────────
    for (const s of ['kepler_ods', 'catalog', 'commercial', 'analytics']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, PRIMARY KEY (sucursal, c1))`);
    for (const col of TXT.slice(2)) await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS ${col} text`);
    for (const col of NUM) await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS ${col} numeric`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prod_util (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL,
      c3 numeric NOT NULL, c4 numeric, c5 numeric, c6 numeric, c7 numeric, PRIMARY KEY (sucursal, c1, c2, c3))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, barcode varchar, source varchar, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(), deleted_at timestamptz, UNIQUE (tenant_id, brand_id, nombre))`);
    // Las columnas y la llave de prod (medidas el 14-nov).
    await c.query(`CREATE TABLE IF NOT EXISTS commercial.product_label_prices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      product_id uuid NOT NULL, content varchar, barcode varchar, barcode_format varchar, piece_price numeric(12,4),
      wholesale_piece_min_qty integer, wholesale_piece_price numeric(12,4), pack_size integer, pack_price numeric(12,4),
      wholesale_pack_price numeric(12,4), box_size integer, box_price numeric(12,4), source varchar, computed_at timestamptz,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), unit_base varchar, wholesale_pack_min_qty integer,
      sold_by_kg boolean, sucursal varchar)`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_t619_label_prices ON commercial.product_label_prices (tenant_id, product_id, sucursal)`);
    // Las bitácoras que lee la condición de retiro del árbitro (en una base migrada ya existen).
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.cron_run_log (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, job_key text NOT NULL,
      status text NOT NULL, finished_at timestamptz, logged_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.db_health_alerts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      source_key varchar NOT NULL, status varchar NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);

    const marca = async (code) => (await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, $2, $3) RETURNING id`, [M, `Marca ${code}`, code]))[0].id;
    if (!(await q(`SELECT 1 FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA'`, [M])).length) await marca('SIN-LINEA');
    const L = await marca('L619');
    const alta = (sku, nombre, barcode, borrado = false) => c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, barcode, deleted_at)
      VALUES ($1, $2, $3, $4, $5, ${borrado ? 'now()' : 'NULL'})`, [M, L, sku, nombre, barcode]);
    // Una etiqueta neutra (producto sin filas en kdii) para que el árbitro vea la tabla: con 0 a la vista dice NO MEDIDO.
    await alta('96100', 'NEUTRO T619', '7509610000017');
    await c.query(`INSERT INTO commercial.product_label_prices (tenant_id, product_id, sucursal, piece_price, source)
      SELECT $1, id, '01', 1, 'kepler' FROM catalog.products WHERE tenant_id=$1 AND sku='96100'`, [M]);
    const base = A ? await arbitro() : null;

    await alta('96191', 'C T619', 'CB1196191');
    await alta('96192', 'D1 T619', 'CB1196192');
    await alta('96199', 'OTRO T619', '7509619200015');       // tiene el EAN de D1
    await alta('96193', 'D2 T619', 'CB1196193');
    await alta('96183', 'BORRADO T619', '7509619300012', true); // borrado, con el EAN de D2
    await alta('96194', 'E1 T619', 'CB1196194');
    await alta('96195', 'E2 T619', 'CB1196195');
    await alta('96196', 'F T619', '75019619');                // EAN-8 (BOING)
    await alta('96197', 'G T619', '7509619700010');
    await alta('96198', 'H T619', 'CB1196198');
    await alta('96189', 'I T619', 'CB1196189');
    await alta('96188', 'OTRO2 T619', '7509618900001');      // tiene el EAN de la plaza 00 de I
    await alta('96187', 'VIEJO K T619', 'CB1196187');
    await alta('96182', 'CHOQUE T619', '7509618200019');     // ya se llama como Kepler quiere llamar a K
    await alta('96184', 'L EXISTENTE T619', 'CB1196184');
    const FILAS = [
      kd('01', '96190', 'NUEVO B T619', '096190', '7509619000011'),
      kd('01', '96191', 'C T619', '096191', '7509619100018'),
      kd('01', '96192', 'D1 T619', '096192', '7509619200015'),
      kd('01', '96193', 'D2 T619', '096193', '7509619300012'),
      kd('01', '96194', 'E1 T619', '096194', '7509619400019'),
      kd('01', '96195', 'E2 T619', '096195', '7509619400019'),
      kd('01', '96196', 'F T619', '96196', '75019619'),
      kd('01', '96197', 'G T619', '9619712345', '7509619700010'),
      kd('01', '96198', 'H T619', '7509619800017', null, 20),
      kd('02', '96198', 'H T619', '096198', '7509619899991'),
      kd('00', '96189', 'I T619', '096189', '7509618900001'),
      kd('01', '96189', 'I T619', '096189', '7509618900018'),
      kd('02', '96189', 'I T619', '096189', '7509618900025'),
      kd('01', '96187', 'CHOQUE T619', '096187', '7509618700014'),
      kd('01', '96185', 'NUEVO L T619', '7509618500012', null),
      kd('01', '96184', 'L EXISTENTE T619', '096184', '7509618500012'),
    ];
    const SKUS = [...new Set(FILAS.map((f) => f.c1))];

    // ── J (negativa) ──────────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [kd('01', '96186', 'NEG T619', '096186', '7509618600017')], { ...KDII, normalize: false }));
    ok(!(await prod('96186')) && !(await q(`SELECT 1 FROM commercial.product_label_prices l JOIN catalog.products p ON p.id = l.product_id
        WHERE p.sku = '96186'`)).length, 'NEGATIVA: con la normalización apagada no nace el producto ni su etiqueta');

    // ── B–L. El normalizador, llamado directo (una falla revienta aquí en vez de reintentarse por partes) ───────────
    await callado(() => applyRawUpsert(db, M, FILAS, { ...KDII, normalize: false }));
    let tiro = null;
    try { await normalizeProductsFromOds(db, M, SKUS); } catch (e) { tiro = e.message; }
    ok(!tiro, 'el lote completo se normaliza sin reventar', tiro);
    ok(await bc('96190') === '7509619000011', 'B. alta con el SKU en c7 y el EAN en c95: nace con el EAN', await bc('96190'));
    ok(await bc('96191') === '7509619100018', 'C. código basura (CB11…): toma el EAN', await bc('96191'));
    ok(await bc('96192') === '096192' && await bc('96199') === '7509619200015',
      'D1. el EAN lo tiene otro producto vivo: no se toma (queda el marcador) y el otro lo conserva', `${await bc('96192')} | ${await bc('96199')}`);
    ok(await bc('96193') === '096193', 'D2. el EAN lo tiene un producto BORRADO: tampoco se toma', await bc('96193'));
    ok(await bc('96194') === '7509619400019' && await bc('96195') === '096195',
      'E. dos del lote con el mismo EAN libre: se lo queda el de SKU menor, el otro no lo duplica', `${await bc('96194')} | ${await bc('96195')}`);
    ok(await bc('96196') === '75019619', 'F. el EAN-8 que ya tenía se respeta', await bc('96196'));
    ok(await bc('96197') === '7509619700010', 'G. ya tenía el EAN de c95 con basura larga en c7: lo conserva', await bc('96197'));
    ok(await bc('96198') === '7509619800017', 'H. c7 de la plaza canónica ya es EAN: gana ése, no el c95 de otra plaza', await bc('96198'));
    ok(await bc('96189') === '7509618900018', 'I. gana el EAN de la plaza menor que nadie tenga (01), no el de la 00 ocupada ni el de la 02', await bc('96189'));
    const K = await prod('96187');
    ok(K && K.barcode === '7509618700014' && K.nombre === 'VIEJO K T619',
      'K. el nombre lo frena la unique (marca, nombre) y el EAN entra igual', JSON.stringify(K));
    ok(await bc('96185') === '7509618500012' && await bc('96184') === '096184',
      'L. el alta del mismo lote se queda con su EAN de c7 y el existente no lo duplica', `${await bc('96185')} | ${await bc('96184')}`);

    // ── M. Sin churn, y G en particular sin escrituras ────────────────────────────────────────
    const n2 = await normalizeProductsFromOds(db, M, SKUS);
    ok(n2 === 0, 'M. segunda pasada sin cambios en Kepler: 0 filas', `n=${n2}`);
    const nFG = await normalizeProductsFromOds(db, M, ['96196', '96197']);
    ok(nFG === 0, 'F y G otra vez solos: 0 escrituras (la guarda evita escribir la basura y regresar el EAN)', `n=${nFG}`);

    // ── R. El camino real ────────────────────────────────────────────────────────────────────
    errores.length = 0;
    await callado(() => applyRawUpsert(db, M, [kd('01', '96181', 'REAL T619', '096181', '7509618100017', 12.5)], KDII));
    const R = await prod('96181');
    const etR = R ? await q(`SELECT barcode, piece_price::text AS pp FROM commercial.product_label_prices WHERE tenant_id=$1 AND product_id=$2 AND sucursal='01'`, [M, R.id]) : [];
    const fallaron = errores.filter((e) => /normalize:kdii:(normalizeProductsFromOds|normalizeLabelsFromOds)\]/.test(e));
    ok(R && R.barcode === '7509618100017' && etR.length === 1 && etR[0].barcode === '7509618100017' && Number(etR[0].pp) === 12.5 && !fallaron.length,
      'R. un raw-upsert de kdii da de alta el producto con su EAN y su etiqueta (precio y código), sin fallas del hop-2',
      `${JSON.stringify(R)} · ${JSON.stringify(etR)} · ${fallaron.join(' | ').slice(0, 200)}`);

    // ── A. El árbitro ────────────────────────────────────────────────────────────────────────
    if (!A) {
      noMedido('el árbitro (sin ts-node no se carga el .ts de db-health)');
    } else {
      // Etiquetas de todo el escenario por el camino real (el hop-2 corre para TODAS las llaves del lote).
      await callado(() => applyRawUpsert(db, M, FILAS, KDII));
      const a0 = await arbitro();
      ok(base && base.n != null && a0.n === base.n, 'A. con el hop-2 recién corrido el árbitro vuelve a la base', `base=${base && base.n} · ahora=${a0.n} · ${a0.nota}`);
      const C = await prod('96191'); const D1 = await prod('96192');
      await c.query(`UPDATE commercial.product_label_prices SET piece_price = 99 WHERE product_id = $1 AND sucursal = '01'`, [C.id]);
      await c.query(`DELETE FROM commercial.product_label_prices WHERE product_id = $1 AND sucursal = '01'`, [D1.id]);
      await c.query(`UPDATE catalog.products SET barcode = 'CB1196191' WHERE id = $1`, [C.id]);
      const a3 = await arbitro();
      ok(a3.n === base.n + 3, 'un precio distinto, una etiqueta que falta y un producto sin su EAN: el árbitro suma 3', `n=${a3.n} · ${a3.nota}`);
      await c.query(`UPDATE commercial.product_label_prices SET source = 'manual' WHERE product_id = $1 AND sucursal = '01'`, [C.id]);
      const a2 = await arbitro();
      ok(a2.n === base.n + 2, 'la etiqueta puesta a mano (`manual`) no cuenta: la regla no la pisa', `n=${a2.n}`);
      await callado(() => applyRawUpsert(db, M, FILAS, KDII));
      const a4 = await arbitro();
      const etC = (await q(`SELECT piece_price::text AS pp, source FROM commercial.product_label_prices WHERE product_id = $1 AND sucursal = '01'`, [C.id]))[0];
      ok(a4.n === base.n && await bc('96191') === '7509619100018' && etC.source === 'manual' && Number(etC.pp) === 99,
        'corrido el hop-2: vuelve a la base, el EAN regresa y la fila manual queda como estaba', `n=${a4.n} · ${JSON.stringify(etC)}`);
    }
  } catch (e) {
    fail++; console.log('  ✗ excepción:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  salir();
})();
