#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.18]` Unidades, choferes y rutas de Kepler (`kdm_transporte` / `kdm_chofer` / `kdm_rutas`) entran a
 * `logistics.*` AL LLEGAR (hop-2: `normalizeVehiclesFromOds` / `normalizeDriversFromOds` / `normalizeRoutesFromOds`),
 * sin el nocturno `import-logistics-dims.js`. Contra una base real, dentro de una transacción que se revierte, por el
 * camino real (`applyRawUpsert`):
 *
 *   J. NEGATIVA: con la normalización apagada, una unidad nueva de Kepler NO entra.
 *   A. Unidad nueva: entra con su clave larga (la llave llega como `00917`, el resolvedor cruza sin ceros) y la nota.
 *   B. Unidad cuya placa ya dio de alta el GPS sin guiones: la ADOPTA (le pone la clave) y no le pisa la placa.
 *   C. Placa ocupada por una unidad borrada en la app: no la da de alta (D3) y no tumba el lote.
 *   D. Chofer: adopta por nombre (mayúsculas y espacios en los bordes); uno nuevo entra; uno con su clave BORRADA en la app no vuelve
 *      a nacer (D3 por clave, nuevo en CANON.6.18). NEGATIVA: sin esa guarda, sí renacería.
 *   E. Rutas: un nombre nuevo entra; uno borrado en la app no; uno vivo con otra capitalización no se duplica; el lote
 *      sólo mira los nombres de las claves que llegaron (acotado).
 *   I. Sin churn: la segunda pasada escribe 0.
 *   K. El árbitro (`ARBITRO_LOGISTICA_SQL`, el MISMO .ts de db-health): una unidad, un chofer y una ruta sin tomar
 *      suman 3; lo respetado (borrado en la app, placa ocupada) no cuenta; corridos los normalizadores, vuelve a la base.
 *
 * Sin base: NO MEDIDO, nunca ✔. Sin ts-node: K queda NO MEDIDO.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-logistica-por-evento', { url: URL });
const { Client } = require('pg');
const { dentroDeLaPrueba } = require('./_lib/transaccion-de-prueba');
const { applyRawUpsert } = require('../../services/feeds-ingest/apply-handlers');
const { normalizeVehiclesFromOds, normalizeDriversFromOds, normalizeRoutesFromOds } = require('../../services/feeds-ingest/logistics-dims');
const RAIZ = path.resolve(__dirname, '..', '..');

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const meta = (table, cols) => ({ table, pk: ['c1'], columns: ['sucursal', ...cols].map((name) => ({ name, type: 'text' })) });
const KDT = meta('kdm_transporte', ['c1', 'c2', 'c3', 'c4']);
const KDC = meta('kdm_chofer', ['c1', 'c2']);
const KDR = meta('kdm_rutas', ['c1', 'c2']);
const unidad = (sucursal, c1, c2, c3) => ({ sucursal, c1, c2, c3, c4: null });
const chofer = (sucursal, c1, c2) => ({ sucursal, c1, c2 });
const ruta = (sucursal, c1, c2) => ({ sucursal, c1, c2 });

// Los resolvedores de la mig 20260917120000, para una base vacía (si la base ya los tiene, se usan los suyos).
const key = (col) => `NULLIF(ltrim(btrim(${col}::text),'0'),'')`;
const txt = (col) => `NULLIF(btrim(${col}::text),'')`;
const resolvedor = (vista, tabla, cols) => `CREATE VIEW analytics.${vista} AS
  WITH agg AS (SELECT btrim(t.sucursal) AS sucursal, ${key('t.c1')} AS clave, count(*)::int AS variantes,
                      count(DISTINCT upper(btrim(coalesce(t.c2,''))))::int AS nombres
                 FROM kepler_ods.${tabla} t WHERE ${key('t.c1')} IS NOT NULL GROUP BY 1,2),
  elegida AS (SELECT DISTINCT ON (btrim(t.sucursal), ${key('t.c1')}) btrim(t.sucursal) AS sucursal, ${key('t.c1')} AS clave,
                     btrim(t.c1) AS clave_kepler, ${cols}
                FROM kepler_ods.${tabla} t WHERE ${key('t.c1')} IS NOT NULL
               ORDER BY btrim(t.sucursal), ${key('t.c1')}, length(btrim(t.c1)) DESC, btrim(t.c1))
  SELECT e.*, a.variantes, (a.nombres > 1) AS ambiguo FROM elegida e JOIN agg a ON a.sucursal = e.sucursal AND a.clave = e.clave`;

(async () => {
  console.log('\n[CANON.6.18] logística por evento (kdm_transporte / kdm_chofer / kdm_rutas)\n');
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
  const veh = (where, p) => q(`SELECT plate, kepler_code, notes, deleted_at IS NOT NULL AS borrada FROM logistics.vehicles WHERE tenant_id=$1 AND ${where} ORDER BY plate`, [M, ...p]);
  const drv = (where, p) => q(`SELECT full_name, kepler_code, deleted_at IS NOT NULL AS borrada FROM logistics.drivers WHERE tenant_id=$1 AND ${where} ORDER BY full_name`, [M, ...p]);
  const rts = (where, p) => q(`SELECT name, deleted_at IS NOT NULL AS borrada FROM logistics.routes WHERE tenant_id=$1 AND ${where} ORDER BY name`, [M, ...p]);
  const arbitro = async () => {
    const nota = String((await q(A.ARBITRO_LOGISTICA_SQL))[0].note_extra || '');
    const m = /^(\d+) sin tomar/.exec(nota);
    return { n: /^NO MEDIDO/.test(nota) ? null : /: 0 difieren de/.test(nota) || /^CUMPLIÓ/.test(nota) ? 0 : m ? Number(m[1]) : undefined, nota };
  };

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['kepler_ods', 'analytics', 'logistics']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdm_transporte (sucursal text NOT NULL, c1 text NOT NULL, c2 text, c3 text, c4 text, PRIMARY KEY (sucursal, c1))`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdm_chofer (sucursal text NOT NULL, c1 text NOT NULL, c2 text, PRIMARY KEY (sucursal, c1))`);
    await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdm_rutas (sucursal text NOT NULL, c1 text NOT NULL, c2 text, PRIMARY KEY (sucursal, c1))`);
    if (!(await q(`SELECT to_regclass('analytics.v_kepler_transporte') t`))[0].t) {
      await c.query(resolvedor('v_kepler_transporte', 'kdm_transporte', `${txt('t.c2')} AS descripcion, ${txt('t.c3')} AS placas, ${key('t.c4')} AS chofer_asignado`));
    }
    if (!(await q(`SELECT to_regclass('analytics.v_kepler_chofer') t`))[0].t) {
      await c.query(resolvedor('v_kepler_chofer', 'kdm_chofer', `${txt('t.c2')} AS nombre`));
    }
    // Las columnas que escribe la regla, con los CHECK, defaults e índices únicos de prod (medidos el 13-nov).
    await c.query(`CREATE TABLE IF NOT EXISTS logistics.vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      plate varchar NOT NULL, model varchar, brand varchar, status varchar NOT NULL DEFAULT 'disponible'
        CHECK (status IN ('disponible','en_ruta','mantenimiento','baja')),
      notes text, active boolean NOT NULL DEFAULT true, kepler_code varchar, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS logistics_vehicles_tenant_plate_unique ON logistics.vehicles (tenant_id, plate)`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_logistics_vehicles_kepler_code ON logistics.vehicles (tenant_id, kepler_code)
      WHERE kepler_code IS NOT NULL AND deleted_at IS NULL`);
    await c.query(`CREATE TABLE IF NOT EXISTS logistics.drivers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      full_name varchar NOT NULL, roles text[] NOT NULL, employee_type varchar NOT NULL DEFAULT 'interno' CHECK (employee_type IN ('interno','externo')),
      status varchar NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','inactivo','suspendido')), active boolean NOT NULL DEFAULT true,
      notes text, kepler_code varchar, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS logistics.routes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      name varchar NOT NULL, active boolean NOT NULL DEFAULT true, notes text, kepler_code varchar,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS logistics_routes_tenant_name_unique ON logistics.routes (tenant_id, name)`);
    // Las bitácoras que lee la condición de retiro del árbitro (en una base migrada ya existen).
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.cron_run_log (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, job_key text NOT NULL,
      status text NOT NULL, finished_at timestamptz, logged_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS analytics.db_health_alerts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      source_key varchar NOT NULL, status varchar NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz)`);
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    // Una ruta neutra para que el árbitro vea logística (con 0 filas a la vista dice NO MEDIDO, nunca 0), y la base.
    await c.query(`INSERT INTO logistics.routes (tenant_id, name) VALUES ($1, 'BASE T618')`, [M]);
    const base = A ? await arbitro() : null;
    // Lo que ya está en la app: la unidad que dio de alta el GPS (placa sin guiones), una unidad borrada, el chofer que
    // capturó una persona (sin clave), uno que Kepler trajo y se borró en la app, y dos rutas.
    await c.query(`INSERT INTO logistics.vehicles (tenant_id, plate, notes) VALUES ($1, 'GA2027T618', 'alta del GPS')`, [M]);
    await c.query(`INSERT INTO logistics.vehicles (tenant_id, plate, deleted_at) VALUES ($1, 'BORRADA-T618', now())`, [M]);
    await c.query(`INSERT INTO logistics.drivers (tenant_id, full_name, roles) VALUES ($1, ' juan perez t618 ', ARRAY['chofer'])`, [M]);
    await c.query(`INSERT INTO logistics.drivers (tenant_id, full_name, roles, kepler_code, deleted_at) VALUES ($1, 'BAJA T618', ARRAY['chofer'], '00977', now())`, [M]);
    await c.query(`INSERT INTO logistics.routes (tenant_id, name, deleted_at) VALUES ($1, 'BORRADA T618', now())`, [M]);
    await c.query(`INSERT INTO logistics.routes (tenant_id, name) VALUES ($1, 'Viva T618')`, [M]);

    // ── J (negativa) ──────────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [unidad('01', '00917', 'TORTON T618', 'NUEVA-T618')], { ...KDT, normalize: false }));
    ok(!(await veh(`plate = $2`, ['NUEVA-T618'])).length, 'NEGATIVA: con la normalización apagada la unidad nueva de Kepler NO entra');

    // ── A. Unidad nueva ──────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [unidad('02', '00917', 'TORTON T618', 'NUEVA-T618')], KDT));
    const a = await veh(`plate = $2`, ['NUEVA-T618']);
    ok(a.length === 1 && a[0].kepler_code === '00917' && /Alta desde Kepler \(unidad 00917\)/.test(a[0].notes),
      'unidad nueva: entra con su clave larga y la nota de alta', JSON.stringify(a));

    // ── B. Adopta la del GPS ─────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [unidad('01', '918', 'RABON T618', 'GA-2027-T618')], KDT));
    const b = await veh(`plate IN ('GA2027T618', 'GA-2027-T618')`, []);
    ok(b.length === 1 && b[0].plate === 'GA2027T618' && b[0].kepler_code === '918',
      'placa ya dada de alta por el GPS (sin guiones): la adopta, le pone la clave y NO le pisa la placa', JSON.stringify(b));

    // ── C. Placa de una unidad borrada ───────────────────────────────────────────────────────
    // El normalizador se llama directo: por `applyRawUpsert` una falla se reintentaría por partes y la otra unidad del
    // lote entraría igual, así que la prueba no vería que el lote entero reventó.
    await callado(() => applyRawUpsert(db, M, [unidad('01', '00919', 'VAN T618', 'BORRADA-T618'), unidad('01', '00920', 'VAN2 T618', 'OTRA-T618')], { ...KDT, normalize: false }));
    let tiro = null; let nC = null;
    try { nC = await normalizeVehiclesFromOds(db, M, ['00919', '00920']); } catch (e) { tiro = e.message; }
    const cc = await veh(`plate IN ('BORRADA-T618', 'OTRA-T618')`, []);
    ok(!tiro && nC === 1 && cc.length === 2 && cc.find((v) => v.plate === 'BORRADA-T618').borrada && !cc.find((v) => v.plate === 'BORRADA-T618').kepler_code
      && cc.find((v) => v.plate === 'OTRA-T618').kepler_code === '00920',
      'placa de una unidad borrada en la app: no la da de alta ni la revive, y la otra del lote sí entra', tiro || `n=${nC} · ${JSON.stringify(cc)}`);

    // ── D. Choferes ──────────────────────────────────────────────────────────────────────────
    await callado(() => applyRawUpsert(db, M, [chofer('01', '00976', 'JUAN PEREZ T618'), chofer('01', '00978', 'NUEVO T618'),
      chofer('01', '00977', 'BAJA T618')], KDC));
    const d1 = await drv(`full_name ILIKE '%juan%t618%'`, []);
    ok(d1.length === 1 && d1[0].kepler_code === '00976', 'chofer capturado a mano (minúsculas y espacios en los bordes): lo adopta', JSON.stringify(d1));
    const d2 = await drv(`full_name = $2`, ['NUEVO T618']);
    ok(d2.length === 1 && d2[0].kepler_code === '00978', 'chofer nuevo: entra con su clave', JSON.stringify(d2));
    const d3 = await drv(`full_name = $2`, ['BAJA T618']);
    ok(d3.length === 1 && d3[0].borrada, 'chofer con su clave borrada en la app: NO vuelve a nacer (D3 por clave)', JSON.stringify(d3));

    // ── E. Rutas ─────────────────────────────────────────────────────────────────────────────
    await c.query(`INSERT INTO kepler_ods.kdm_rutas (sucursal, c1, c2) VALUES ('03', 'R99T', 'OTRA CLAVE T618')`);
    await callado(() => applyRawUpsert(db, M, [ruta('01', 'R1T', ' nueva  t618 '), ruta('02', 'R1T', 'NUEVA  T618'), ruta('01', 'R2T', 'BORRADA T618'),
      ruta('01', 'R3T', 'VIVA T618')], KDR));
    ok((await rts(`name = $2`, ['NUEVA  T618'])).length === 1, 'ruta nueva: entra con el nombre en mayúsculas, una sola vez aunque venga de dos sucursales',
      JSON.stringify(await rts(`name ILIKE '%nueva%t618%'`, [])));
    ok((await rts(`name = $2`, ['BORRADA T618'])).every((r) => r.borrada) && (await rts(`name = $2`, ['BORRADA T618'])).length === 1,
      'ruta borrada en la app: no se revive ni se duplica');
    ok((await rts(`upper(name) = $2`, ['VIVA T618'])).length === 1, 'ruta viva con otra capitalización: no se duplica');
    ok(!(await rts(`name = $2`, ['OTRA CLAVE T618'])).length, 'acotado: el lote sólo mira los nombres de las claves que llegaron');

    // ── I. Sin churn ─────────────────────────────────────────────────────────────────────────
    const n0 = (await normalizeVehiclesFromOds(db, M, ['00917', '918', '00919', '00920']))
      + (await normalizeDriversFromOds(db, M, ['00976', '00977', '00978'])) + (await normalizeRoutesFromOds(db, M, ['R1T', 'R2T', 'R3T']));
    ok(n0 === 0, 'segunda pasada sin cambios en Kepler: 0', `n=${n0}`);

    // ── K. El árbitro ────────────────────────────────────────────────────────────────────────
    if (!A) noMedido('árbitro: sin ts-node no se carga el .ts de db-health');
    else if (base.n == null) noMedido(`árbitro: la base no se pudo medir (${base.nota})`);
    else {
      // R99T sigue pendiente a propósito (la ruta que el lote acotado no miró).
      const k0 = await arbitro();
      ok(k0.n === base.n + 1, 'árbitro: lo respetado (unidad, chofer y ruta borrados en la app) no cuenta; la ruta que el lote no miró, sí', `${base.n} → ${k0.nota}`);
      await c.query(`INSERT INTO kepler_ods.kdm_transporte (sucursal, c1, c2, c3) VALUES ('01', '00921', 'SIN EVENTO T618', 'SINEV-T618')`);
      await c.query(`INSERT INTO kepler_ods.kdm_chofer (sucursal, c1, c2) VALUES ('01', '00979', 'SIN EVENTO T618')`);
      const k1 = await arbitro();
      ok(k1.n === base.n + 3, 'árbitro: una unidad, un chofer y una ruta sin tomar suman 3', k1.nota);
      const nk = (await normalizeVehiclesFromOds(db, M, null)) + (await normalizeDriversFromOds(db, M, null)) + (await normalizeRoutesFromOds(db, M, null));
      const k2 = await arbitro();
      ok(nk === 3 && k2.n === base.n, 'árbitro: corridos los normalizadores sobre todo el catálogo, vuelve a la base (las dos reglas coinciden)', `n=${nk} · ${k2.nota}`);
    }
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
