#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.12]` Una línea nueva de Kepler (`kepler_ods.kdig`) es marca AL LLEGAR (hop-2,
 * `normalizeBrandsFromKdig`), sin el script de los sábados `import-brands-lineas.js`; y un producto que entró a
 * SIN-LINEA sale de ahí en cuanto su línea es marca (antes nadie lo movía). Contra una base real, dentro de una
 * transacción que se revierte, por el camino real (`applyRawUpsert`):
 *
 *   J. NEGATIVA: con la normalización apagada, la línea NO se vuelve marca.
 *   A. Producto primero, línea después: el producto entra a SIN-LINEA; al llegar la línea nace la marca (nombre
 *      en mayúsculas y espacios colapsados) y el producto pasa a ella.
 *   B. Línea primero, producto después: el producto entra directo a su marca.
 *   C. El nombre ya es de una marca SIN código → la adopta, no crea otra.
 *   D. El nombre ya es de una marca con OTRO código → conflicto: nada.
 *   E. El nombre es de una marca BORRADA → nada.
 *   F. Dos líneas nuevas con el mismo nombre: gana la de sucursal menor AUNQUE no venga en el lote.
 *   G. Atorados: un producto en SIN-LINEA con su marca ya creada sale al llegar su kdii (y por la línea, con la
 *      herramienta); uno con marca puesta a mano NO se mueve; uno que chocaría con la unique se queda sin tumbar
 *      el lote. NEGATIVA: con la normalización apagada, se queda en SIN-LINEA.
 *   I. Sin churn: la segunda pasada escribe 0.
 *   K. El árbitro (`ARBITRO_MARCAS_SQL`, el MISMO .ts de db-health): un atorado y una línea sin tomar suman 2;
 *      corrido el normalizador, vuelve a la base.
 *
 * Sin base: NO MEDIDO, nunca ✔. Sin ts-node: K queda NO MEDIDO.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-marcas-por-evento', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const { applyRawUpsert, normalizeBrandsFromKdig, normalizeProductsFromOds } = require('../../services/feeds-ingest/apply-handlers');
const RAIZ = path.resolve(__dirname, '..', '..');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const KDIG = { table: 'kdig', pk: ['c1'], columns: [['sucursal', 'text'], ['c1', 'text'], ['c2', 'text'], ['c3', 'text'], ['c4', 'numeric']].map(([name, type]) => ({ name, type })) };
const KDII = { table: 'kdii', pk: ['c1'], columns: ['sucursal', 'c1', 'c2', 'c3', 'c7'].map((name) => ({ name, type: 'text' })).concat([{ name: 'c90', type: 'numeric' }]) };
const linea = (sucursal, c1, c2) => ({ sucursal, c1, c2, c3: '', c4: 0 });
const art = (sucursal, c1, c2, c3) => ({ sucursal, c1, c2, c3, c7: null, c90: 10 });

(async () => {
  console.log('\n[CANON.6.12] marcas por evento (kdig)\n');
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
  const marcaDe = async (sku) => ((await q(`SELECT b.code FROM catalog.products p JOIN catalog.brands b ON b.id = p.brand_id
      WHERE p.tenant_id=$1 AND p.sku=$2 AND p.deleted_at IS NULL`, [M, sku]))[0] || {}).code;
  const porCodigo = async (code) => (await q(`SELECT nombre FROM catalog.brands WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`, [M, code]))[0];
  const porNombre = async (nombre) => q(`SELECT code, deleted_at IS NOT NULL AS borrada FROM catalog.brands WHERE tenant_id=$1 AND nombre=$2`, [M, nombre]);
  const arbitro = async () => {
    const nota = String((await q(A.ARBITRO_MARCAS_SQL))[0].note_extra || '');
    const m = /^(\d+) sin tomar/.exec(nota);
    return { n: /^NO MEDIDO/.test(nota) ? null : /: 0 difieren de/.test(nota) || /^CUMPLIÓ/.test(nota) ? 0 : m ? Number(m[1]) : undefined, nota };
  };

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['kepler_ods', 'catalog', 'analytics']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdig (sucursal text NOT NULL, c1 text NOT NULL, c2 text, c3 text, c4 numeric,
      PRIMARY KEY (sucursal, c1))`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, c2 text, c3 text, c7 text,
      c90 numeric, PRIMARY KEY (sucursal, c1))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      CONSTRAINT brands_tenant_nombre_unique UNIQUE (tenant_id, nombre))`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS brands_tenant_code_unique ON catalog.brands (tenant_id, code)
      WHERE code IS NOT NULL AND deleted_at IS NULL`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, barcode varchar, source varchar, markup_pct numeric(10,4),
      is_promo boolean NOT NULL DEFAULT false, cost_base numeric, cost_with_tax numeric, cost_per_case numeric, iva_rate numeric,
      ieps_rate numeric, factor_sale numeric, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      deleted_at timestamptz, UNIQUE (tenant_id, brand_id, nombre))`);
    // Las bitácoras que lee la condición de retiro del árbitro (en una base migrada ya existen).
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.cron_run_log (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, job_key text NOT NULL,
      status text NOT NULL, finished_at timestamptz, logged_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.db_health_alerts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      source_key varchar NOT NULL, status varchar NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    await c.query(`INSERT INTO catalog.brands (tenant_id, code, nombre) SELECT $1, 'SIN-LINEA', 'SIN LÍNEA'
                    WHERE NOT EXISTS (SELECT 1 FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA')`, [M]);
    const [{ id: SL }] = await q(`SELECT id FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA' LIMIT 1`, [M]);
    const marca = async (nombre, code, borrada = false) => (await q(`INSERT INTO catalog.brands (tenant_id, nombre, code, deleted_at)
      VALUES ($1,$2,$3,$4) RETURNING id`, [M, nombre, code, borrada ? new Date() : null]))[0].id;
    // Un producto neutro para que el árbitro vea catálogo (con 0 a la vista dice NO MEDIDO, nunca 0), y la base.
    await c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre) VALUES ($1,$2,'T612-B0','B0 T612')`, [M, await marca('BASE T612', 'T612X')]);
    const base = A ? await arbitro() : null;
    await marca('ADOPTA T612', null);
    await marca('CONFLICTO T612', 'T612Z');
    await marca('BORRADA T612', 'T612Y', true);
    const BG = await marca('MARCA G T612', 'T612G');
    const BK = await marca('CURADA T612', 'T612K');
    const prod = (sku, nombre, b) => c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre) VALUES ($1,$2,$3,$4)`, [M, b, sku, nombre]);
    await prod('T612-P3', 'P3 T612', SL);   // atorado: su línea T612G ya es marca
    await prod('T612-P6', 'P6 T612', SL);   // atorado, lo saca la línea (herramienta / evento de kdig)
    await prod('T612-P4', 'P4 T612', BK);   // marca puesta a mano: no se toca
    await prod('T612-P5', 'P5 T612', SL);   // chocaría: ya hay un 'P5 T612' en MARCA G
    await prod('T612-P5X', 'P5 T612', BG);
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c90) VALUES
      ('01','T612-P3','P3 T612','T612G',10), ('01','T612-P6','P6 T612','T612G',10), ('01','T612-P4','P4 T612','T612G',10),
      ('01','T612-P5','P5 T612','T612G',10), ('01','T612-P5X','P5 T612','T612G',10)`);

    // ── J (negativa) ──────────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [linea('01', 'T612A', '  marca  nueva\r t612 ')], { ...KDIG, normalize: false }));
    ok(!(await porCodigo('T612A')), 'NEGATIVA: con la normalización apagada la línea NO se vuelve marca');

    // ── A. Producto primero, línea después ───────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [art('01', 'T612-P1', 'P1 T612', 'T612A')], KDII));
    ok(await marcaDe('T612-P1') === 'SIN-LINEA', 'producto de una línea que aún no es marca: entra a SIN-LINEA', await marcaDe('T612-P1'));
    await callado(() => applyRawUpsert(db, M, [linea('02', 'T612A', '  marca  nueva\r t612 ')], KDIG));
    ok((await porCodigo('T612A') || {}).nombre === 'MARCA NUEVA T612', 'llega la línea: nace la marca, en mayúsculas y con espacios colapsados',
      JSON.stringify(await porCodigo('T612A')));
    ok(await marcaDe('T612-P1') === 'T612A', 'y el producto sale de SIN-LINEA a su marca', await marcaDe('T612-P1'));

    // ── B. Línea primero, producto después ───────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [linea('01', 'T612B', 'MARCA B T612')], KDIG));
    await callado(() => applyRawUpsert(db, M, [art('01', 'T612-P2', 'P2 T612', 'T612B')], KDII));
    ok(await marcaDe('T612-P2') === 'T612B', 'línea antes que el producto: el producto entra directo a su marca', await marcaDe('T612-P2'));

    // ── C, D, E ───────────────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [linea('01', 'T612C', 'Adopta  T612'), linea('01', 'T612D', 'CONFLICTO T612'),
      linea('01', 'T612E', 'BORRADA T612')], KDIG));
    const ad = await porNombre('ADOPTA T612');
    ok(ad.length === 1 && ad[0].code === 'T612C', 'el nombre es de una marca sin código: la adopta, no crea otra', JSON.stringify(ad));
    const cf = await porNombre('CONFLICTO T612');
    ok(!(await porCodigo('T612D')) && cf.length === 1 && cf[0].code === 'T612Z', 'el nombre es de otra marca con código: conflicto, nada cambia', JSON.stringify(cf));
    const bo = await porNombre('BORRADA T612');
    ok(!(await porCodigo('T612E')) && bo.length === 1 && bo[0].borrada, 'el nombre es de una marca borrada: no la resucita ni crea otra', JSON.stringify(bo));

    // ── F. Desempate ──────────────────────────────────────────────────────────────────────────
    await c.query(`INSERT INTO kepler_ods.kdig (sucursal, c1, c2, c3, c4) VALUES ('00','T612F2','DOBLE T612','',0)`);
    await callado(() => applyRawUpsert(db, M, [linea('01', 'T612F1', 'DOBLE T612')], KDIG));
    const db2 = await porNombre('DOBLE T612');
    ok(db2.length === 1 && db2[0].code === 'T612F2', 'dos líneas nuevas con el mismo nombre: gana la de sucursal menor aunque no venga en el lote',
      JSON.stringify(db2));

    // ── G. Atorados ───────────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [art('02', 'T612-P3', 'P3 T612', 'T612G')], { ...KDII, normalize: false }));
    ok(await marcaDe('T612-P3') === 'SIN-LINEA', 'NEGATIVA: con la normalización apagada el atorado se queda en SIN-LINEA');
    await callado(() => applyRawUpsert(db, M, [art('02', 'T612-P3', 'P3 T612', 'T612G'), art('02', 'T612-P4', 'P4 T612', 'T612G'),
      art('02', 'T612-P5', 'P5 T612', 'T612G')], KDII));
    ok(await marcaDe('T612-P3') === 'T612G', 'atorado en SIN-LINEA con su marca ya creada: sale al llegar su kdii', await marcaDe('T612-P3'));
    ok(await marcaDe('T612-P4') === 'T612K', 'un producto con marca puesta a mano NO se mueve a la de su línea', await marcaDe('T612-P4'));
    ok(await marcaDe('T612-P5') === 'SIN-LINEA', 'el que chocaría con la unique (marca, nombre) se queda, sin tumbar el lote', await marcaDe('T612-P5'));
    const nG = await normalizeBrandsFromKdig(db, M, ['T612G']);
    ok(nG === 1 && await marcaDe('T612-P6') === 'T612G', 'por la línea (herramienta / evento de kdig): sale el atorado que no tuvo evento propio', `n=${nG}`);
    // Mismo lote: P8 sale de SIN-LINEA y Kepler renombra P9 (ya en MARCA G) al MISMO nombre → irían al mismo
    // (marca, nombre). Pasa el de clave menor y el lote se escribe (sin el desempate: 23505 y se revierte todo).
    await prod('T612-P8', 'P8 T612', SL); await prod('T612-P9', 'OTRO P9 T612', BG); await prod('T612-P10', 'P10 T612', SL);
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c90) VALUES
      ('01','T612-P8','P8 T612','T612G',10), ('01','T612-P9','P8 T612','T612G',10), ('01','T612-P10','P10 T612','T612G',10)`);
    let tiro = null; let n8 = null;
    try { n8 = await normalizeProductsFromOds(db, M, ['T612-P8', 'T612-P9', 'T612-P10']); } catch (e) { tiro = e.message; }
    const nom9 = ((await q(`SELECT nombre FROM catalog.products WHERE tenant_id=$1 AND sku='T612-P9'`, [M]))[0] || {}).nombre;
    ok(!tiro && n8 === 2 && await marcaDe('T612-P8') === 'T612G' && nom9 === 'OTRO P9 T612' && await marcaDe('T612-P10') === 'T612G',
      'salir de SIN-LINEA y un renombre al mismo (marca, nombre) en un lote: pasa el de clave menor y el lote se escribe', tiro || `n=${n8} · P9=${nom9}`);

    // ── I. Sin churn ──────────────────────────────────────────────────────────────────────────
    const n0 = await normalizeBrandsFromKdig(db, M, ['T612A', 'T612B', 'T612C', 'T612D', 'T612E', 'T612F1', 'T612G']);
    ok(n0 === 0, 'segunda pasada sin cambios en Kepler: 0', `n=${n0}`);

    // ── K. El árbitro ─────────────────────────────────────────────────────────────────────────
    if (!A) noMedido('árbitro: sin ts-node no se carga el .ts de db-health');
    else if (base.n == null) noMedido(`árbitro: la base no se pudo medir (${base.nota})`);
    else {
      const k0 = await arbitro();
      ok(k0.n === base.n, 'árbitro: con todo normalizado vuelve a la base (no cuenta conflicto, borrada ni el que frena la unique)', `${base.n} → ${k0.nota}`);
      await prod('T612-P7', 'P7 T612', SL);
      await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c90) VALUES ('01','T612-P7','P7 T612','T612G',10)`);
      await c.query(`INSERT INTO kepler_ods.kdig (sucursal, c1, c2, c3, c4) VALUES ('01','T612H','NUEVA H T612','',0)`);
      const k1 = await arbitro();
      ok(k1.n === base.n + 2, 'árbitro: un atorado y una línea sin tomar suman 2', k1.nota);
      await normalizeBrandsFromKdig(db, M, ['T612H', 'T612G']);
      const k2 = await arbitro();
      ok(k2.n === base.n && await marcaDe('T612-P7') === 'T612G' && !!(await porCodigo('T612H')),
        'árbitro: corrido normalizeBrandsFromKdig, vuelve a la base (las dos reglas coinciden)', k2.nota);
    }
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
