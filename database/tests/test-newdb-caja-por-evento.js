#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.20]` El precio de caja (`analytics.product_box_price`) se mantiene AL LLEGAR el cambio, sin el nocturno
 * `import-box-price.js`, y ya no depende del plan de la consulta. Contra una base real, dentro de una transacción que se
 * revierte, por el camino real (`applyRawUpsert` / `applyRawDelete`):
 *
 *   J. NEGATIVA: con la normalización apagada, un precio de caja nuevo de Kepler no entra.
 *   A. ⭐ Plazas empatadas en el umbral con precios distintos: gana la MODA (siete a 1,200 y una a 900 → 1,200); y el
 *      cálculo completo (el del nocturno) da lo mismo que el acotado del evento. (Que la regla vieja eligiera la minoría
 *      no se puede forzar aquí: el orden de un array_agg con empate no es estable; la vieja muere por B y por esa igualdad.)
 *   B. La moda empata (una plaza a 500, otra a 480): gana el menor.
 *   C. Sólo cuenta el umbral menor (desde 3 a 700 gana a desde 10 a 650).
 *   D. La 00 (CEDIS) no vota.
 *   E. Sin CJA: PAQ × factor_sale (fuente derived_paq).
 *   F. ⭐ Un alta por `kdii` con el precio de caja ya en el ODS: el precio entra en la MISMA llegada (lo veía sólo el nocturno).
 *   G. ⭐ `factor_sale` nuevo y llega `kdii`: el respaldo PAQ × factor se recalcula (antes, sólo el nocturno).
 *   H. Kepler borra los renglones: la fila sale.
 *   I. Sin churn: la segunda pasada escribe 0.
 *   K. El árbitro (`ARBITRO_CAJA_SQL`, el MISMO .ts de db-health): un precio distinto, uno que falta y uno de más (producto
 *      vivo) suman 3; la fila de un producto BORRADO no cuenta; corrido el catálogo entero, vuelve a la base.
 *
 * Sin base: NO MEDIDO, nunca ✔. Sin ts-node: K queda NO MEDIDO.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-por-evento', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const { applyRawUpsert, applyRawDelete } = require('../../services/feeds-ingest/apply-handlers');
const { normalizeBoxPrice } = require('../../services/feeds-ingest/ods-derived');
const RAIZ = path.resolve(__dirname, '..', '..');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const KDPV = { table: 'kdpv_prod_util', pk: ['c1', 'c2', 'c3'], columns: [['sucursal', 'text'], ['c1', 'text'], ['c2', 'text'], ['c3', 'numeric'],
  ['c4', 'numeric'], ['c5', 'numeric'], ['c6', 'numeric'], ['c7', 'numeric']].map(([name, type]) => ({ name, type })) };
const KDII = { table: 'kdii', pk: ['c1'], columns: ['sucursal', 'c1', 'c2', 'c3', 'c7', 'c95'].map((name) => ({ name, type: 'text' })).concat([{ name: 'c90', type: 'numeric' }]) };
const pv = (sucursal, c1, c2, c4, c7, c3 = 1) => ({ sucursal, c1, c2, c3, c4, c5: null, c6: null, c7 });
const ki = (sucursal, c1, c2) => ({ sucursal, c1, c2, c3: 'L620', c7: c1, c95: null, c90: 10 });

(async () => {
  console.log('\n[CANON.6.20] precio de caja por evento (kdpv_prod_util / kdii)\n');
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
  const id = async (sku) => ((await q(`SELECT id FROM catalog.products WHERE tenant_id=$1 AND sku=$2 AND deleted_at IS NULL`, [M, sku]))[0] || {}).id;
  const caja = async (sku) => (await q(`SELECT t.cja_price::numeric AS p, t.source FROM analytics.product_box_price t JOIN catalog.products p ON p.id = t.product_id
      WHERE t.tenant_id=$1 AND p.sku=$2 AND p.deleted_at IS NULL`, [M, sku]))[0] || null;
  const precio = async (sku) => { const r = await caja(sku); return r ? Number(r.p) : null; };
  const arbitro = async () => {
    const nota = String((await q(A.ARBITRO_CAJA_SQL))[0].note_extra || '');
    const m = /^(\d+) sin tomar/.exec(nota);
    return { n: /^NO MEDIDO/.test(nota) ? null : /: 0 difieren de/.test(nota) || /^CUMPLIÓ/.test(nota) ? 0 : m ? Number(m[1]) : undefined, nota };
  };

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['kepler_ods', 'catalog', 'analytics']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prod_util (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL,
      c3 numeric NOT NULL, c4 numeric, c5 numeric, c6 numeric, c7 numeric, PRIMARY KEY (sucursal, c1, c2, c3))`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, PRIMARY KEY (sucursal, c1))`);
    for (const col of ['c2', 'c3', 'c7', 'c95']) await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS ${col} text`);
    await c.query(`ALTER TABLE kepler_ods.kdii ADD COLUMN IF NOT EXISTS c90 numeric`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, barcode varchar, source varchar, factor_sale integer,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz, UNIQUE (tenant_id, brand_id, nombre))`);
    await c.query(`ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS factor_sale integer`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.product_box_price (tenant_id uuid NOT NULL, product_id uuid NOT NULL, cja_price numeric NOT NULL,
      source text NOT NULL DEFAULT 'kepler_kdpv', updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, product_id))`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.cron_run_log (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, job_key text NOT NULL,
      status text NOT NULL, finished_at timestamptz, logged_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.db_health_alerts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      source_key varchar NOT NULL, status varchar NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);

    const marca = async (code) => (await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, $2, $3) RETURNING id`, [M, `Marca ${code}`, code]))[0].id;
    if (!(await q(`SELECT 1 FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA'`, [M])).length) await marca('SIN-LINEA');
    const L = await marca('L620');
    const alta = (sku, nombre, factor = null, borrado = false) => c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, factor_sale, deleted_at)
      VALUES ($1, $2, $3, $4, $5, ${borrado ? 'now()' : 'NULL'})`, [M, L, sku, nombre, factor]);
    // Una fila neutra (producto sin renglones en kdpv… que la regla daría por sobrante: va BORRADO, que no cuenta) para que
    // el árbitro vea la tabla — con 0 a la vista dice NO MEDIDO.
    await alta('96200', 'NEUTRO T620', null, true);
    await c.query(`INSERT INTO analytics.product_box_price (tenant_id, product_id, cja_price) SELECT $1, id, 1 FROM catalog.products WHERE tenant_id=$1 AND sku='96200'`, [M]);
    const base = A ? await arbitro() : null;

    for (const [sku, n, f] of [['96201', 'A T620'], ['96202', 'B T620'], ['96203', 'C T620'], ['96204', 'D T620'], ['96205', 'E T620', 12],
      ['96207', 'J T620'], ['96209', 'SIN KDPV T620']]) await alta(sku, n, f);

    // ── J (negativa) — en su propio SKU: el renglón no debe llegar antes que la minoría de A ─────────────────────────
    await callado(() => applyRawUpsert(db, M, [pv('01', '96207', 'CJA', 3, 1200)], { ...KDPV, normalize: false }));
    ok(await precio('96207') === null, 'NEGATIVA: con la normalización apagada el precio de caja no entra');
    await c.query(`DELETE FROM kepler_ods.kdpv_prod_util WHERE c1 = '96207'`); // que no lo tome después el catálogo entero

    // ── A–E por el camino real (la minoría de A llega PRIMERO) ───────────────────────────────
    const FILAS = [
      pv('05', '96201', 'CJA', 3, 900, 2),
      ...['01', '02', '03', '04', '05', '06', '07', '08'].map((s) => pv(s, '96201', 'CJA', 3, 1200)),
      pv('01', '96202', 'CJA', 3, 500), pv('02', '96202', 'CJA', 3, 480),
      ...['01', '02', '03'].map((s) => pv(s, '96203', 'CJA', 3, 700)), pv('01', '96203', 'CJA', 10, 650, 2),
      pv('00', '96204', 'CJA', 3, 100), pv('01', '96204', 'CJA', 3, 300),
      pv('01', '96205', 'PAQ', 3, 20), pv('02', '96205', 'PAQ', 3, 20),
    ];
    await callado(() => applyRawUpsert(db, M, FILAS, KDPV));
    ok(await precio('96201') === 1200, 'A. plazas empatadas en el umbral: gana la moda (1,200), no la minoría (900)', await precio('96201'));
    ok(await precio('96202') === 480, 'B. la moda empata: gana el menor', await precio('96202'));
    ok(await precio('96203') === 700, 'C. sólo cuenta el umbral menor', await precio('96203'));
    ok(await precio('96204') === 300, 'D. la 00 no vota', await precio('96204'));
    const e = await caja('96205');
    ok(e && Number(e.p) === 240 && e.source === 'derived_paq', 'E. sin CJA: PAQ × factor_sale (20 × 12), fuente derived_paq', JSON.stringify(e));
    const nFull = await normalizeBoxPrice(db, M, null);
    const neutra = Number((await q(`SELECT count(*) n FROM analytics.product_box_price t JOIN catalog.products p ON p.id = t.product_id WHERE p.sku = '96200'`))[0].n);
    ok(nFull === 1 && neutra === 0 && await precio('96201') === 1200 && await precio('96202') === 480,
      'el catálogo entero (lo que hacía el nocturno) da lo mismo que el evento en los vivos: sólo borra la fila del producto borrado', `n=${nFull} · neutra=${neutra}`);

    // ── F. Alta por kdii con el precio ya en el ODS ───────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, ['01', '02', '03'].map((s) => pv(s, '96206', 'CJA', 3, 1000)), KDPV));
    ok(!(await id('96206')), '(el producto todavía no existe: el precio de caja espera)');
    await callado(() => applyRawUpsert(db, M, [ki('01', '96206', 'NUEVO F T620')], KDII));
    ok(await precio('96206') === 1000, 'F. un alta por kdii con el precio en el ODS: el precio de caja entra en la misma llegada', await precio('96206'));

    // ── G. factor_sale nuevo + kdii ───────────────────────────────────────────────────────────
    await c.query(`UPDATE catalog.products SET factor_sale = 24 WHERE tenant_id=$1 AND sku='96205'`, [M]);
    const antesG = A ? await arbitro() : null;
    await callado(() => applyRawUpsert(db, M, [ki('01', '96205', 'E T620')], KDII));
    ok(await precio('96205') === 480, 'G. factor_sale nuevo y llega kdii: el respaldo PAQ × factor se recalcula (20 × 24)', await precio('96205'));
    if (A) ok(antesG.n === base.n + 1, '   (y antes de que llegara kdii, el árbitro lo contaba)', `n=${antesG.n}`);

    // ── H. Kepler borra los renglones ─────────────────────────────────────────────────────────
    await callado(() => applyRawDelete(db, M, [{ sucursal: '01', c1: '96202', c2: 'CJA', c3: 1 }, { sucursal: '02', c1: '96202', c2: 'CJA', c3: 1 }], KDPV));
    ok(await precio('96202') === null, 'H. Kepler borra los renglones: la fila sale', await precio('96202'));

    // ── I. Sin churn ─────────────────────────────────────────────────────────────────────────
    const nI = await normalizeBoxPrice(db, M, ['96201', '96203', '96204', '96205', '96206']);
    ok(nI === 0, 'I. segunda pasada sin cambios en Kepler: 0 filas', `n=${nI}`);

    // ── K. El árbitro ────────────────────────────────────────────────────────────────────────
    if (!A) {
      noMedido('el árbitro (sin ts-node no se carga el .ts de db-health)');
    } else {
      const k0 = await arbitro();
      ok(base && base.n != null && k0.n === base.n, 'K. con el hop-2 recién corrido el árbitro vuelve a la base', `base=${base && base.n} · ahora=${k0.n} · ${k0.nota}`);
      await c.query(`UPDATE analytics.product_box_price SET cja_price = 1 WHERE product_id = $1`, [await id('96201')]);
      await c.query(`DELETE FROM analytics.product_box_price WHERE product_id = $1`, [await id('96203')]);
      await c.query(`INSERT INTO analytics.product_box_price (tenant_id, product_id, cja_price) VALUES ($1, $2, 5)`, [M, await id('96209')]);
      await alta('96208', 'BORRADO T620', null, true);
      await c.query(`INSERT INTO analytics.product_box_price (tenant_id, product_id, cja_price) SELECT $1, id, 7 FROM catalog.products WHERE tenant_id=$1 AND sku='96208'`, [M]);
      const k3 = await arbitro();
      ok(k3.n === base.n + 3, 'un precio distinto, uno que falta y uno de más (producto vivo) suman 3; el de un producto borrado no cuenta', `n=${k3.n} · ${k3.nota}`);
      const nK = await normalizeBoxPrice(db, M, null);
      const k4 = await arbitro();
      const quedanBorrados = Number((await q(`SELECT count(*) n FROM analytics.product_box_price t JOIN catalog.products p ON p.id = t.product_id
          WHERE p.deleted_at IS NOT NULL AND p.sku IN ('96200', '96208')`))[0].n);
      ok(k4.n === base.n && nK >= 3 && quedanBorrados === 0,
        'corrido el catálogo entero: vuelve a la base (y la herramienta también limpia lo de productos borrados)', `n=${k4.n} · escritas=${nK} · borrados que quedan=${quedanBorrados}`);
    }
  } catch (err) {
    fail++; console.log('  ✗ excepción:', err.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  salir();
})();
