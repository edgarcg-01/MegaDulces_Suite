#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.13]` `inventory.products_active` pasa de tabla rellenada a las 05:20 (TRUNCATE+INSERT) a VISTA sobre
 * `catalog.products` + `inventory.products`. Contra una base real, en una transacción que se revierte, ejerciendo
 * el `up()` y el `down()` REALES de la migración 20261112135015:
 *
 *   · la tabla queda renombrada (congelada, con sus filas, sin permisos para la app) y el nombre es una vista;
 *   · la vista trae lo mismo que copiaba el script: activos con SKU del tenant, nombre/código/unidades del
 *     catálogo con respaldo de inventario, subfamilia/categoría/imagen de inventario; NO los inactivos, borrados,
 *     sin SKU ni de otro tenant;
 *   · ⭐ la razón del cambio: un renombre o un alta en el catálogo se ve AL MOMENTO (antes, a la mañana siguiente);
 *   · `app_runtime` SIN tenant la lee completa (el corpus del matcher lee así). CONTROL: la misma sesión no ve
 *     `catalog.products` directo (RLS forzada) — si lo viera, la prueba no probaría nada;
 *   · idempotente; PRUEBA NEGATIVA del piso: con el catálogo vacío la migración ABORTA;
 *   · `down()` devuelve la tabla con sus filas y sus permisos.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-products-active-vista', { url: URL });
const { Client } = require('pg');
const MIG = require(path.join(__dirname, '../migrations-newdb', '20261112135015_canon613_products_active_vista.js'));

const M = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000061ff';
const CONGELADA = 'inventory.products_active_congelada_20261112';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

(async () => {
  console.log('\n[CANON.6.13] products_active como vista\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const knex = { raw: (sql, b) => c.query(sql, b) };
  const callado = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
  const relkind = async (r) => ((await q(`SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass($1)`, [r]))[0] || {}).relkind || null;
  const fila = async (sku) => (await q(`SELECT * FROM inventory.products_active WHERE sku = $1`, [sku]))[0];

  await c.query('BEGIN');
  try {
    // ── Escenario (lo que ya exista en la base se usa tal cual) ─────────────────────────────────
    for (const s of ['catalog', 'inventory']) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`DO $$ BEGIN IF to_regprocedure('public.current_tenant_id()') IS NULL AND to_regprocedure('current_tenant_id()') IS NULL THEN
      EXECUTE 'CREATE FUNCTION public.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting(''app.tenant_id'', true), '''')::uuid $f$';
      END IF; END $$`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      brand_id uuid NOT NULL, sku varchar, articulo varchar, nombre varchar NOT NULL, barcode varchar, description text,
      unit_purchase varchar, unit_sale varchar, activo boolean NOT NULL DEFAULT true, source varchar,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz,
      UNIQUE (tenant_id, brand_id, nombre))`);
    await c.query(`CREATE TABLE IF NOT EXISTS inventory.products (sku varchar PRIMARY KEY, codigo_barras varchar, subfamilia varchar,
      nombre varchar, descripcion varchar, unidad_compra varchar, unidad_venta varchar, categoria varchar,
      synced_at timestamptz NOT NULL DEFAULT now(), image_url text, image_source varchar, image_storage_key varchar, image_updated_at timestamptz)`);
    // Si la base ya trae la migración aplicada, se baja primero: la prueba arranca de la TABLA.
    if (await relkind('inventory.products_active') === 'v') await callado(() => MIG.down(knex));
    await c.query(`CREATE TABLE IF NOT EXISTS inventory.products_active (sku varchar NOT NULL PRIMARY KEY, codigo_barras varchar,
      subfamilia varchar, nombre varchar, descripcion varchar, unidad_compra varchar, unidad_venta varchar, categoria varchar,
      synced_at timestamptz NOT NULL DEFAULT now(), image_url text, image_source varchar, image_storage_key varchar, image_updated_at timestamptz)`);
    // RLS de catalog.products como en prod (forzada, por tenant), si la base no la trae.
    const [{ rls }] = await q(`SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'catalog.products'::regclass`);
    if (!rls) {
      await c.query(`ALTER TABLE catalog.products ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE catalog.products FORCE ROW LEVEL SECURITY`);
      await c.query(`CREATE POLICY t613_tenant ON catalog.products USING (tenant_id = current_tenant_id())`);
    }
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    const marca = async (t, n) => (await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1,$2,$3) RETURNING id`, [t, n, n]))[0].id;
    const B = await marca(M, 'T613M');
    const prod = (t, b, sku, nombre, extra = {}) => c.query(
      `INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, barcode, unit_sale, activo, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [t, b, sku, nombre, extra.barcode ?? null, extra.unit_sale ?? null, extra.activo ?? true, extra.borrado ? new Date() : null]);
    await prod(M, B, 'T613-A1', 'ALFA T613', { barcode: '7501000000011', unit_sale: 'PZA' });
    await prod(M, B, 'T613-A2', 'INACTIVO T613', { activo: false });
    await prod(M, B, 'T613-A3', 'BORRADO T613', { borrado: true });
    await prod(M, B, '', 'SIN SKU T613');
    await prod(M, B, 'T613-A6', '   ');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
    await prod(OTRO, await marca(OTRO, 'T613O'), 'T613-A5', 'OTRO TENANT T613');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    // En una base con `[CANON.6.15]` aplicada (el CI corre migrate:latest), `inventory.products` es una vista y lo que
    // no se deriva (subfamilia, categoría, imagen) vive en `inventory.products_legado_fdw`: ahí se siembra.
    const INV = (await relkind('inventory.products')) === 'v' ? 'inventory.products_legado_fdw' : 'inventory.products';
    await c.query(`INSERT INTO ${INV} (sku, subfamilia, categoria, image_url, image_source, nombre) VALUES
      ('T613-A1','SF T613','CAT T613','http://img/t613','cloudinary','NOMBRE VIEJO INV'), ('T613-A6', NULL, NULL, NULL, NULL, 'DESDE INVENTARIO T613')`);
    await c.query(`INSERT INTO inventory.products_active (sku, nombre) VALUES ('T613-A1','ALFA VIEJO T613'), ('T613-OLD','YA NO ACTIVO T613')`);
    const filasTabla = Number((await q(`SELECT count(*)::int n FROM inventory.products_active`))[0].n);
    // El rol de la app ANTES de migrar, con los permisos que tiene en prod sobre la tabla (arwd): así el GRANT y
    // el REVOKE de la migración se ejercen de verdad. Se revierte con la transacción.
    let hayRol = false;
    try {
      await c.query('SAVEPOINT rol');
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`);
      await c.query(`GRANT USAGE ON SCHEMA catalog, inventory TO app_runtime`);
      await c.query(`GRANT SELECT ON catalog.products, inventory.products TO app_runtime`);
      await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.products_active TO app_runtime`);
      await c.query('RELEASE SAVEPOINT rol');
      hayRol = true;
    } catch (e) { await c.query('ROLLBACK TO SAVEPOINT rol'); noMedido(`no se pudo preparar el rol app_runtime (${String(e.message).slice(0, 60)})`); }

    // ── up() real ─────────────────────────────────────────────────────────────────────────────
    await callado(() => MIG.up(knex));
    ok(await relkind('inventory.products_active') === 'v' && await relkind(CONGELADA) === 'r', 'la migración deja una VISTA con el nombre y la tabla renombrada');
    ok(Number((await q(`SELECT count(*)::int n FROM ${CONGELADA}`))[0].n) === filasTabla, 'la tabla congelada conserva sus filas (no se borra nada)');
    const a1 = await fila('T613-A1');
    ok(a1 && a1.nombre === 'ALFA T613' && a1.codigo_barras === '7501000000011' && a1.unidad_venta === 'PZA'
      && a1.subfamilia === 'SF T613' && a1.categoria === 'CAT T613' && a1.image_url === 'http://img/t613',
      'trae lo del catálogo (nombre, código, unidad) y de inventario (subfamilia, categoría, imagen)', JSON.stringify(a1));
    ok((await fila('T613-A6') || {}).nombre === 'DESDE INVENTARIO T613', 'nombre vacío en el catálogo: respaldo de inventario, como el script');
    const fuera = [];
    for (const s of ['T613-A2', 'T613-A3', 'T613-A5', 'T613-OLD', '']) if (await fila(s)) fuera.push(s || '(vacío)');
    ok(!fuera.length, 'no trae inactivos, borrados, de otro tenant ni lo que la tabla tenía de más', fuera.join(','));

    // ── La razón del cambio: al momento ───────────────────────────────────────────────────────
    await c.query(`UPDATE catalog.products SET nombre='ALFA RENOMBRADO T613' WHERE tenant_id=$1 AND sku='T613-A1'`, [M]);
    await prod(M, B, 'T613-A7', 'ALTA DE HOY T613');
    ok((await fila('T613-A1') || {}).nombre === 'ALFA RENOMBRADO T613' && !!(await fila('T613-A7')),
      'un renombre y un alta del catálogo se ven AL MOMENTO (antes: a la mañana siguiente)');

    // ── app_runtime sin tenant ────────────────────────────────────────────────────────────────
    const [{ su }] = await q(`SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`);
    if (!su) noMedido('app_runtime: el usuario de la prueba no es superusuario (en prod la vista es de postgres)');
    else if (!hayRol) noMedido('app_runtime: no hay rol');
    else {
      await c.query(`SELECT set_config('app.tenant_id', '', true)`);
      await c.query(`SET LOCAL ROLE app_runtime`);
      const directo = Number((await q(`SELECT count(*)::int n FROM catalog.products WHERE sku LIKE 'T613-%'`))[0].n);
      const vista = Number((await q(`SELECT count(*)::int n FROM inventory.products_active WHERE sku LIKE 'T613-%'`))[0].n);
      await c.query(`RESET ROLE`);
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
      ok(directo === 0, 'CONTROL: app_runtime sin tenant NO ve catalog.products directo (RLS forzada)', `vio ${directo}`);
      ok(vista === 3, 'app_runtime sin tenant SÍ lee la vista completa (A1, A6, A7), como leía la tabla', `vio ${vista}`);
    }
    const priv = await q(`SELECT has_table_privilege('app_runtime', 'inventory.products_active', 'SELECT') AS lee,
                                 has_table_privilege('app_runtime', '${CONGELADA}', 'SELECT') AS lee_congelada
                            WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime')`);
    if (!priv.length) noMedido('permisos: no existe el rol app_runtime');
    else ok(priv[0].lee && !priv[0].lee_congelada, 'app_runtime lee la vista y ya no tiene acceso a la congelada', JSON.stringify(priv[0]));

    // ── Idempotente ───────────────────────────────────────────────────────────────────────────
    let tiro = null;
    try { await callado(() => MIG.up(knex)); } catch (e) { tiro = e.message; }
    ok(!tiro && await relkind('inventory.products_active') === 'v', 'segunda vez: no hace nada', tiro);

    // ── NEGATIVA: el piso ─────────────────────────────────────────────────────────────────────
    await c.query('SAVEPOINT piso');
    await callado(() => MIG.down(knex));
    await c.query(`INSERT INTO inventory.products_active (sku, nombre) SELECT 'T613-P' || g, 'P' || g FROM generate_series(1, 20) g`);
    await c.query(`UPDATE catalog.products SET activo = false WHERE tenant_id = $1`, [M]);
    let piso = null;
    try { await callado(() => MIG.up(knex)); } catch (e) { piso = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT piso');
    ok(/PISO/.test(piso || ''), 'NEGATIVA: con el catálogo vacío la migración ABORTA (piso anti-vaciado)', piso || 'no lanzó');

    // ── down() ────────────────────────────────────────────────────────────────────────────────
    await callado(() => MIG.down(knex));
    const ins = (await q(`SELECT has_table_privilege('app_runtime', 'inventory.products_active', 'INSERT') AS i
                           WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime')`))[0];
    ok(await relkind('inventory.products_active') === 'r' && !(await relkind(CONGELADA))
      && Number((await q(`SELECT count(*)::int n FROM inventory.products_active`))[0].n) === filasTabla
      && (!ins || ins.i), 'down(): vuelve la tabla con sus filas y sus permisos');
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
