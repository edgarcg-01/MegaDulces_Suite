#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[CANON.6.21]` Oleada 8b, paso 2: el precio de venta por llave — `analytics.price_truth_de(skus)`, la tabla
 * `analytics.price_truth` y `analytics.recalcular_existencia(skus)`. Ejerce el `up()` REAL de la migración
 * 20261114124213 (no su SQL retipeado), dentro de una transacción que se revierte, sobre un escenario sintético en
 * almacenes de prueba Z1/Z2 (Z3 borrado) que pasa por TODAS las ramas de la regla: lo cobrado (moda, empate hacia el
 * mayor, el día 90 justo), lo configurado y los cuatro rechazos; documentos cancelados, viejos, de otro tipo, de 3 piezas
 * y en otra unidad; producto en promoción, borrado y con espacios en la clave.
 *
 *   A. ⭐ Dos implementaciones: `price_truth_de(NULL)` da IDÉNTICO a `analytics.mv_price_truth` (la que crea su migración
 *      original, 20261005140000, o la que ya exista en la base, refrescada).
 *   B. Lo esperado por rama (que la igualdad de A no sea entre dos cosas iguales por accidente).
 *   C. ⭐ Por llave == completa filtrada: cada SKU solo, un par, todos y uno que no existe.
 *   D. Recálculo completo: la tabla queda igual a la función; la segunda pasada no escribe nada (mismo ctid).
 *   E. ⭐ Una venta más: antes de recalcular la tabla está vieja; por llave cambia SÓLO esa fila (las demás, mismo ctid).
 *   F. Producto borrado: sus filas salen por llave.
 *   G. Cambio de clave: recalcular sólo la clave nueva deja la tabla igual a la completa.
 *   H. ⭐ Con MAX_POR_LLAVE SKUs sigue por llave (no ve un cambio ajeno); con uno más pasa a completo (sí lo ve).
 *   I. Lista vacía o de puros blancos: 0/0/0; la clave con espacios se normaliza.
 *   J. Permisos: app_runtime lee la tabla y ejecuta recalcular_existencia; no escribe la tabla ni ejecuta price_truth_de.
 *      Las dos funciones llevan jit=off (sin eso, 200 SKUs pasan de 0.7 a 10 s en prod).
 *   K. up() dos veces; down() lo quita.
 *
 * Mutantes (2026-11-14, en una copia fuera del árbol): mueren 9 de 10 — sin las condiciones del documento por llave,
 * la moda hacia el menor, el upsert sin guarda de cambio, el borrado sin acotar, sin borrado, sin el umbral, la regla
 * sin jit=off, el escalón filtrado por otra columna, sin normalizar la lista. Equivalente (declarado): quitar el filtro
 * final del producto en la forma por llave — el join con base_unit, ya acotado, deja fuera a los demás; es sólo poda.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/t621_precio \
 *     node database/tests/test-newdb-precio-por-llave.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-precio-por-llave', { url: URL });
const { Client } = require('pg');
const migracion = require('../migrations-newdb/20261114124213_canon621_price_truth_por_llave.js');
const original = require('../migrations-newdb/20261005140000_mv_price_truth_pos.js');

const M = '00000000-0000-0000-0000-00000000d01c';
const RED = '00000000-0000-0000-0000-0000c0ffee02';
const COLS = 'tenant_id, warehouse_id, sucursal, product_id, sku, precio, fuente, lineas_pos, precio_config, rechazo, precio_lista, veredicto';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };
const firma = (rows) => rows.map((r) => JSON.stringify(r)).sort().join('\n');

(async () => {
  console.log('\n[CANON.6.21] precio por llave (price_truth_de · price_truth · recalcular_existencia)\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const knexLike = { raw: (sql) => c.query(sql) };
  const fn = (skus) => q(`SELECT ${COLS} FROM analytics.price_truth_de($1::text[])`, [skus]);
  const tabla = () => q(`SELECT ${COLS} FROM analytics.price_truth`);
  const ctids = async () => Object.fromEntries((await q(`SELECT warehouse_id || '/' || product_id AS k, ctid::text AS t FROM analytics.price_truth`)).map((r) => [r.k, r.t]));
  const recalcula = async (skus) => {
    const r = (await q(`SELECT * FROM analytics.recalcular_existencia($1::text[])`, [skus]))[0];
    return `${r.objeto} ${r.insertadas}/${r.actualizadas}/${r.borradas}`;
  };
  const igualALaCompleta = async () => firma(await tabla()) === firma(await fn(null));

  await c.query('BEGIN');
  try {
    // ── Andamio mínimo con los tipos de prod (lo que ya exista en la base se usa tal cual) ──────────────────────
    for (const r of ['app_runtime', 'dev_ro']) {
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
    }
    for (const s of ['kepler_ods', 'catalog', 'commercial', 'analytics']) {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
      await c.query(`GRANT USAGE ON SCHEMA ${s} TO app_runtime`);
    }
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, PRIMARY KEY (sucursal, c1))`);
    await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS c11 text`);
    await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS c90 numeric`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdm1 (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL, c3 text NOT NULL,
      c4 numeric NOT NULL, c5 numeric NOT NULL, c6 text NOT NULL, PRIMARY KEY (sucursal, c1, c2, c3, c4, c5, c6))`);
    await c.query(`ALTER TABLE kepler_ods.kdm1 ADD COLUMN IF NOT EXISTS c9 timestamp`);
    await c.query(`ALTER TABLE kepler_ods.kdm1 ADD COLUMN IF NOT EXISTS c43 text`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdm2 (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL, c3 text NOT NULL,
      c4 numeric NOT NULL, c5 numeric NOT NULL, c6 text NOT NULL, c7 numeric NOT NULL, PRIMARY KEY (sucursal, c1, c2, c3, c4, c5, c6, c7))`);
    for (const [col, t] of [['c8', 'text'], ['c9', 'double precision'], ['c11', 'text'], ['c12', 'numeric']]) {
      await c.query(`ALTER TABLE kepler_ods.kdm2 ADD COLUMN IF NOT EXISTS ${col} ${t}`);
    }
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prod_util (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL,
      c3 numeric NOT NULL, c4 numeric, c5 numeric, c6 numeric, c7 numeric, PRIMARY KEY (sucursal, c1, c2, c3))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, deleted_at timestamptz)`);
    await c.query(`ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS cost_base numeric`);
    await c.query(`ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS is_promo boolean NOT NULL DEFAULT false`);
    await c.query(`CREATE TABLE IF NOT EXISTS commercial.warehouses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      code varchar(50) NOT NULL, name varchar NOT NULL, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS commercial.product_prices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      price_list_id uuid NOT NULL, product_id uuid NOT NULL, price numeric(14,4) NOT NULL, deleted_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);

    // ── Escenario ───────────────────────────────────────────────────────────────────────────────────────────────
    for (const [code, borrado] of [['Z1', false], ['Z2', false], ['Z3', true]]) {
      await c.query(`INSERT INTO commercial.warehouses (tenant_id, code, name, deleted_at) VALUES ($1, $2, $3, ${borrado ? 'now()' : 'NULL'})`, [M, code, `Prueba ${code}`]);
    }
    const marca = (await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, 'Marca L621', 'L621') RETURNING id`, [M]))[0].id;
    const alta = (sku, costo, { promo = false, borrado = false } = {}) => c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, cost_base, is_promo, deleted_at)
      VALUES ($1, $2, $3, $4, $5, $6, ${borrado ? 'now()' : 'NULL'})`, [M, marca, sku, `Producto ${sku}`, costo, promo]);
    await alta('P621A', 5); await alta('P621B', 10); await alta('P621C', 10); await alta('P621D', 3); await alta('P621E', 6);
    await alta('P621F', 1, { promo: true }); await alta('P621G', 1, { borrado: true }); await alta(' P621H ', 1);
    const kdii = (suc, sku, pv, unidad = 'PZA') => c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c11, c90) VALUES ($1, $2, $3, $4)`, [suc, sku, unidad, pv]);
    for (const s of ['Z1', 'Z2', 'Z3']) await kdii(s, 'P621A', 9.5);
    await kdii('Z1', 'P621B', 20.004);
    await kdii('Z1', 'P621C', 50); await kdii('Z2', 'P621C', 50);
    await kdii('Z1', 'P621D', 0.05); await kdii('Z2', 'P621D', 8);
    await kdii('Z1', 'P621E', 9.5); await kdii('Z2', 'P621E', 5);
    await kdii('Z1', 'P621F', 10); await kdii('Z1', 'P621G', 10); await kdii('Z1', 'P621H', 3);
    await kdii('Z1', 'P621I', 4); await kdii('Z2', 'P621I', 4);
    const escalon = (suc, sku, unidad, tope) => c.query(`INSERT INTO kepler_ods.kdpv_prod_util (sucursal, c1, c2, c3, c4, c7) VALUES ($1, $2, $3, 1, 1, $4)`, [suc, sku, unidad, tope]);
    await escalon('Z2', 'P621D', 'PZA', 10); await escalon('Z1', 'P621E', 'PZA', 10); await escalon('Z2', 'P621E', 'CJA', 100);
    const precioLista = (sku, p) => c.query(`INSERT INTO commercial.product_prices (tenant_id, price_list_id, product_id, price)
      SELECT $1, $2, id, $4 FROM catalog.products WHERE tenant_id = $1 AND btrim(sku) = $3 AND deleted_at IS NULL`, [M, RED, sku, p]);
    await precioLista('P621A', 10); await precioLista('P621C', 40); await precioLista('P621E', 9.5);
    let folio = 0;
    const venta = async (suc, sku, precios, { c4 = 3, dias = 0, cancelado = 'N', qty = 1, unidad = 'PZA' } = {}) => {
      const f = ++folio;
      await c.query(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c43) VALUES ($1, 'K', 'U', 'D', $2, $3, 'A', current_date - $4::int, $5)`,
        [suc, c4, f, dias, cancelado]);
      let n = 0;
      for (const p of precios) {
        await c.query(`INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c11, c12) VALUES ($1, 'K', 'U', 'D', $2, $3, 'A', $4, $5, $6, $7, $8)`,
          [suc, c4, f, ++n, sku, qty, unidad, p]);
      }
    };
    const cinco = (p) => [p, p, p, p, p];
    await venta('Z1', 'P621A', [10, 10, 10, 10, 10, 10]); await venta('Z1', 'P621A', cinco(12));      // moda 10, 11 líneas
    await venta('Z2', 'P621A', [...cinco(12), ...cinco(11)]);                                           // empate → el mayor
    await venta('Z3', 'P621A', cinco(7));                                                               // almacén borrado
    await venta('Z1', 'P621B', [20, 20, 20, 20]);                                                       // 4 < 5 → configurado
    await venta('Z1', 'P621C', cinco(30), { cancelado: 'S' });
    await venta('Z1', 'P621C', cinco(30), { dias: 91 });
    await venta('Z1', 'P621C', cinco(30), { c4: 99 });
    await venta('Z1', 'P621C', cinco(30), { qty: 3 });
    await venta('Z1', 'P621C', cinco(30), { unidad: 'CJA' });
    await venta('Z2', 'P621C', cinco(33), { dias: 90 });                                                // el día 90 sí cuenta
    await venta('Z1', 'P621F', cinco(9)); await venta('Z1', 'P621G', cinco(9));
    await venta('Z1', ' P621H', cinco(3.5));                                                            // clave con espacios en kdm2

    // ── La migración original de la matview (o la que ya exista), y la nueva ─────────────────────────────────────
    const habia = (await q(`SELECT to_regclass('analytics.mv_price_truth') IS NOT NULL AS si`))[0].si;
    if (habia) await c.query(`REFRESH MATERIALIZED VIEW analytics.mv_price_truth`);
    else await original.up(knexLike);
    await migracion.up(knexLike);

    // A ─ dos implementaciones
    const completa = await fn(null);
    const mv = await q(`SELECT ${COLS} FROM analytics.mv_price_truth`);
    ok(completa.length > 0 && firma(completa) === firma(mv),
      `A. price_truth_de(NULL) == mv_price_truth (${habia ? 'la que había, refrescada' : 'creada por 20261005140000'}): ${completa.length}/${mv.length} filas`);

    // B ─ lo esperado por rama
    const fila = (sku, suc) => completa.find((r) => r.sku === sku && r.sucursal === suc) || null;
    const es = (sku, suc, precio, fuente, rechazo, veredicto, lineas) => {
      const r = fila(sku, suc);
      const got = r && `${r.precio == null ? null : Number(r.precio)}|${r.fuente}|${r.rechazo}|${r.veredicto}|${r.lineas_pos}`;
      ok(got === `${precio}|${fuente}|${rechazo}|${veredicto}|${lineas}`, `B. ${sku}/${suc}: ${fuente}${rechazo ? ' ' + rechazo : ''} ${precio ?? ''} ${veredicto}`, got || 'no salió');
    };
    es('P621A', 'Z1', 10, 'pos', null, 'cuadra', 11);
    es('P621A', 'Z2', 12, 'pos', null, 'difiere', 10);
    es('P621B', 'Z1', 20, 'config', null, 'sin_precio_lista', null);
    es('P621C', 'Z1', null, 'rechazado', 'sobre_costo', 'sin_precio_medible', null);
    es('P621C', 'Z2', 33, 'pos', null, 'difiere', 5);
    es('P621D', 'Z1', null, 'rechazado', 'sin_precio', 'sin_precio_lista', null);
    es('P621D', 'Z2', null, 'rechazado', 'bajo_su_escalon', 'sin_precio_lista', null);
    es('P621E', 'Z1', 9.5, 'config', null, 'cuadra', null);
    es('P621E', 'Z2', null, 'rechazado', 'bajo_costo', 'sin_precio_medible', null);
    es('P621H', 'Z1', 3.5, 'pos', null, 'sin_precio_lista', 5);
    ok(!completa.some((r) => ['P621F', 'P621G', 'P621I'].includes(r.sku) || r.sucursal === 'Z3'),
      'B. sin promoción, sin borrado, sin producto (P621I) y sin el almacén borrado');

    // C ─ por llave == completa filtrada
    const todos = ['P621A', 'P621B', 'P621C', 'P621D', 'P621E', 'P621F', 'P621G', 'P621H', 'P621I'];
    const malos = [];
    for (const lote of [...todos.map((s) => [s]), ['NO-EXISTE'], ['P621A', 'P621C'], todos]) {
      const esperado = firma(completa.filter((r) => lote.includes(r.sku)));
      if (firma(await fn(lote)) !== esperado) malos.push(lote.join(','));
    }
    ok(!malos.length, `C. por llave == completa filtrada (${todos.length} SKUs solos, uno inexistente, un par y todos)`, malos.join(' · '));

    // D ─ recálculo completo, y sin churn
    await c.query(`DELETE FROM analytics.price_truth`);
    const r1 = await recalcula(null);
    ok(r1 === `price_truth ${completa.length}/0/0` && await igualALaCompleta(), `D. completo: ${r1} y la tabla == la función`);
    const antes = await ctids();
    const r2 = await recalcula(null);
    ok(r2 === 'price_truth 0/0/0' && JSON.stringify(await ctids()) === JSON.stringify(antes), `D. la segunda pasada no escribe (${r2}, mismo ctid)`);

    // E ─ un evento: una venta más de B (llega a 5 líneas → pasa a lo cobrado)
    await venta('Z1', 'P621B', [21]);
    ok(!(await igualALaCompleta()), 'E. (control) con la venta nueva y sin recalcular, la tabla ya no es la completa');
    const e0 = await ctids();
    const r3 = await recalcula(['P621B']);
    const e1 = await ctids();
    const idB = (await q(`SELECT id FROM catalog.products WHERE tenant_id = $1 AND sku = 'P621B'`, [M]))[0].id;
    const reescritas = Object.keys(e0).filter((k) => e0[k] !== e1[k]);
    ok(r3 === 'price_truth 0/1/0' && await igualALaCompleta(), `E. por llave: ${r3} y la tabla == la completa`);
    ok(reescritas.length === 1 && reescritas[0].endsWith(idB), `E. sólo se reescribió la fila de B (${reescritas.length} fila(s))`);

    // F ─ producto borrado
    await c.query(`UPDATE catalog.products SET deleted_at = now() WHERE tenant_id = $1 AND sku = 'P621C'`, [M]);
    const r4 = await recalcula(['P621C']);
    ok(r4 === 'price_truth 0/0/2' && await igualALaCompleta(), `F. producto borrado: ${r4}`);

    // G ─ cambio de clave: H pasa a P621I (que tiene kdii en Z1 y Z2); sólo se recalcula la clave nueva
    await c.query(`UPDATE catalog.products SET sku = 'P621I' WHERE tenant_id = $1 AND btrim(sku) = 'P621H'`, [M]);
    const r5 = await recalcula(['P621I']);
    ok(r5 === 'price_truth 1/1/0' && await igualALaCompleta(), `G. cambio de clave, sólo la nueva: ${r5} y la tabla == la completa`);
    const r6 = await recalcula(['P621H']);
    ok(r6 === 'price_truth 0/0/0', `G. la clave vieja ya no tiene nada (${r6})`);

    // H ─ el umbral: un cambio en D que NO viene en la lista
    await c.query(`UPDATE kepler_ods.kdii SET c90 = 7 WHERE sucursal = 'Z1' AND c1 = 'P621D'`);
    const N = migracion.MAX_POR_LLAVE;
    const ajenos = (n) => Array.from({ length: n }, (_, i) => `X621-${i}`);
    const r7 = await recalcula(ajenos(N));
    ok(r7 === 'price_truth 0/0/0' && !(await igualALaCompleta()), `H. con ${N} SKUs ajenos sigue por llave: ${r7}, no ve el cambio de D`);
    const r8 = await recalcula(ajenos(N + 1));
    ok(r8 === 'price_truth 0/1/0' && await igualALaCompleta(), `H. con ${N + 1} pasa a completo: ${r8}, recoge el cambio de D`);

    // I ─ listas vacías y claves con espacios
    ok(await recalcula([]) === 'price_truth 0/0/0' && await recalcula(['  ', null]) === 'price_truth 0/0/0', 'I. lista vacía o de blancos: 0/0/0');
    await venta('Z1', 'P621A', cinco(10));
    const r9 = await recalcula([' P621A ']);
    ok(r9 === 'price_truth 0/1/0' && await igualALaCompleta(), `I. la clave con espacios (sola) se normaliza: ${r9}`);

    // J ─ permisos y jit
    const p = (await q(`SELECT has_table_privilege('app_runtime', 'analytics.price_truth', 'SELECT') AS lee,
        has_table_privilege('app_runtime', 'analytics.price_truth', 'INSERT') AS escribe,
        has_function_privilege('app_runtime', 'analytics.recalcular_existencia(text[])', 'EXECUTE') AS recalcula,
        has_function_privilege('app_runtime', 'analytics.price_truth_de(text[])', 'EXECUTE') AS regla`))[0];
    ok(p.lee && !p.escribe && p.recalcula && !p.regla, `J. app_runtime: lee ${p.lee} · escribe ${p.escribe} · recalcula ${p.recalcula} · regla ${p.regla}`);
    await c.query('SAVEPOINT rol');
    await c.query('SET LOCAL ROLE app_runtime');
    let comoApp = null;
    try { comoApp = await recalcula(['P621A']); } catch (e) { comoApp = `ERROR ${e.message}`; }
    let directo = 'sin error';
    try { await c.query('SAVEPOINT directo'); await c.query(`INSERT INTO analytics.price_truth (tenant_id, warehouse_id, product_id) VALUES ($1, $1, $1)`, [M]); }
    catch (e) { directo = e.code; await c.query('ROLLBACK TO SAVEPOINT directo'); }
    await c.query('ROLLBACK TO SAVEPOINT rol');
    await c.query('RESET ROLE');
    ok(comoApp === 'price_truth 0/0/0' && directo === '42501', `J. como app_runtime: recalcular_existencia corre (${comoApp}); escribir la tabla directo → ${directo}`);
    const cfg = Object.fromEntries((await q(`SELECT proname, proconfig::text AS cfg FROM pg_proc
        WHERE pronamespace = 'analytics'::regnamespace AND proname IN ('price_truth_de', 'recalcular_existencia')`)).map((r) => [r.proname, r.cfg || '']));
    ok(/jit=off/.test(cfg.price_truth_de) && /jit=off/.test(cfg.recalcular_existencia) && /plan_cache_mode=force_custom_plan/.test(cfg.price_truth_de),
      `J. jit=off en las dos y plan a la medida en la regla (${cfg.price_truth_de} · ${cfg.recalcular_existencia})`);

    // K ─ idempotencia y down()
    await migracion.up(knexLike);
    ok(await igualALaCompleta(), 'K. up() dos veces no rompe ni toca la tabla');
    await migracion.down(knexLike);
    const queda = (await q(`SELECT to_regclass('analytics.price_truth') IS NULL AS t,
        to_regprocedure('analytics.price_truth_de(text[])') IS NULL AS f1, to_regprocedure('analytics.recalcular_existencia(text[])') IS NULL AS f2`))[0];
    ok(queda.t && queda.f1 && queda.f2, 'K. down() quita la tabla y las dos funciones');
  } catch (e) {
    fail++; console.log('  ✗ la prueba se cortó:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  salir();
})();
