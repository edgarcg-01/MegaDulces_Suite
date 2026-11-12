#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.8]` El markup (`catalog.products.markup_pct`) se mantiene AL LLEGAR el cambio de
 * `kepler_ods.kdpv_prod_util` (hop-2, `normalizeMarkup`), no con `import-margin.js` a las 03:00.
 * Contra una base real, dentro de una transacción que se revierte (los BEGIN/COMMIT propios del
 * normalizador y del carril crudo se vuelven savepoints):
 *
 *   A. La regla, igual que el importer: promedio de `c6` de los escalones del SKU en la '03'; otra
 *      sucursal no cuenta; SKU sin filas en la '03' conserva su markup; fila borrada no se toca.
 *   B. Acotado: llamado con un SKU, no toca otro aunque esté desfasado.
 *   C. Sin churn: si nada cambió, 0 filas y la tupla no se reescribe (mismo xmin).
 *   D. ⭐ El camino real: un `raw-upsert` de `kdpv_prod_util` (lo que manda el CDC) mueve el markup.
 *      PRUEBA NEGATIVA: el mismo upsert con la normalización apagada (`meta.normalize=false`) deja el
 *      markup viejo aunque el ODS ya diga otro — si eso saliera movido, la prueba no estaría midiendo
 *      el hop-2.
 *   E. Un cambio en otra sucursal dispara el recálculo y no escribe nada.
 *   F. Modo catálogo completo (`skus=null`, el que usa `import-margin.js --apply`): deja 0 diferencias.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-markup-por-evento', { url: URL });
const { Client } = require('pg');
const { normalizeMarkup, markupFuenteSql, MARKUP_BRANCH } = require('../../services/feeds-ingest/ods-derived');
const { applyRawUpsert } = require('../../services/feeds-ingest/apply-handlers');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

/**
 * Cliente que vive DENTRO de la transacción de la prueba: BEGIN → SAVEPOINT, COMMIT → RELEASE (y suelta
 * las tablas temporales, como haría `ON COMMIT DROP`), ROLLBACK → ROLLBACK TO. Una sentencia suelta fuera
 * de un BEGIN también va en su savepoint, para que un error no aborte la transacción de la prueba.
 */
function dentroDeLaPrueba(c) {
  const pila = []; let n = 0;
  const soltarTemporales = `DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relkind = 'r'
      LOOP EXECUTE format('DROP TABLE pg_temp.%I', r.relname); END LOOP; END $$`;
  return {
    async query(sql, params) {
      const k = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (k === 'BEGIN') { const sp = `sp_${++n}`; pila.push(sp); await c.query(`SAVEPOINT ${sp}`); return { rows: [], rowCount: 0 }; }
      if (k === 'COMMIT') {
        const sp = pila.pop();
        if (sp) await c.query(`RELEASE SAVEPOINT ${sp}`);
        if (!pila.length) await c.query(soltarTemporales);
        return { rows: [], rowCount: 0 };
      }
      if (k === 'ROLLBACK') {
        const sp = pila.pop();
        if (sp) { await c.query(`ROLLBACK TO SAVEPOINT ${sp}`); await c.query(`RELEASE SAVEPOINT ${sp}`); }
        return { rows: [], rowCount: 0 };
      }
      if (pila.length) return c.query(sql, params);
      const sp = `sq_${++n}`;
      await c.query(`SAVEPOINT ${sp}`);
      try { const r = await c.query(sql, params); await c.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${sp}`); await c.query(`RELEASE SAVEPOINT ${sp}`); throw e; }
    },
  };
}

const COLS = [['sucursal', 'text'], ['c1', 'text'], ['c2', 'text'], ['c3', 'numeric'], ['c4', 'numeric'],
  ['c5', 'numeric'], ['c6', 'numeric'], ['c7', 'numeric']].map(([name, type]) => ({ name, type }));
const META = { table: 'kdpv_prod_util', pk: ['c1', 'c2', 'c3'], columns: COLS };
const fila = (sucursal, c1, c2, c3, c6) => ({ sucursal, c1, c2, c3, c4: c3, c5: 0, c6, c7: 10 });

(async () => {
  console.log('\n[CANON.6.8] markup por evento (hop-2 de kdpv_prod_util)\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const db = dentroDeLaPrueba(c);
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const mk = async (sku, borrado = false) => {
    const r = await q(`SELECT markup_pct::text AS m, xmin::text AS x FROM catalog.products
                        WHERE tenant_id=$1 AND sku=$2 AND (deleted_at IS NOT NULL) = $3`, [M, sku, borrado]);
    return r[0] || { m: undefined, x: undefined };
  };
  const silencio = console.log;

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['kepler_ods', 'catalog']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prod_util (sucursal text NOT NULL, c1 text NOT NULL,
      c2 text NOT NULL, c3 numeric NOT NULL, c4 numeric, c5 numeric, c6 numeric, c7 numeric, PRIMARY KEY (sucursal, c1, c2, c3))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, markup_pct numeric(10,4),
      updated_at timestamptz DEFAULT now(), deleted_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    const [{ id: marca }] = await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, 'Marca CANON.6.8', 'T68') RETURNING id`, [M]);
    const prod = (sku, nombre, markup, borrado) => c.query(
      `INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, markup_pct, deleted_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [M, marca, sku, nombre, markup, borrado ? new Date() : null]);
    await prod('T68-A', 'Prueba 6.8 A', null, false);
    await prod('T68-A', 'Prueba 6.8 A borrada', 5, true);
    await prod('T68-B', 'Prueba 6.8 B', 1, false);
    await prod('T68-C', 'Prueba 6.8 C', 7, false);
    await c.query(`INSERT INTO kepler_ods.kdpv_prod_util (sucursal, c1, c2, c3, c4, c5, c6, c7) VALUES
      ('03','T68-A','PZA',1,1,0,10,10), ('03','T68-A','CJA',2,2,0,20,10), ('05','T68-A','PZA',1,1,0,99,10),
      ('03','T68-B','PZA',1,1,0,12.345678,10), ('05','T68-C','PZA',1,1,0,50,10)`);
    ok(MARKUP_BRANCH === '03', `la sucursal de referencia es la '03' (MARGIN_BRANCH='${MARKUP_BRANCH}')`);

    // ── B. Acotado ─────────────────────────────────────────────────────────────────────────────
    const nB = await normalizeMarkup(db, M, ['T68-B']);
    ok(nB === 1 && (await mk('T68-B')).m === '12.3457', 'B: 1 fila, markup redondeado a 4 decimales', `n=${nB} m=${(await mk('T68-B')).m}`);
    ok((await mk('T68-A')).m === null, 'acotado: A, desfasado, no se tocó al pedir sólo B');

    // ── A. La regla ────────────────────────────────────────────────────────────────────────────
    const nA = await normalizeMarkup(db, M, ['T68-A', 'T68-C']);
    ok((await mk('T68-A')).m === '15.0000', "A: promedio de sus dos escalones en la '03' (10 y 20 → 15); el 99 de la '05' no cuenta", `m=${(await mk('T68-A')).m}`);
    ok((await mk('T68-C')).m === '7.0000', "C: sin filas en la '03' conserva su markup (como el importer)", `m=${(await mk('T68-C')).m}`);
    ok((await mk('T68-A', true)).m === '5.0000', 'la fila borrada con el mismo SKU no se toca');
    ok(nA === 1, 'A y C: sólo A se escribió', `n=${nA}`);

    // ── C. Sin churn ───────────────────────────────────────────────────────────────────────────
    const antes = await mk('T68-A');
    const n0 = await normalizeMarkup(db, M, ['T68-A', 'T68-B', 'T68-C']);
    ok(n0 === 0, 'sin cambios en Kepler: 0 filas', `n=${n0}`);
    ok((await mk('T68-A')).x === antes.x, 'sin cambios: la tupla no se reescribió (mismo xmin)');

    // ── D. El camino real del evento, con su prueba negativa ──────────────────────────────────
    console.log = () => {};
    try { await applyRawUpsert(db, M, [fila('03', 'T68-B', 'PZA', 1, 50)], { ...META, normalize: false }); }
    finally { console.log = silencio; }
    const fuente = (await q(`SELECT markup::text AS m FROM (${markupFuenteSql(true)}) f`, [MARKUP_BRANCH, ['T68-B']]))[0];
    ok(fuente && fuente.m === '50.0000', 'el ODS ya dice 50 para B (el upsert crudo sí entró)', fuente && fuente.m);
    ok((await mk('T68-B')).m === '12.3457', 'NEGATIVA: con la normalización apagada el markup NO se mueve', `m=${(await mk('T68-B')).m}`);

    console.log = () => {};
    try { await applyRawUpsert(db, M, [fila('03', 'T68-B', 'PZA', 1, 30)], META); }
    finally { console.log = silencio; }
    ok((await mk('T68-B')).m === '30.0000', 'un raw-upsert de kdpv_prod_util (lo que manda el CDC) mueve el markup al momento', `m=${(await mk('T68-B')).m}`);

    // ── E. Otra sucursal: recalcula y no escribe ──────────────────────────────────────────────
    const xA = (await mk('T68-A')).x;
    console.log = () => {};
    try { await applyRawUpsert(db, M, [fila('05', 'T68-A', 'PZA', 1, 77)], META); }
    finally { console.log = silencio; }
    ok((await mk('T68-A')).m === '15.0000' && (await mk('T68-A')).x === xA, "un cambio en la '05' no mueve ni reescribe A");

    // ── F. Catálogo completo ───────────────────────────────────────────────────────────────────
    await c.query(`UPDATE kepler_ods.kdpv_prod_util SET c6 = 40 WHERE sucursal='03' AND c1='T68-A' AND c2='CJA'`);
    await normalizeMarkup(db, M, null);
    const [d] = await q(`SELECT count(*) FILTER (WHERE p.markup_pct IS DISTINCT FROM f.markup)::int AS difieren
        FROM (${markupFuenteSql(false)}) f JOIN catalog.products p ON p.sku = f.sku AND p.tenant_id = $2 AND p.deleted_at IS NULL`,
      [MARKUP_BRANCH, M]);
    ok((await mk('T68-A')).m === '25.0000', 'catálogo completo: A toma el cambio (10 y 40 → 25)', `m=${(await mk('T68-A')).m}`);
    ok(d.difieren === 0, 'catálogo completo: 0 productos difieren del ODS', `difieren=${d.difieren}`);
  } catch (e) {
    console.log = silencio;
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
