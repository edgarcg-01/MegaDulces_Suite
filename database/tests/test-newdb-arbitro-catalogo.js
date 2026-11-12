#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.11]` El ÁRBITRO del catálogo por evento: los tres sensores de `db-health`
 * (`apps/api/src/modules/db-health/db-health-arbitro-catalogo.ts`, cargado con ts-node — el MISMO archivo
 * que corre la API) contra los normalizadores del hop-2 (`services/feeds-ingest`). La regla vive dos veces
 * a propósito; esta prueba las cruza. Contra una base real, en una transacción que se revierte, y medido
 * como DIFERENCIA contra la línea base (la base puede traer datos propios):
 *
 *   · markup, promo y nombres: un producto desfasado suma 1; corrido su normalizador, vuelve a la base.
 *     Si el SQL del sensor y el normalizador dijeran cosas distintas, uno de los dos pasos falla.
 *   · nombres: el atajo no pierde el caso CEDIS-contra-tiendas (H12) y NO cuenta lo que frena la unique.
 *   · el veredicto: 1 → warn (30 h), más de 50 → critical, y 0 productos a la vista → NO MEDIDO en rojo,
 *     nunca 0 en verde (PRUEBA NEGATIVA de la ceguera por RLS).
 *
 * Sin base o sin ts-node: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-arbitro-catalogo', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const RAIZ = path.resolve(__dirname, '..', '..');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

(async () => {
  console.log('\n[CANON.6.11] árbitro del catálogo por evento\n');
  let A, D, H;
  try {
    require('ts-node').register({ transpileOnly: true, skipProject: true,
      compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', ignoreDeprecations: '6.0' } });
    A = require(path.join(RAIZ, 'apps/api/src/modules/db-health/db-health-arbitro-catalogo.ts'));
    D = require(path.join(RAIZ, 'services/feeds-ingest/ods-derived'));
    H = require(path.join(RAIZ, 'services/feeds-ingest/apply-handlers'));
  } catch (e) { noMedido(`no se pudo cargar el sensor con ts-node: ${e.message}`); return salir(); }
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const db = dentroDeLaPrueba(c);
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  /** Corre un sensor: { n: difieren (null = NO MEDIDO), h: edad en horas del centinela, nota }. */
  const sensor = async (sql) => {
    const r = (await q(sql))[0];
    const nota = String(r.note_extra || '');
    const m0 = /: 0 difieren de/.exec(nota); const mn = /^(\d+) con /.exec(nota);
    return { n: /^NO MEDIDO/.test(nota) ? null : m0 ? 0 : mn ? Number(mn[1]) : undefined,
      h: (Date.now() - new Date(r.last_update).getTime()) / 3600000, nota };
  };
  const cubeta = (h) => (h < 1 ? 'ok' : h < 48 ? 'warn' : 'critical');

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
    await c.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.cron_run_log (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, job_key text NOT NULL,
      status text NOT NULL, finished_at timestamptz, logged_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.db_health_alerts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      source_key varchar NOT NULL, status varchar NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz)`);
    // Los nocturnos que estos sensores reemplazan «corrieron hace un rato»: así ninguno pide su retiro todavía.
    const LLAVES = ['feed_nightly/import-margin.js', 'feed_prices/repoint-catalog-prices.js --solo-promo', 'feed_nightly/repoint-catalog-names.js'];
    for (const k of LLAVES) {
      await c.query(`INSERT INTO analytics.cron_run_log (tenant_id, job_key, status, finished_at) VALUES ($1, $2, 'ok', now() - interval '1 hour')`, [M, k]);
    }
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    const [{ id: B }] = await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, 'Marca CANON.6.11', 'T611') RETURNING id`, [M]);
    const prod = (sku, nombre, extra = {}) => c.query(
      `INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, markup_pct, is_promo) VALUES ($1,$2,$3,$4,$5,$6)`,
      [M, B, sku, nombre, extra.markup ?? null, extra.promo ?? false]);

    // Un producto neutro (sin filas en Kepler: no puede diferir) para que la base vacía de CI tenga algo a la vista.
    await prod('T611-BASE', 'Neutro 6.11');
    const base = { markup: await sensor(A.ARBITRO_MARKUP_SQL), promo: await sensor(A.ARBITRO_PROMO_SQL), nombres: await sensor(A.ARBITRO_NOMBRES_SQL) };
    for (const [k, v] of Object.entries(base)) {
      if (v.n == null) { noMedido(`${k}: la línea base es «${v.nota}» — esta base no tiene catálogo del tenant`); }
    }

    // ── Markup ────────────────────────────────────────────────────────────────────────────────
    await prod('T611-MK', 'Markup 6.11', { markup: 1 });
    await c.query(`INSERT INTO kepler_ods.kdpv_prod_util (sucursal,c1,c2,c3,c4,c5,c6,c7) VALUES ('03','T611-MK','PZA',1,1,0,10,10),('03','T611-MK','CJA',2,2,0,20,10)`);
    const mk1 = await sensor(A.ARBITRO_MARKUP_SQL);
    ok(mk1.n === (base.markup.n ?? 0) + 1, 'markup: un producto desfasado suma 1 al sensor', mk1.nota);
    await D.normalizeMarkup(db, M, ['T611-MK']);
    const mk2 = await sensor(A.ARBITRO_MARKUP_SQL);
    ok(mk2.n === (base.markup.n ?? 0), 'markup: corrido normalizeMarkup, el sensor vuelve a la base (las dos reglas coinciden)', mk2.nota);

    // ── Promo ─────────────────────────────────────────────────────────────────────────────────
    await prod('T611-PR', 'Promo 6.11');
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c90) VALUES ('01','T611-PR','Promo 6.11','T611',0.01)`);
    const pr1 = await sensor(A.ARBITRO_PROMO_SQL);
    ok(pr1.n === (base.promo.n ?? 0) + 1, 'promo: una clave de $0.01 sin marca suma 1 al sensor', pr1.nota);
    await D.normalizePromo(db, M, ['T611-PR']);
    const pr2 = await sensor(A.ARBITRO_PROMO_SQL);
    ok(pr2.n === (base.promo.n ?? 0), 'promo: corrido normalizePromo, el sensor vuelve a la base', pr2.nota);

    // ── Nombres ───────────────────────────────────────────────────────────────────────────────
    await prod('T611-NM', 'NOMBRE VIEJO 6.11');
    await prod('T611-H', 'H VIEJO 6.11');                                   // el CEDIS conserva el viejo
    await prod('T611-B1', 'INHABILITADO 6.11'); await prod('T611-B2', 'B2 6.11'); // B2 lo frena la unique
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c3, c90) VALUES
      ('01','T611-NM','NOMBRE NUEVO 6.11','T611',10),
      ('00','T611-H','H VIEJO 6.11','T611',10), ('01','T611-H','H NUEVO 6.11','T611',10),
      ('01','T611-B1','INHABILITADO 6.11','T611',10), ('01','T611-B2','INHABILITADO 6.11','T611',10)`);
    const nm1 = await sensor(A.ARBITRO_NOMBRES_SQL);
    ok(nm1.n === (base.nombres.n ?? 0) + 2, 'nombres: cuenta el renombre y el caso CEDIS-contra-tiendas, y NO el que frena la unique', nm1.nota);
    await H.normalizeProductsFromOds(db, M, ['T611-NM', 'T611-H', 'T611-B1', 'T611-B2']);
    const nm2 = await sensor(A.ARBITRO_NOMBRES_SQL);
    ok(nm2.n === (base.nombres.n ?? 0), 'nombres: corrido normalizeProductsFromOds, el sensor vuelve a la base', nm2.nota);
    ok((await q(`SELECT nombre FROM catalog.products WHERE tenant_id=$1 AND sku='T611-B2'`, [M]))[0].nombre === 'B2 6.11',
      'el que frena la unique sigue distinto en el catálogo (y el sensor no lo cuenta)');

    // ── Veredicto ─────────────────────────────────────────────────────────────────────────────
    if (base.markup.n === 0) {
      await c.query(`UPDATE catalog.products SET markup_pct = 99 WHERE tenant_id=$1 AND sku='T611-MK'`, [M]);
      const w = await sensor(A.ARBITRO_MARKUP_SQL);
      ok(cubeta(w.h) === 'warn', 'veredicto: 1 difiere → warn (30 h)', `${w.h.toFixed(1)} h`);
      await c.query(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, markup_pct)
        SELECT $1, $2, 'T611-X' || g, 'Masivo 6.11 ' || g, 1 FROM generate_series(1, 51) g`, [M, B]);
      await c.query(`INSERT INTO kepler_ods.kdpv_prod_util (sucursal,c1,c2,c3,c4,c5,c6,c7)
        SELECT '03', 'T611-X' || g, 'PZA', 1, 1, 0, 30, 10 FROM generate_series(1, 51) g`);
      const k = await sensor(A.ARBITRO_MARKUP_SQL);
      ok(k.n === 52 && cubeta(k.h) === 'critical', 'veredicto: más de 50 → critical (¿corre el hop-2?)', `${k.n} · ${k.h.toFixed(0)} h`);
    } else noMedido('veredicto warn/critical: la base ya trae diferencias de markup propias');
    const ok0 = await sensor(A.ARBITRO_PROMO_SQL);
    if (ok0.n === 0) ok(cubeta(ok0.h) === 'ok', 'veredicto: 0 difieren → ok');

    // ── Fecha de retiro: 30 días sin el nocturno y sin una alerta ─────────────────────────────
    const nombres = async () => sensor(A.ARBITRO_NOMBRES_SQL);
    const r0 = await nombres();
    if (r0.n === 0) {
      ok(cubeta(r0.h) === 'ok' && /se retira con 30 días sin repoint-catalog-names\.js/.test(r0.nota),
        'retiro: con el nocturno corriendo, ok y la nota dice cuándo se retira', r0.nota);
      await c.query(`UPDATE analytics.cron_run_log SET finished_at = now() - interval '31 days'
                      WHERE job_key = 'feed_nightly/repoint-catalog-names.js'`);
      await c.query(`DELETE FROM analytics.db_health_alerts WHERE source_key = 'catalogo_nombres_evento'`);
      const r1 = await nombres();
      ok(cubeta(r1.h) === 'warn' && /^CUMPLIÓ/.test(r1.nota), 'retiro: 30 días sin el nocturno y sin alertas → warn «CUMPLIÓ … retirar este sensor»', r1.nota);
      await c.query(`INSERT INTO analytics.db_health_alerts (tenant_id, source_key, status, last_seen_at)
                      VALUES ($1, 'catalogo_nombres_evento', 'warn', now() - interval '10 days')`, [M]);
      const r2 = await nombres();
      ok(cubeta(r2.h) === 'ok' && !/CUMPLIÓ/.test(r2.nota), 'NEGATIVA retiro: con una alerta en los últimos 30 días NO se retira', r2.nota);
    } else noMedido('retiro: la base ya trae diferencias de nombres propias');
    await c.query(`UPDATE catalog.products SET deleted_at = now() WHERE tenant_id=$1 AND deleted_at IS NULL`, [M]);
    for (const [k, sql] of [['markup', A.ARBITRO_MARKUP_SQL], ['promo', A.ARBITRO_PROMO_SQL], ['nombres', A.ARBITRO_NOMBRES_SQL]]) {
      const s = await sensor(sql);
      ok(s.n === null && cubeta(s.h) === 'critical', `NEGATIVA ${k}: sin productos a la vista dice NO MEDIDO en rojo, no 0 en verde`, s.nota);
    }
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
