#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.10]` El nombre (y la marca de una clave reusada) se mantiene AL LLEGAR el cambio de `kdii`
 * (hop-2, `normalizeProductsFromOds`), sin el barrido `repoint-catalog-names`; y un normalizador que falla
 * se reintenta partiendo el lote (`reintentarPorPartes`), en vez de esperar a un barrido que ya no existe.
 * Contra una base real, dentro de una transacción que se revierte:
 *
 *   A. Clave reusada: Kepler le cambia nombre y línea a un SKU → nombre nuevo Y marca de su línea nueva.
 *   B. Sólo mayúsculas: el nombre se corrige, la marca NO se mueve (CANON.1.3b).
 *   C. ⭐ Dos SKUs del mismo lote que irían al mismo (marca, nombre): pasa el de clave menor, el otro queda,
 *      y el resto del lote SÍ se escribe. PRUEBA NEGATIVA: el UPDATE anterior, con el mismo lote, revienta
 *      con 23505 (y por eso revertía todo el lote).
 *   D. Colisión con un producto que ya tiene ese nombre en esa marca: se queda como está.
 *   E. El camino real: un `raw-upsert` de `kdii` renombra; con `normalize=false`, no (NEGATIVA).
 *   F. Sin churn: la segunda pasada escribe 0.
 *   G. ⭐ Llave envenenada: un markup que desborda la columna tumba el lote completo (NEGATIVA, la función
 *      sola lanza); `reintentarPorPartes` aísla esa llave y escribe las demás; y el `raw-upsert` de
 *      `kdpv_prod_util` hace lo mismo solo.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-nombres-por-evento', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const { normalizeMarkup } = require('../../services/feeds-ingest/ods-derived');
const { identitySnapshotSql } = require('../../services/feeds-ingest/product-identity');
const { applyRawUpsert, normalizeProductsFromOds, reintentarPorPartes } = require('../../services/feeds-ingest/apply-handlers');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const KDII = { table: 'kdii', pk: ['c1'], columns: ['sucursal', 'c1', 'c2', 'c3', 'c7'].map((name) => ({ name, type: 'text' })).concat([{ name: 'c90', type: 'numeric' }]) };
const KDPV = { table: 'kdpv_prod_util', pk: ['c1', 'c2', 'c3'], columns: [['sucursal', 'text'], ['c1', 'text'], ['c2', 'text'], ['c3', 'numeric'], ['c4', 'numeric'], ['c5', 'numeric'], ['c6', 'numeric'], ['c7', 'numeric']].map(([name, type]) => ({ name, type })) };

(async () => {
  console.log('\n[CANON.6.10] nombres por evento + reintento por partes\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const db = dentroDeLaPrueba(c);
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const fila = async (sku) => (await q(`SELECT p.nombre, b.code AS marca, p.markup_pct::text AS markup FROM catalog.products p
      JOIN catalog.brands b ON b.id = p.brand_id WHERE p.tenant_id=$1 AND p.sku=$2 AND p.deleted_at IS NULL`, [M, sku]))[0] || {};
  const callado = async (fn) => { const l = console.log; const e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['kepler_ods', 'catalog']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, c2 text, c3 text, c7 text,
      c90 numeric, PRIMARY KEY (sucursal, c1))`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prod_util (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL,
      c3 numeric NOT NULL, c4 numeric, c5 numeric, c6 numeric, c7 numeric, PRIMARY KEY (sucursal, c1, c2, c3))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, barcode varchar, source varchar, markup_pct numeric(10,4),
      is_promo boolean NOT NULL DEFAULT false, cost_base numeric, cost_with_tax numeric, cost_per_case numeric, iva_rate numeric,
      ieps_rate numeric, factor_sale numeric, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      deleted_at timestamptz, UNIQUE (tenant_id, brand_id, nombre))`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    const marca = async (code) => (await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, $2, $3) RETURNING id`, [M, `Marca ${code}`, code]))[0].id;
    const B1 = await marca('T70A'); await marca('T70B');
    const prod = (sku, nombre, b = B1) => c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre) VALUES ($1,$2,$3,$4)`, [M, b, sku, nombre]);
    await prod('T70-R', 'VIEJO REUSADO T70');
    await prod('T70-C', 'Caso Mayusculas T70');
    await prod('T70-X1', 'X1 T70');
    await prod('T70-X2', 'X2 T70');
    await prod('T70-E', 'E T70');
    await prod('T70-OTRO', 'YA EXISTE T70');
    await prod('T70-EV', 'EV VIEJO T70');
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c90) VALUES
      ('01','T70-R','NUEVO TOP T70','T70B',10), ('02','T70-R','NUEVO TOP T70','T70B',10),
      ('01','T70-C','CASO MAYUSCULAS T70','T70B',10),
      ('01','T70-X1','INHABILITADO T70','T70A',10), ('01','T70-X2','INHABILITADO T70','T70A',10),
      ('01','T70-E','YA EXISTE T70','T70A',10),
      ('01','T70-EV','EV VIEJO T70','T70A',10)`);
    const LOTE = ['T70-R', 'T70-C', 'T70-X1', 'T70-X2', 'T70-E'];

    // ── C (negativa). El UPDATE anterior, con el mismo lote, revienta ─────────────────────────
    await c.query('SAVEPOINT viejo');
    let codigo = null;
    try {
      await c.query(`CREATE TEMP TABLE snap_p AS SELECT i.sku, i.nombre, i.barcode, i.linea, NULL::uuid AS brand_id
        FROM (${identitySnapshotSql({ skuParam: '$1' })}) i`, [LOTE]);
      await c.query(`UPDATE catalog.products p SET nombre=s.nombre, updated_at=now() FROM snap_p s
        WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=s.sku AND p.nombre IS DISTINCT FROM s.nombre
          AND NOT EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id=$1 AND p2.id<>p.id
                            AND p2.brand_id=p.brand_id AND p2.nombre=s.nombre)`, [M]);
    } catch (e) { codigo = e.code; }
    await c.query('ROLLBACK TO SAVEPOINT viejo');
    ok(codigo === '23505', 'NEGATIVA: el UPDATE anterior con dos SKUs al mismo nombre revienta con 23505 (y revertía todo el lote)', `código=${codigo}`);

    // ── A–D. El normalizador con el mismo lote ────────────────────────────────────────────────
    const n = await normalizeProductsFromOds(db, M, LOTE);
    const R = await fila('T70-R'); const C = await fila('T70-C'); const X1 = await fila('T70-X1'); const X2 = await fila('T70-X2'); const E = await fila('T70-E');
    ok(R.nombre === 'NUEVO TOP T70' && R.marca === 'T70B', 'clave reusada: toma el nombre nuevo Y la marca de su línea nueva', `${R.nombre} / ${R.marca}`);
    ok(C.nombre === 'CASO MAYUSCULAS T70' && C.marca === 'T70A', 'sólo mayúsculas: corrige el nombre y NO mueve la marca', `${C.nombre} / ${C.marca}`);
    ok(X1.nombre === 'INHABILITADO T70' && X2.nombre === 'X2 T70', 'dos al mismo nombre en el lote: pasa el de clave menor, el otro queda', `${X1.nombre} | ${X2.nombre}`);
    ok(E.nombre === 'E T70', 'colisión con un producto existente: se queda como está', E.nombre);
    ok(n === 3, 'el lote se escribió (R, C, X1) en vez de revertirse entero', `n=${n}`);

    // ── F. Sin churn ──────────────────────────────────────────────────────────────────────────
    const n0 = await normalizeProductsFromOds(db, M, LOTE);
    ok(n0 === 0, 'segunda pasada sin cambios en Kepler: 0 filas', `n=${n0}`);

    // ── E. El camino real ─────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [{ sucursal: '01', c1: 'T70-EV', c2: 'EV NUEVO T70', c3: 'T70B', c90: 10 }], { ...KDII, normalize: false }));
    ok((await fila('T70-EV')).nombre === 'EV VIEJO T70', 'NEGATIVA: con la normalización apagada el nombre NO se mueve');
    await callado(() => applyRawUpsert(db, M, [{ sucursal: '02', c1: 'T70-EV', c2: 'EV NUEVO T70', c3: 'T70B', c90: 10 }], KDII));
    const EV = await fila('T70-EV');
    ok(EV.nombre === 'EV NUEVO T70' && EV.marca === 'T70B', 'un raw-upsert de kdii renombra la clave y le mueve la marca', `${EV.nombre} / ${EV.marca}`);

    // ── G. Llave envenenada ───────────────────────────────────────────────────────────────────
    await prod('T70-MA', 'MA T70'); await prod('T70-MP', 'MP T70'); await prod('T70-MB', 'MB T70');
    await c.query(`INSERT INTO kepler_ods.kdpv_prod_util (sucursal, c1, c2, c3, c4, c5, c6, c7) VALUES
      ('03','T70-MA','PZA',1,1,0,10,10), ('03','T70-MP','PZA',1,1,0,10000000,10), ('03','T70-MB','PZA',1,1,0,20,10)`);
    const MK = ['T70-MA', 'T70-MP', 'T70-MB'];
    let tiro = null;
    try { await normalizeMarkup(db, M, MK); } catch (e) { tiro = e.message; }
    ok(!!tiro && (await fila('T70-MA')).markup == null, 'NEGATIVA: la llave envenenada tumba el lote completo (la función sola lanza)', tiro);
    const r = await reintentarPorPartes(db, M, normalizeMarkup, MK);
    ok(r.fallidas.length === 1 && r.fallidas[0] === 'T70-MP', 'reintentarPorPartes aísla la llave envenenada', JSON.stringify(r.fallidas));
    ok((await fila('T70-MA')).markup === '10.0000' && (await fila('T70-MB')).markup === '20.0000' && r.filas === 2,
      'y escribe las demás llaves del lote', `filas=${r.filas}`);
    await c.query(`UPDATE kepler_ods.kdpv_prod_util SET c6 = c6 + 1 WHERE sucursal='03' AND c1 IN ('T70-MA','T70-MB')`);
    await callado(() => applyRawUpsert(db, M, [
      { sucursal: '05', c1: 'T70-MA', c2: 'PZA', c3: 1, c4: 1, c5: 0, c6: 1, c7: 10 },
      { sucursal: '05', c1: 'T70-MP', c2: 'PZA', c3: 1, c4: 1, c5: 0, c6: 1, c7: 10 },
      { sucursal: '05', c1: 'T70-MB', c2: 'PZA', c3: 1, c4: 1, c5: 0, c6: 1, c7: 10 }], KDPV));
    ok((await fila('T70-MA')).markup === '11.0000' && (await fila('T70-MB')).markup === '21.0000',
      'el raw-upsert de kdpv_prod_util reintenta solo: escribe las sanas aunque una esté envenenada');
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
