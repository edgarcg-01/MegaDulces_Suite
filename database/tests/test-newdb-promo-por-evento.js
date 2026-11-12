#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.9]` `catalog.products.is_promo` se mantiene AL LLEGAR el cambio de `kdii`/`kdik` (hop-2,
 * `normalizePromo`), no con `repoint-catalog-prices --solo-promo` cada 30 min. Contra una base real, dentro
 * de una transacción que se revierte:
 *
 *   A. ⭐ PARIDAD con el algoritmo viejo: los tres pases de `repoint-catalog-prices` (copiados aquí tal
 *      cual, como oráculo) y la regla única dejan EXACTAMENTE la misma marca en un escenario con cada
 *      clase: precio de promo, precio real que apaga, sólo CEDIS, fuera de kdii (conserva), costo de
 *      regalo que gana al precio, costo 0, «= GRATIS» con y sin costo real, filas borradas.
 *   B. Acotado: con un SKU no toca otro desfasado.  C. Sin churn: 0 filas y mismo xmin.
 *   D. El camino real: un `raw-upsert` de `kdii` enciende y apaga la marca; uno de `kdik` la recalcula
 *      después del costo. PRUEBAS NEGATIVAS: el mismo upsert con `meta.normalize=false` no la mueve.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-promo-por-evento', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const { normalizePromo, promoSql } = require('../../services/feeds-ingest/ods-derived');
const { applyRawUpsert } = require('../../services/feeds-ingest/apply-handlers');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

/** Los tres pases de `repoint-catalog-prices` (hasta 2026-11-11), tal cual. Sólo para comparar. */
async function pasesViejos(c) {
  await c.query(`UPDATE catalog.products p SET is_promo = (s.maxp <= 0.05), updated_at = now()
    FROM (SELECT btrim(c1) AS sku, max(c90::numeric) AS maxp FROM kepler_ods.kdii
           WHERE btrim(coalesce(c1,'')) <> '' AND btrim(sucursal) <> '00' GROUP BY btrim(c1)) s
    WHERE p.tenant_id=$1 AND p.sku = s.sku AND p.is_promo IS DISTINCT FROM (s.maxp <= 0.05)`, [M]);
  await c.query(`UPDATE catalog.products SET is_promo = true, updated_at = now()
    WHERE tenant_id=$1 AND deleted_at IS NULL AND is_promo = false
      AND cost_base IS NOT NULL AND cost_base > 0 AND cost_base <= 0.05`, [M]);
  await c.query(`UPDATE catalog.products SET is_promo = true, updated_at = now()
    WHERE tenant_id=$1 AND deleted_at IS NULL AND is_promo = false
      AND upper(nombre) LIKE '%= GRATIS%' AND (cost_base IS NULL OR cost_base <= 0.05)`, [M]);
}

const KDII = { table: 'kdii', pk: ['c1'], columns: [{ name: 'sucursal', type: 'text' }, { name: 'c1', type: 'text' }, { name: 'c90', type: 'numeric' }] };
const KDIK = { table: 'kdik', pk: ['c1', 'c2'], columns: [{ name: 'sucursal', type: 'text' }, { name: 'c1', type: 'text' }, { name: 'c2', type: 'text' }, { name: 'c16', type: 'numeric' }] };

(async () => {
  console.log('\n[CANON.6.9] is_promo por evento (hop-2 de kdii/kdik)\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const db = dentroDeLaPrueba(c);
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const marcas = async () => new Map((await q(`SELECT sku || CASE WHEN deleted_at IS NULL THEN '' ELSE '·borrado' END AS k, is_promo, xmin::text AS x
      FROM catalog.products WHERE tenant_id=$1 AND sku LIKE 'T69-%'`, [M])).map((r) => [r.k, r]));
  const promo = async (sku) => (await marcas()).get(sku)?.is_promo;
  const callado = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['kepler_ods', 'catalog']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, c90 numeric, PRIMARY KEY (sucursal, c1))`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdik (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL, c16 numeric, PRIMARY KEY (sucursal, c1, c2))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, is_promo boolean NOT NULL DEFAULT false,
      cost_base numeric, cost_with_tax numeric, cost_per_case numeric, iva_rate numeric, ieps_rate numeric, factor_sale numeric,
      updated_at timestamptz DEFAULT now(), deleted_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    const [{ id: marca }] = await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, 'Marca CANON.6.9', 'T69') RETURNING id`, [M]);
    // sku, nombre, costo, marca inicial, borrado
    const PRODUCTOS = [
      ['T69-P1', 'Clave regalo 6.9', 5, false, false],             // precio máx $0.01 → promo
      ['T69-P2', 'Clave reusada 6.9', 5, true, false],             // un precio real apaga la marca
      ['T69-CED', 'Sólo CEDIS 6.9', 5, false, false],              // precio sólo en '00' → conserva
      ['T69-CED2', 'Sólo CEDIS 6.9 b', 5, true, false],
      ['T69-NK', 'Fuera de kdii 6.9', null, true, false],          // fuera de kdii → conserva
      ['T69-COST', 'Costo de regalo 6.9', 0.001, false, false],    // precio real, costo ≤ $0.05 → promo (el costo gana)
      ['T69-C0', 'Costo faltante 6.9', 0, false, false],           // costo 0 = faltante, no promo
      ['T69-GR', '2 CJS PRUEBA = GRATIS 1 EXH', null, false, false],
      ['T69-GR5', '2 CJS PRUEBA = GRATIS 1 EXH B', 5, false, false], // con costo real no es promo
      ['T69-DEL', 'Borrado 6.9', 0.01, true, true],               // borrado: sólo cuenta el precio
      ['T69-DEL2', 'Borrado 6.9 b', 5, false, true],
      ['T69-EV', 'Evento kdii 6.9', 5, false, false],
      ['T69-KK', 'Evento kdik 6.9', 5, false, false],
    ];
    for (const [sku, nombre, costo, p, borrado] of PRODUCTOS) {
      await c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, cost_base, is_promo, deleted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [M, marca, sku, nombre, costo, p, borrado ? new Date() : null]);
    }
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c90) VALUES
      ('01','T69-P1',0.01), ('02','T69-P1',0.01),
      ('01','T69-P2',0.01), ('02','T69-P2',15),
      ('00','T69-CED',0.01), ('00','T69-CED2',20),
      ('01','T69-COST',35.63), ('01','T69-DEL',10), ('01','T69-DEL2',0.01),
      ('01','T69-EV',20), ('01','T69-KK',10)`);

    // ── B. Acotado (antes que nada, con todo desfasado) ───────────────────────────────────────
    const nB = await normalizePromo(db, M, ['T69-P1']);
    ok(nB === 1 && (await promo('T69-P1')) === true, 'acotado: sólo P1 (precio máx $0.01) se enciende', `n=${nB}`);
    ok((await promo('T69-P2')) === true, 'acotado: P2, desfasado, no se tocó');
    await c.query(`UPDATE catalog.products SET is_promo = false WHERE tenant_id=$1 AND sku='T69-P1'`, [M]);

    // ── A. Paridad con los tres pases ─────────────────────────────────────────────────────────
    await c.query('SAVEPOINT viejo');
    await pasesViejos(c);
    const esperado = await marcas();
    await c.query('ROLLBACK TO SAVEPOINT viejo');
    await normalizePromo(db, M, PRODUCTOS.map((r) => r[0]));
    const nuevo = await marcas();
    const distintos = [...esperado.keys()].filter((k) => esperado.get(k).is_promo !== nuevo.get(k)?.is_promo);
    ok(esperado.size === PRODUCTOS.length && distintos.length === 0,
      `paridad: la regla única deja la misma marca que los tres pases en los ${PRODUCTOS.length} casos`, distintos.join(', '));
    const ver = (k, v, m) => ok(nuevo.get(k)?.is_promo === v, m, `${k}=${nuevo.get(k)?.is_promo}`);
    ver('T69-P1', true, 'precio máximo ≤ $0.05 → promo');
    ver('T69-P2', false, 'un precio real ($15) apaga la marca');
    ver('T69-CED', false, 'precio sólo en CEDIS → conserva (apagada)');
    ver('T69-CED2', true, 'precio sólo en CEDIS → conserva (encendida)');
    ver('T69-NK', true, 'fuera de kdii → conserva');
    ver('T69-COST', true, 'costo ≤ $0.05 gana al precio real (lo que hacían los pases; hoy 4 productos)');
    ver('T69-C0', false, 'costo 0 es costo faltante, no promo');
    ver('T69-GR', true, '«= GRATIS» sin costo → promo');
    ver('T69-GR5', false, '«= GRATIS» con costo real → no promo');
    ver('T69-DEL·borrado', false, 'borrado con precio real: el costo de regalo no cuenta');
    ver('T69-DEL2·borrado', true, 'borrado con precio $0.01 → promo');

    // ── C. Sin churn ──────────────────────────────────────────────────────────────────────────
    const n0 = await normalizePromo(db, M, PRODUCTOS.map((r) => r[0]));
    const despues = await marcas();
    ok(n0 === 0 && [...nuevo.keys()].every((k) => nuevo.get(k).x === despues.get(k).x), 'sin cambios: 0 filas y ninguna tupla reescrita', `n=${n0}`);

    // ── D. El camino real ─────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [{ sucursal: '01', c1: 'T69-EV', c90: 0.01 }], { ...KDII, normalize: false }));
    const [r] = await q(`SELECT promo FROM (${promoSql(true)}) f JOIN catalog.products p ON p.id = f.id WHERE p.sku = 'T69-EV'`, [M, ['T69-EV']]);
    ok(r && r.promo === true, 'el ODS ya dice promo para EV (el upsert crudo sí entró)');
    ok((await promo('T69-EV')) === false, 'NEGATIVA kdii: con la normalización apagada la marca NO se mueve');
    await callado(() => applyRawUpsert(db, M, [{ sucursal: '02', c1: 'T69-EV', c90: 0.01 }], KDII));
    ok((await promo('T69-EV')) === true, 'un raw-upsert de kdii (lo que manda el CDC) enciende la marca');
    await callado(() => applyRawUpsert(db, M, [{ sucursal: '01', c1: 'T69-EV', c90: 12 }], KDII));
    ok((await promo('T69-EV')) === false, 'y otro con precio real la apaga (en los dos sentidos)');

    await c.query(`UPDATE catalog.products SET cost_base = 0.01 WHERE tenant_id=$1 AND sku='T69-KK'`, [M]);
    await callado(() => applyRawUpsert(db, M, [{ sucursal: '01', c1: 'X1', c2: 'T69-KK', c16: 0.01 }], { ...KDIK, normalize: false }));
    ok((await promo('T69-KK')) === false, 'NEGATIVA kdik: con la normalización apagada la marca NO se mueve');
    await callado(() => applyRawUpsert(db, M, [{ sucursal: '01', c1: 'X1', c2: 'T69-KK', c16: 0.012 }], KDIK));
    const [kk] = await q(`SELECT is_promo, cost_base::text AS costo FROM catalog.products WHERE tenant_id=$1 AND sku='T69-KK'`, [M]);
    ok(kk.is_promo === true, 'un raw-upsert de kdik recalcula la marca después del costo (costo $0.01 → promo)', `costo=${kk.costo}`);
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
