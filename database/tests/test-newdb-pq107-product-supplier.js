#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[PQ.107]` — `analytics.v_product_supplier`: el proveedor de cada producto, leído de Kepler.
 *
 * Todo DENTRO de una transacción con ROLLBACK al final. Ejerce el `up()` REAL de la migración (no
 * su SQL retipeado) sobre un escenario sintético en sucursales de prueba `Z0`/`Z1`/`Z2`; lo que
 * falte en una base vacía se crea mínimo.
 *
 * Qué prueba:
 *   · gana la liga de la sucursal MÁS BAJA (la regla del importer que reemplaza);
 *   · ⛔ el EMPATE (dos proveedores en la misma sucursal más baja) lo gana el que Kepler tiene en más
 *     sucursales, no el primer código: el 94288 de prod se quedaba con «00001 SIN PROVEEDOR»;
 *   · el nombre sale de Kepler y «INHABILITADO» se declara;
 *   · los cuatro estados: kepler · dado_de_baja_en_suite (supplier_id NULL) · no_esta_en_suite ·
 *     sin_liga_en_kepler; un producto borrado no sale;
 *   · ⛔ NEGATIVA: la misma vista SIN el desempate por sucursales falla la prueba del empate;
 *   · permisos y comentario del `up()`; `up()` dos veces; `down()` la quita.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/pq107_prueba \
 *     node database/tests/test-newdb-pq107-product-supplier.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq107-product-supplier', { url: URL });
const { Client } = require('pg');
const migracion = require('../migrations-newdb/20261110141158_pq107_v_product_supplier.js');

const M = '00000000-0000-0000-0000-00000000d01c';
let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const q = async (sql, b) => (await c.query(sql, b)).rows;
  const knexLike = { raw: (sql) => c.query(sql) };

  console.log('\n=== [PQ.107] v_product_supplier: el proveedor de Kepler ===\n');
  await c.query('BEGIN');
  try {
    // ── Escenario mínimo (lo que ya exista se usa; lo que falte se crea) ─────────────────────────
    for (const s of ['kepler_ods', 'analytics']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    for (const r of ['app_runtime', 'dev_ro']) {
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
    }
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prov_prod (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL,
      PRIMARY KEY (sucursal, c1, c2))`);
    await c.query(`ALTER TABLE kepler_ods.kdpv_prov_prod ADD COLUMN IF NOT EXISTS c3 text`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdxd (sucursal text NOT NULL, c2 text NOT NULL, PRIMARY KEY (sucursal, c2))`);
    await c.query(`ALTER TABLE kepler_ods.kdxd ADD COLUMN IF NOT EXISTS c3 text`);

    let marca = (await q(`SELECT id FROM catalog.brands WHERE tenant_id = $1 AND deleted_at IS NULL LIMIT 1`, [M]))[0]?.id;
    if (!marca) marca = (await q(`INSERT INTO catalog.brands (tenant_id, nombre) VALUES ($1, 'PQ107 marca de prueba') RETURNING id`, [M]))[0].id;

    // Proveedores en la Suite: ZQ1/ZQ3/ZQ4/ZQ8 vivos; ZQ5 fusionado (dado de baja); ZQ6 no existe.
    const prov = {};
    for (const [code, name, baja] of [['ZQ1', 'Uno SA', false], ['ZQ2', 'Dos SA', false], ['ZQ3', 'Tres SA', false],
      ['ZQ4', 'Cuatro SA', false], ['ZQ5', 'Cinco SA', true], ['ZQ8', 'Ocho SA', false]]) {
      prov[code] = (await q(`INSERT INTO catalog.suppliers (tenant_id, code, name, deleted_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [M, code, name, baja ? new Date() : null]))[0].id;
    }
    const prod = {};
    for (const [sku, borrado] of [['ZZ107A', false], ['ZZ107B', false], ['ZZ107C', false], ['ZZ107D', false],
      ['ZZ107E', false], ['ZZ107F', false], ['ZZ107G', true]]) {
      prod[sku] = (await q(`INSERT INTO catalog.products (tenant_id, brand_id, nombre, sku, supplier_id, deleted_at)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [M, marca, 'PQ107 ' + sku, sku, prov.ZQ2, borrado ? new Date() : null]))[0].id;
    }
    // Ligas de Kepler (sucursal, proveedor, sku).
    for (const [suc, code, sku] of [
      ['Z0', 'ZQ1', 'ZZ107A'], ['Z1', 'ZQ2', 'ZZ107A'],                         // A: gana Z0 → ZQ1; 2 proveedores
      ['Z0', 'ZQ3', 'ZZ107B'], ['Z0', 'ZQ8', 'ZZ107B'], ['Z1', 'ZQ8', 'ZZ107B'], ['Z2', 'ZQ8', 'ZZ107B'], // B: empate en Z0 → ZQ8 (3 sucursales)
      ['Z0', 'ZQ4', 'ZZ107C'],                                                 // C: inhabilitado
      ['Z0', 'ZQ5', 'ZZ107D'],                                                 // D: fusionado en la Suite
      ['Z0', 'ZQ6', 'ZZ107E'],                                                 // E: código que la Suite no tiene
      ['Z0', 'ZQ1', 'ZZ107G'],                                                 // G: producto borrado
    ]) {
      await c.query(`INSERT INTO kepler_ods.kdpv_prov_prod (sucursal, c1, c2) VALUES ($1, $2, $3)`, [suc, code, sku]);
    }
    for (const [suc, code, name] of [['Z0', 'ZQ1', 'UNO DE KEPLER'], ['Z1', 'ZQ1', 'OTRO NOMBRE'], ['Z0', 'ZQ4', 'INHABILITADO'],
      ['Z0', 'ZQ8', 'OCHO DE KEPLER'], ['Z0', 'ZQ3', 'TRES DE KEPLER']]) {
      await c.query(`INSERT INTO kepler_ods.kdxd (sucursal, c2, c3) VALUES ($1, $2, $3)`, [suc, code, name]);
    }

    // ── La migración real ──────────────────────────────────────────────────────────────────────
    await migracion.up(knexLike);
    const leer = async (vista) => Object.fromEntries((await q(
      `SELECT * FROM ${vista} WHERE tenant_id = $1 AND sku LIKE 'ZZ107%'`, [M])).map((r) => [r.sku, r]));
    const v = await leer('analytics.v_product_supplier');

    t('A: gana la sucursal más baja', v.ZZ107A?.supplier_code === 'ZQ1' && v.ZZ107A?.supplier_id === prov.ZQ1, JSON.stringify(v.ZZ107A));
    t('A: el nombre es el de Kepler en esa sucursal', v.ZZ107A?.supplier_name === 'UNO DE KEPLER', v.ZZ107A?.supplier_name);
    t('A: declara que Kepler lo liga a 2 proveedores', v.ZZ107A?.proveedores_kepler === 2, String(v.ZZ107A?.proveedores_kepler));
    t('⛔ B: el empate lo gana el proveedor que Kepler tiene en más sucursales', v.ZZ107B?.supplier_code === 'ZQ8', v.ZZ107B?.supplier_code);
    t('C: «INHABILITADO» se declara', v.ZZ107C?.inhabilitado_en_kepler === true && v.ZZ107C?.supplier_name === 'INHABILITADO', JSON.stringify(v.ZZ107C));
    t('D: proveedor fusionado en la Suite → supplier_id NULL y estado declarado',
      v.ZZ107D?.estado === 'dado_de_baja_en_suite' && v.ZZ107D?.supplier_id === null && v.ZZ107D?.supplier_code === 'ZQ5', JSON.stringify(v.ZZ107D));
    t('E: código que la Suite no tiene', v.ZZ107E?.estado === 'no_esta_en_suite' && v.ZZ107E?.supplier_id === null, JSON.stringify(v.ZZ107E));
    t('F: sin liga en Kepler → no hereda la columna vieja', v.ZZ107F?.estado === 'sin_liga_en_kepler' && v.ZZ107F?.supplier_id === null, JSON.stringify(v.ZZ107F));
    t('G: un producto borrado no sale', !v.ZZ107G);
    t('una fila por producto', (await q(`SELECT count(*)::int n FROM analytics.v_product_supplier WHERE sku LIKE 'ZZ107%'`))[0].n === 6);

    // ── ⛔ Negativa: sin el desempate por sucursales, B tiene que fallar ────────────────────────
    const sinDesempate = migracion.VISTA.replace('en_sucursales DESC, ', '');
    t('el mutante de verdad cambia el SQL', sinDesempate !== migracion.VISTA);
    await c.query('SAVEPOINT mut');
    await c.query(`CREATE TEMP VIEW pq107_mutante AS ${sinDesempate}`);
    const m = await leer('pq107_mutante');
    t('⛔ NEGATIVA: sin el desempate, B cae en el primer código (la prueba de B vigila algo)', m.ZZ107B?.supplier_code === 'ZQ3', m.ZZ107B?.supplier_code);
    await c.query('ROLLBACK TO SAVEPOINT mut');

    // ── Permisos, comentario, idempotencia, down ─────────────────────────────────────────────
    const g = await q(`SELECT has_table_privilege('app_runtime', 'analytics.v_product_supplier', 'SELECT') a,
      has_table_privilege('dev_ro', 'analytics.v_product_supplier', 'SELECT') d,
      obj_description('analytics.v_product_supplier'::regclass) com`);
    t('app_runtime y dev_ro leen la vista', g[0].a && g[0].d);
    t('la vista lleva su comentario', /PQ\.107/.test(g[0].com || ''));
    await migracion.up(knexLike);
    t('up() dos veces no rompe', true);
    await migracion.down(knexLike);
    t('down() la quita', !(await q(`SELECT to_regclass('analytics.v_product_supplier') r`))[0].r);
  } catch (e) {
    bad++;
    console.error('  ✘ excepción:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  console.log(`\n${ok} ok · ${bad} fallas\n`);
  process.exit(bad ? 1 : 0);
})();
