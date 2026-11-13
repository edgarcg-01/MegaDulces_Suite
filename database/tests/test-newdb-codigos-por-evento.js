#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.14]` Códigos de barras por evento, sin el reconciliador `import-product-barcodes` (cada 30 min): lo que
 * Kepler QUITA de `kdii` también se normaliza (`raw-delete` corre los normalizadores de la tabla, como `raw-upsert`).
 * Contra una base real, en una transacción que se revierte, por el camino real (`applyRawUpsert` / `applyRawDelete`):
 *
 *   A. Llega un producto con su EAN: nace su código (lo de siempre, de control).
 *   B. ⭐ Kepler BORRA el SKU de `kdii` (todas las plazas): su código Kepler se da de baja AL MOMENTO.
 *      PRUEBA NEGATIVA: con la normalización apagada (lo que pasaba antes), el código sigue vivo.
 *   C. Kepler borra UNA plaza donde vivía un código que las otras no traen: ese código se baja; el de las demás queda.
 *   D. Kepler borra una plaza pero el código vive en otras: se queda.
 *   E. Una fila `wincaja` del SKU borrado no se toca (el hop-2 sólo baja `kepler_*`).
 *   F. El árbitro (`ARBITRO_CODIGOS_SQL`, el MISMO .ts de db-health): un código que falta, uno que sobra y uno que
 *      sigue como Wincaja suman 3; un código Wincaja que Kepler NO trae no cuenta; corrido el normalizador, vuelve a
 *      la base.
 *
 * Sin base: NO MEDIDO, nunca ✔. Sin ts-node: F queda NO MEDIDO.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-codigos-por-evento', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const { applyRawUpsert, applyRawDelete, normalizeBarcodesFromOds } = require('../../services/feeds-ingest/apply-handlers');
const RAIZ = path.resolve(__dirname, '..', '..');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const COLS = ['sucursal', 'c1', 'c2', 'c3', 'c7', 'c11', 'c80', 'c82', 'c83', 'c85', 'c93', 'c95'];
const KDII = { table: 'kdii', pk: ['c1'], columns: COLS.map((name) => ({ name, type: 'text' })).concat([{ name: 'c90', type: 'numeric' }]) };
const art = (sucursal, c1, c7, extra = {}) => ({ sucursal, c1, c2: `ART ${c1}`, c3: 'L614', c7, c11: 'PZA', c80: null, c82: null, c83: null, c85: null, c93: null, c95: null, c90: 10, ...extra });
const borra = (sucursal, c1) => ({ sucursal, c1 });

(async () => {
  console.log('\n[CANON.6.14] códigos de barras por evento (también al borrar)\n');
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
  const callado = async (fn) => { const l = console.log; const e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
  const vivo = async (sku, bc) => (await q(`SELECT source FROM catalog.product_barcodes WHERE tenant_id=$1 AND sku=$2 AND barcode=$3 AND deleted_at IS NULL`, [M, sku, bc]))[0];
  const arbitro = async () => {
    const nota = String((await q(A.ARBITRO_CODIGOS_SQL))[0].note_extra || '');
    const m = /^(\d+) códigos sin tomar/.exec(nota);
    return { n: /^NO MEDIDO/.test(nota) ? null : /: 0 difieren de/.test(nota) || /^CUMPLIÓ/.test(nota) ? 0 : m ? Number(m[1]) : undefined, nota };
  };

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['kepler_ods', 'catalog', 'analytics']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, c2 text, c3 text, c7 text, c11 text,
      c80 text, c81 numeric, c82 text, c83 text, c84 numeric, c85 text, c90 numeric, c93 text, c95 text, PRIMARY KEY (sucursal, c1))`);
    for (const col of ['c11', 'c80', 'c82', 'c83', 'c85', 'c93', 'c95']) await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS ${col} text`);
    for (const col of ['c81', 'c84']) await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS ${col} numeric`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, barcode varchar, source varchar, markup_pct numeric(10,4),
      is_promo boolean NOT NULL DEFAULT false, cost_base numeric, cost_with_tax numeric, cost_per_case numeric, iva_rate numeric,
      ieps_rate numeric, factor_sale numeric, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      deleted_at timestamptz, UNIQUE (tenant_id, brand_id, nombre))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.product_barcodes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      product_id uuid, sku text NOT NULL, barcode text NOT NULL, unit text, factor numeric, source text, is_primary boolean DEFAULT false,
      synced_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz)`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS t614_pb_vivo ON catalog.product_barcodes (tenant_id, sku, barcode) WHERE deleted_at IS NULL`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.cron_run_log (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, job_key text NOT NULL,
      status text NOT NULL, finished_at timestamptz, logged_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.db_health_alerts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      source_key varchar NOT NULL, status varchar NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    const [{ id: B }] = await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, 'Marca CANON.6.14', 'L614') RETURNING id`, [M]);
    const prod = (sku) => c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre) VALUES ($1,$2,$3,$4)`, [M, B, sku, `ART ${sku}`]);
    for (const s of ['T614-B', 'T614-C', 'T614-D', 'T614-F1', 'T614-F2', 'T614-F3', 'T614-F4']) await prod(s);
    const base = A ? await arbitro() : null;

    // ── A. Llega (control) ────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [art('01', 'T614-B', '7500000614011'), art('02', 'T614-B', '7500000614011')], KDII));
    ok((await vivo('T614-B', '7500000614011') || {}).source === 'kepler_base', 'llega un producto con su EAN: nace su código (control)');
    await c.query(`INSERT INTO catalog.product_barcodes (tenant_id, sku, barcode, unit, source) VALUES ($1,'T614-B','7500000614999','CJA','wincaja')`, [M]);

    // ── B. Kepler borra el SKU de kdii ────────────────────────────────────────────────────────
    await callado(() => applyRawDelete(db, M, [borra('01', 'T614-B'), borra('02', 'T614-B')], { ...KDII, normalize: false }));
    ok(!!(await vivo('T614-B', '7500000614011')), 'NEGATIVA: con la normalización apagada (lo de antes) el código del SKU borrado sigue vivo');
    await callado(() => applyRawDelete(db, M, [borra('01', 'T614-B'), borra('02', 'T614-B')], KDII)); // ya no está en kdii: 0 filas
    ok(!!(await vivo('T614-B', '7500000614011')), 'un borrado que no quita nada (0 filas) no dispara nada');
    // De nuevo, ahora sí con filas que borrar y la normalización encendida.
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c7, c11, c90) VALUES ('01','T614-B','ART','L614','7500000614011','PZA',10)`);
    await callado(() => applyRawDelete(db, M, [borra('01', 'T614-B')], KDII));
    ok(!(await vivo('T614-B', '7500000614011')), '⭐ Kepler borra el SKU de kdii: su código Kepler se da de baja AL MOMENTO');
    ok((await vivo('T614-B', '7500000614999') || {}).source === 'wincaja', 'la fila wincaja del SKU no se toca');

    // ── C y D. Se borra una plaza ─────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [art('01', 'T614-C', '7500000614028'), art('02', 'T614-C', '7500000614035'),
      art('01', 'T614-D', '7500000614042'), art('02', 'T614-D', '7500000614042')], KDII));
    ok(!!(await vivo('T614-C', '7500000614028')) && !!(await vivo('T614-C', '7500000614035')), 'un SKU con un código distinto por plaza: los dos viven');
    await callado(() => applyRawDelete(db, M, [borra('01', 'T614-C'), borra('01', 'T614-D')], KDII));
    ok(!(await vivo('T614-C', '7500000614028')) && !!(await vivo('T614-C', '7500000614035')),
      'se borra la plaza que traía un código: ése se baja, el de la otra plaza queda');
    ok(!!(await vivo('T614-D', '7500000614042')), 'se borra una plaza pero el código vive en otra: se queda');

    // ── F. El árbitro ─────────────────────────────────────────────────────────────────────────
    if (!A) noMedido('árbitro: sin ts-node no se carga el .ts de db-health');
    else if (base.n == null) noMedido(`árbitro: la base no se pudo medir (${base.nota})`);
    else {
      const k0 = await arbitro();
      ok(k0.n === base.n, 'árbitro: con todo normalizado vuelve a la base (la fila wincaja de un código que Kepler no trae no cuenta)', `${base.n} → ${k0.nota}`);
      await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c7, c11, c90) VALUES
        ('01','T614-F1','A','L614','7500000614103','PZA',10), ('01','T614-F3','A','L614','7500000614127','PZA',10)`);
      await c.query(`INSERT INTO catalog.product_barcodes (tenant_id, sku, barcode, unit, source) VALUES
        ($1,'T614-F2','7500000614110','PZA','kepler_base'), ($1,'T614-F3','7500000614127','CJA','wincaja'),
        ($1,'T614-F4','7500000614134','CJA','wincaja')`, [M]);
      const k1 = await arbitro();
      ok(k1.n === base.n + 3, 'árbitro: uno que falta, uno que sobra y uno que sigue como Wincaja suman 3 (el wincaja que Kepler no trae, no)', k1.nota);
      await normalizeBarcodesFromOds(db, M, ['T614-F1', 'T614-F2', 'T614-F3']);
      const k2 = await arbitro();
      ok(k2.n === base.n && (await vivo('T614-F3', '7500000614127') || {}).source === 'kepler_base' && !(await vivo('T614-F2', '7500000614110')),
        'árbitro: corrido normalizeBarcodesFromOds, vuelve a la base (las dos reglas coinciden)', k2.nota);
    }

    // ── R. Revividos que Kepler ya reemplazó (decisión de Edgar, 2026-11-13) ──────────────────
    const { buscarRevividosReemplazados, retirarRevividos } = require('../importers/lib/codigos-revividos');
    for (const s of ['T614-R1', 'T614-R2', 'T614-R3', 'T614-R4', 'T614-R5']) await prod(s);
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c7, c11, c90) VALUES
      ('01','T614-R1','A','L614','7500000614301','PZA',10), ('01','T614-R2','A','L614','750000061431','PZA',10),
      ('01','T614-R3','A','L614','T614-R3','PZA',10), ('01','T614-R5','A','L614','7500000614356','PZA',10)`);
    await c.query(`INSERT INTO catalog.product_barcodes (tenant_id, sku, barcode, unit, source, deleted_at) VALUES
      ($1,'T614-R1','7500000614295','PZA','kepler_base', now()), ($1,'T614-R1','7500000614295','CJA','wincaja', NULL),
      ($1,'T614-R2','0750000061431','PZA','kepler_base', now()), ($1,'T614-R2','0750000061431','CJA','wincaja', NULL),
      ($1,'T614-R3','7500000614325','PZA','kepler_base', now()), ($1,'T614-R3','7500000614325','CJA','wincaja', NULL),
      ($1,'T614-R4','7500000614332','CJA','wincaja', NULL),
      ($1,'T614-R5','7500000614349','CJA','kepler_u2', now()), ($1,'T614-R5','7500000614349','CJA','wincaja', NULL)`, [M]);
    const rv = (await buscarRevividosReemplazados(db, M)).filter((r) => String(r.sku).startsWith('T614-R'));
    ok(rv.length === 1 && rv[0].sku === 'T614-R1' && rv[0].reemplazo === '7500000614301/PZA',
      'revivido que Kepler reemplazó por otro código real EN ESA UNIDAD: entra; mismo código sin el cero, Kepler sin código, otra unidad y Wincaja de siempre: no', JSON.stringify(rv));
    const nr = await retirarRevividos(db, M, rv.map((r) => r.id));
    ok(nr === 1 && !(await vivo('T614-R1', '7500000614295')) && !!(await vivo('T614-R2', '0750000061431'))
      && !!(await vivo('T614-R3', '7500000614325')) && !!(await vivo('T614-R4', '7500000614332')) && !!(await vivo('T614-R5', '7500000614349')),
      'la baja toca sólo ése; los otros cuatro siguen vivos');
    ok(!(await buscarRevividosReemplazados(db, M)).some((r) => String(r.sku).startsWith('T614-R')), 'segunda pasada: nada que retirar');
    await c.query(`INSERT INTO catalog.product_barcodes (tenant_id, sku, barcode, unit, source) VALUES ($1,'T614-R1','7500000614301','PZA','kepler_base')`, [M]);
    const [{ id: idKepler }] = await q(`SELECT id FROM catalog.product_barcodes WHERE tenant_id=$1 AND sku='T614-R1' AND barcode='7500000614301' AND deleted_at IS NULL`, [M]);
    ok(await retirarRevividos(db, M, [idKepler]) === 0 && !!(await vivo('T614-R1', '7500000614301')),
      'NEGATIVA: si le pasan una fila Kepler, la baja no la toca (sólo filas Wincaja)');
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
