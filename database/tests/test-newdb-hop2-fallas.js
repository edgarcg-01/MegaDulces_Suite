#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.11]` La alarma por EVENTO del hop-2: cuando un normalizador sigue fallando después de reintentar
 * por partes, el hop-2 escribe la falla en `analytics.hop2_fallas` (migración 20261112102727) en ese momento,
 * y el sensor `hop2_fallas` de db-health (el MISMO .ts de la API, con ts-node) la lleva a la bandeja.
 * Contra una base real, en una transacción que se revierte, ejerciendo el `up()` REAL de la migración:
 *
 *   · PRUEBA NEGATIVA: sin la tabla, `registrarFalla` devuelve false, no lanza y el carril sigue.
 *   · la migración deja la tabla con RLS forzada (su propio freno lo verifica).
 *   · un `raw-upsert` de `kdpv_prod_util` con una llave envenenada (markup que desborda): las sanas se
 *     escriben y queda UNA fila con esa llave, el normalizador y el tamaño del lote.
 *   · PRUEBA NEGATIVA: un lote sano no deja fila.
 *   · el sensor: con la falla → warn y nombra la llave; sin fallas en 24 h → ok.
 *
 * Sin base o sin ts-node: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-hop2-fallas', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const RAIZ = path.resolve(__dirname, '..', '..');
const MIG = require(path.join(__dirname, '../migrations-newdb', '20261112102727_canon611_hop2_fallas.js'));

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const KDPV = { table: 'kdpv_prod_util', pk: ['c1', 'c2', 'c3'], columns: [['sucursal', 'text'], ['c1', 'text'], ['c2', 'text'], ['c3', 'numeric'], ['c4', 'numeric'], ['c5', 'numeric'], ['c6', 'numeric'], ['c7', 'numeric']].map(([name, type]) => ({ name, type })) };
const fila = (c1, c6) => ({ sucursal: '05', c1, c2: 'PZA', c3: 1, c4: 1, c5: 0, c6, c7: 10 });

/**
 * La migración usa `knex.raw` (sin parámetros) y `knex.schema.withSchema(..).hasTable/createTable`. Se le da
 * un knex que COMPILA con knex de verdad (sin conexión) y EJECUTA en el cliente de la prueba: así corre su
 * `up()` real dentro de la transacción que se revierte.
 */
function knexSobre(c) {
  const K = require('knex')({ client: 'pg' });
  return {
    raw: (sql, b) => c.query(sql, b),
    fn: K.fn,
    schema: {
      withSchema: (s) => ({
        hasTable: async (t) => (await c.query('SELECT to_regclass($1) AS r', [`${s}.${t}`])).rows[0].r !== null,
        createTable: async (t, cb) => { await c.query(K.schema.withSchema(s).createTable(t, cb).toString()); },
      }),
    },
  };
}

(async () => {
  console.log('\n[CANON.6.11] fallas del hop-2 por evento\n');
  let A, H;
  try {
    require('ts-node').register({ transpileOnly: true, skipProject: true,
      compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', ignoreDeprecations: '6.0' } });
    A = require(path.join(RAIZ, 'apps/api/src/modules/db-health/db-health-arbitro-catalogo.ts'));
    H = require(path.join(RAIZ, 'services/feeds-ingest/apply-handlers'));
  } catch (e) { noMedido(`no se pudo cargar el sensor con ts-node: ${e.message}`); return salir(); }
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const db = dentroDeLaPrueba(c);
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const callado = async (fn) => { const l = console.log; const e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
  const sensor = async () => { const r = (await q(A.HOP2_FALLAS_SQL))[0]; return { h: (Date.now() - new Date(r.last_update).getTime()) / 3600000, nota: String(r.note_extra) }; };

  await c.query('BEGIN');
  try {
    for (const s of ['kepler_ods', 'catalog', 'analytics']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`DO $$ BEGIN IF to_regprocedure('public.current_tenant_id()') IS NULL AND to_regprocedure('current_tenant_id()') IS NULL THEN
      EXECUTE 'CREATE FUNCTION public.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting(''app.tenant_id'', true), '''')::uuid $f$';
      END IF; END $$`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prod_util (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL,
      c3 numeric NOT NULL, c4 numeric, c5 numeric, c6 numeric, c7 numeric, PRIMARY KEY (sucursal, c1, c2, c3))`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, nombre varchar NOT NULL, markup_pct numeric(10,4), is_promo boolean NOT NULL DEFAULT false,
      updated_at timestamptz DEFAULT now(), deleted_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    const [{ id: B }] = await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, 'Marca CANON.6.11 f', 'T612') RETURNING id`, [M]);
    for (const s of ['T612-MA', 'T612-MP', 'T612-MB']) {
      await c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre) VALUES ($1,$2,$3,$4)`, [M, B, s, `Prod ${s}`]);
    }
    await c.query(`INSERT INTO kepler_ods.kdpv_prod_util (sucursal,c1,c2,c3,c4,c5,c6,c7) VALUES
      ('03','T612-MA','PZA',1,1,0,10,10), ('03','T612-MP','PZA',1,1,0,10000000,10), ('03','T612-MB','PZA',1,1,0,20,10)`);

    // ── Sin la tabla: no lanza ────────────────────────────────────────────────────────────────
    const habia = (await q(`SELECT to_regclass('analytics.hop2_fallas') AS r`))[0].r !== null;
    if (!habia) {
      let tiro = null; let r = null;
      try { r = await H.registrarFalla(db, M, 'kdpv_prod_util', 'normalizeMarkup', ['X'], 1, new Error('prueba')); } catch (e) { tiro = e; }
      ok(!tiro && r === false && (await q('SELECT 1 AS uno'))[0].uno === 1, 'NEGATIVA: sin la tabla, registrarFalla devuelve false, no lanza y la transacción sigue viva');
    } else noMedido('la base ya trae analytics.hop2_fallas: la prueba sin tabla no aplica');

    // ── La migración real ─────────────────────────────────────────────────────────────────────
    await MIG.up(knexSobre(c));
    const [t] = await q(`SELECT c.relforcerowsecurity AS forzado FROM pg_class c WHERE c.oid = 'analytics.hop2_fallas'::regclass`);
    ok(t && t.forzado === true, 'la migración deja analytics.hop2_fallas con RLS forzada');
    const s0 = await sensor();
    const antes = Number((await q(`SELECT count(*)::int n FROM analytics.hop2_fallas WHERE normalizador='normalizeMarkup'`))[0].n);

    // ── Lote sano: no deja fila ───────────────────────────────────────────────────────────────
    await callado(() => H.applyRawUpsert(db, M, [fila('T612-MA', 1), fila('T612-MB', 1)], KDPV));
    const sano = Number((await q(`SELECT count(*)::int n FROM analytics.hop2_fallas WHERE normalizador='normalizeMarkup'`))[0].n);
    ok(sano === antes, 'NEGATIVA: un lote sano no deja fila de falla del markup');

    // ── Llave envenenada ──────────────────────────────────────────────────────────────────────
    await c.query(`UPDATE kepler_ods.kdpv_prod_util SET c6 = c6 + 1 WHERE sucursal='03' AND c1 IN ('T612-MA','T612-MB')`);
    await callado(() => H.applyRawUpsert(db, M, [fila('T612-MA', 2), fila('T612-MP', 2), fila('T612-MB', 2)], KDPV));
    const mk = async (s) => (await q(`SELECT markup_pct::text AS m FROM catalog.products WHERE tenant_id=$1 AND sku=$2`, [M, s]))[0].m;
    ok(await mk('T612-MA') === '11.0000' && await mk('T612-MB') === '21.0000', 'las llaves sanas del lote se escriben');
    const fallas = await q(`SELECT tabla, normalizador, llaves, llaves_lote, error FROM analytics.hop2_fallas
                             WHERE normalizador='normalizeMarkup' ORDER BY id DESC LIMIT 1`);
    const f = fallas[0] || {};
    ok(fallas.length && f.tabla === 'kdpv_prod_util' && JSON.stringify(f.llaves) === '["T612-MP"]' && f.llaves_lote === 3,
      'queda UNA fila con la llave envenenada, el normalizador y el tamaño del lote', JSON.stringify(f));
    ok(/overflow|desbord/i.test(f.error || ''), 'y con el error de Postgres', f.error);

    // ── El sensor ─────────────────────────────────────────────────────────────────────────────
    const s1 = await sensor();
    ok(s1.h > 24 && s1.h < 48 && /T612-MP/.test(s1.nota) && /kdpv_prod_util:normalizeMarkup/.test(s1.nota),
      'el sensor hop2_fallas pasa a warn y nombra la llave y el normalizador', s1.nota);
    await c.query(`UPDATE analytics.hop2_fallas SET created_at = now() - interval '25 hours'`);
    const s2 = await sensor();
    ok(s2.h < 1 && /sin fallas/.test(s2.nota), 'pasadas 24 h sin fallas nuevas, vuelve a ok (lo que siga mal lo dicen los árbitros)', s2.nota);
    void s0;
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
