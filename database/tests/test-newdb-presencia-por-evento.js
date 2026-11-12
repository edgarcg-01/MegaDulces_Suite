#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.16]` Presencia del catálogo por evento, sin el nocturno `repoint-catalog-presence`: al llegar el cambio de
 * `kdii` el hop-2 REACTIVA el SKU que sólo tenía filas borradas y Kepler trae vivo (`normalizeProductsFromOds`, paso 0)
 * y LLENA el factor de caja vacío desde el árbitro (`normalizeFactorSale`), antes de calcular el costo. Contra una base
 * real, en una transacción que se revierte, por el camino real (`applyRawUpsert`):
 *
 *   A. Borrado en la Suite, vivo en Kepler: se reactiva y toma el nombre de hoy. NEGATIVA: normalize=false, no.
 *   B. Vivo sólo como «* DESCONTINUADO» o con precio de promo ($0.01): NO se reactiva.
 *   C. Dos filas borradas del mismo SKU: se reactiva UNA (dos vivas con el mismo SKU no caben).
 *   D. Una fila viva y una borrada del mismo SKU: la borrada se queda.
 *   E. ⭐ Alta nueva con caja de 12 en Kepler: entra con factor 12 Y costo por caja (el factor se llena ANTES del costo).
 *   F. Factor ya escrito: no se pisa. G. Factor fraccionario (un peso): no se llena. H. Sin testigo: no se llena.
 *      NEGATIVA: con la normalización apagada, el factor no se llena.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-presencia-por-evento', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const { applyRawUpsert } = require('../../services/feeds-ingest/apply-handlers');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const TXT = ['sucursal', 'c1', 'c2', 'c3', 'c7', 'c11'];
const KDII = { table: 'kdii', pk: ['c1'], columns: TXT.map((name) => ({ name, type: 'text' })).concat(['c84', 'c90'].map((name) => ({ name, type: 'numeric' }))) };
const art = (sucursal, c1, c2, x = {}) => ({ sucursal, c1, c2, c3: 'L616', c7: null, c11: 'PZA', c84: x.c84 ?? null, c90: x.c90 ?? 10 });

(async () => {
  console.log('\n[CANON.6.16] presencia del catálogo por evento\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const db = dentroDeLaPrueba(c);
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const callado = async (fn) => { const l = console.log; const e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
  const vivas = async (sku) => q(`SELECT nombre, factor_sale, cost_per_case::text AS cpc FROM catalog.products WHERE tenant_id=$1 AND sku=$2 AND deleted_at IS NULL`, [M, sku]);

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['kepler_ods', 'catalog', 'analytics']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, c2 text, c3 text, c7 text, c11 text,
      c84 numeric, c90 numeric, PRIMARY KEY (sucursal, c1))`);
    for (const col of ['c11']) await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS ${col} text`);
    await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS c84 numeric`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdik (sucursal text NOT NULL, c1 text NOT NULL, c2 text, c16 numeric, PRIMARY KEY (sucursal, c1))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, barcode varchar, source varchar, markup_pct numeric(10,4),
      is_promo boolean NOT NULL DEFAULT false, cost_base numeric, cost_with_tax numeric, cost_per_case numeric, iva_rate numeric,
      ieps_rate numeric, factor_sale integer, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      deleted_at timestamptz, UNIQUE (tenant_id, brand_id, nombre))`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.product_box_factor (tenant_id uuid NOT NULL, product_id uuid NOT NULL,
      box_factor numeric NOT NULL, source text NOT NULL DEFAULT 'kepler_c84', updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, product_id))`);
    // En una base migrada el árbitro es la vista real; en una base pelada, un sustituto con la misma forma (testigo =
    // el factor de Kepler; sin él, 'default'). Lo que se prueba aquí son las reglas del relleno, no el árbitro.
    if (!(await q(`SELECT to_regclass('analytics.v_product_box_factor') r`))[0].r) {
      await c.query(`CREATE VIEW analytics.v_product_box_factor AS
        SELECT p.tenant_id, p.id AS product_id, coalesce(b.box_factor, 1) AS box_factor,
               CASE WHEN b.box_factor IS NULL THEN 'default' ELSE b.source END AS source
          FROM catalog.products p LEFT JOIN analytics.product_box_factor b ON b.tenant_id = p.tenant_id AND b.product_id = p.id`);
    }
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    await c.query(`INSERT INTO catalog.brands (tenant_id, nombre, code) SELECT $1, 'SIN LÍNEA', 'SIN-LINEA'
                    WHERE NOT EXISTS (SELECT 1 FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA')`, [M]);
    const [{ id: B }] = await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, 'Marca CANON.6.16', 'L616') RETURNING id`, [M]);
    const prod = (sku, nombre, x = {}) => c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, factor_sale, deleted_at)
      VALUES ($1,$2,$3,$4,$5,$6)`, [M, B, sku, nombre, x.factor ?? null, x.borrado ? new Date(Date.now() - (x.hace || 0)) : null]);
    await prod('T616-R', 'R VIEJO T616', { borrado: true });
    await prod('T616-D', 'D T616', { borrado: true });
    await prod('T616-P', 'P T616', { borrado: true });
    await prod('T616-2', 'DOS A T616', { borrado: true, hace: 86400000 });
    await prod('T616-2', 'DOS B T616', { borrado: true });
    await prod('T616-T', 'T VIVO T616');
    await prod('T616-T', 'T BORRADO T616', { borrado: true });
    await prod('T616-F', 'F T616', { factor: 6 });
    await prod('T616-G', 'G T616');
    await prod('T616-H', 'H T616');
    await prod('T616-X', 'X T616');

    // ── A. Reactivar ──────────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [art('01', 'T616-R', 'R NUEVO T616')], { ...KDII, normalize: false }));
    ok(!(await vivas('T616-R')).length, 'NEGATIVA: con la normalización apagada el borrado se queda borrado');
    await callado(() => applyRawUpsert(db, M, [art('02', 'T616-R', 'R NUEVO T616')], KDII));
    const r = await vivas('T616-R');
    ok(r.length === 1 && r[0].nombre === 'R NUEVO T616', 'borrado en la Suite y vivo en Kepler: se reactiva y toma el nombre de hoy', JSON.stringify(r));

    // ── B. No se reactiva lo que Kepler no trae vivo ──────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [art('01', 'T616-D', '* DESCONTINUADO'), art('01', 'T616-P', 'P PROMO T616', { c90: 0.01 })], KDII));
    ok(!(await vivas('T616-D')).length && !(await vivas('T616-P')).length, 'vivo sólo como «* DESCONTINUADO» o con precio de promo: NO se reactiva');

    // ── C y D ─────────────────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [art('01', 'T616-2', 'DOS HOY T616'), art('01', 'T616-T', 'T VIVO T616')], KDII));
    const dos = await vivas('T616-2');
    ok(dos.length === 1, 'dos filas borradas del mismo SKU: se reactiva UNA', `vivas=${dos.length}`);
    const t = await q(`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int vivas, count(*)::int todas FROM catalog.products WHERE tenant_id=$1 AND sku='T616-T'`, [M]);
    ok(t[0].vivas === 1 && t[0].todas === 2, 'una viva y una borrada del mismo SKU: la borrada se queda', JSON.stringify(t[0]));

    // ── E. Alta nueva con caja: factor ANTES del costo ────────────────────────────────────────
    await c.query(`INSERT INTO kepler_ods.kdik (sucursal, c1, c2, c16) VALUES ('01','K616N','T616-N',10), ('02','K616N2','T616-N',10)`);
    await callado(() => applyRawUpsert(db, M, [art('01', 'T616-N', 'N ALTA T616', { c84: 12, c90: 24 }), art('02', 'T616-N', 'N ALTA T616', { c84: 12, c90: 24 })], KDII));
    const n = await vivas('T616-N');
    ok(n.length === 1 && n[0].factor_sale === 12, 'alta nueva con caja de 12 en Kepler: entra con factor 12', JSON.stringify(n));
    ok(n.length === 1 && Number(n[0].cpc) === 120, '⭐ y con costo por caja (10 × 12): el factor se llena ANTES del costo', JSON.stringify(n));

    // ── F, G, H y la negativa ─────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [art('01', 'T616-X', 'X T616', { c84: 8 })], { ...KDII, normalize: false }));
    ok((await vivas('T616-X'))[0].factor_sale === null, 'NEGATIVA: con la normalización apagada el factor no se llena');
    await callado(() => applyRawUpsert(db, M, [art('01', 'T616-F', 'F T616', { c84: 12 }), art('01', 'T616-G', 'G T616', { c84: 22.7 }),
      art('01', 'T616-H', 'H T616')], KDII));
    ok((await vivas('T616-F'))[0].factor_sale === 6, 'factor ya escrito: no se pisa');
    ok((await vivas('T616-G'))[0].factor_sale === null, 'factor fraccionario (un peso, 22.7): no se llena');
    ok((await vivas('T616-H'))[0].factor_sale === null, 'sin testigo (sin caja en Kepler): no se llena');
    await callado(() => applyRawUpsert(db, M, [art('02', 'T616-X', 'X T616', { c84: 8 })], KDII));
    ok((await vivas('T616-X'))[0].factor_sale === 8, 'y el que sí tiene testigo entero se llena al llegar su kdii');
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
