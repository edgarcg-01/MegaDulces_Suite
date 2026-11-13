#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.15]` `inventory.products` pasa de tabla (foto de junio del FDW + altas del cron de las 05:10) a VISTA sobre
 * `catalog.products`, con lo que el catálogo no tiene tomado de la foto congelada (`inventory.products_legado_fdw`).
 * Contra una base real, en una transacción que se revierte, ejerciendo el `up()` y el `down()` REALES de la
 * migración 20261112152928 (y la de `products_active`, 20261112135015, en el orden en que se aplican):
 *
 *   · la tabla queda renombrada (con sus filas, sin permisos para la app) y el nombre es una vista;
 *   · universo = productos VIVOS del catálogo con SKU, activos o no; fuera borrados, fantasmas y otro tenant;
 *   · nombre, código y unidades del catálogo (al momento); subfamilia, categoría, factores, costo anual e imagen de
 *     la foto; si el catálogo trae el nombre vacío, el de la foto;
 *   · ⭐ un alta del catálogo se puede ESCANEAR al momento (la búsqueda del conteo: código o sku);
 *   · `products_active` (vista de 6.13) sigue trayendo subfamilia e imagen: sigue a la tabla renombrada;
 *   · `app_runtime` SIN tenant la lee completa (CONTROL: no ve `catalog.products` directo);
 *   · idempotente; PRUEBA NEGATIVA del piso; `down()` devuelve la tabla con sus filas y permisos.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-inventory-products-vista', { url: URL });
const { Client } = require('pg');
const MIG = require(path.join(__dirname, '../migrations-newdb', '20261112152928_canon615_inventory_products_vista.js'));
const MIG13 = require(path.join(__dirname, '../migrations-newdb', '20261112135015_canon613_products_active_vista.js'));

const M = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000061ff';
const LEGADO = 'inventory.products_legado_fdw';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra ? `— ${extra}` : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

(async () => {
  console.log('\n[CANON.6.15] inventory.products como vista\n');
  if (!URL) { noMedido('falta DATABASE_URL_NEW'); return salir(); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) { noMedido(`sin base (${String(e.message).slice(0, 80)})`); return salir(); }
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const knex = { raw: (sql, b) => c.query(sql, b) };
  const callado = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
  const relkind = async (r) => ((await q(`SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass($1)`, [r]))[0] || {}).relkind || null;
  const fila = async (sku) => (await q(`SELECT * FROM inventory.products WHERE sku = $1`, [sku]))[0];

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
    // Si la base ya trae las migraciones, se bajan: la prueba arranca de las TABLAS (orden inverso al de aplicar).
    if (await relkind('inventory.products') === 'v') await callado(() => MIG.down(knex));
    if (await relkind('inventory.products_active') === 'v') await callado(() => MIG13.down(knex));
    await c.query(`CREATE TABLE IF NOT EXISTS inventory.products (sku varchar NOT NULL PRIMARY KEY, producto_servicio boolean,
      codigo_barras varchar, subfamilia varchar, nombre varchar, descripcion varchar, unidad_compra varchar, unidad_venta varchar,
      factor_compra bigint, factor_venta bigint, venta_valor_anual numeric, venta_valor_costo_anual numeric, venta_unidad_anual numeric,
      categoria varchar, ieps_compra bigint, iva_compra bigint, ieps_venta bigint, iva_venta bigint, ptos_frecuencia bigint,
      fecha_alta timestamptz, fecha_ultima_modificacion timestamptz, a_1 varchar, a_2 varchar, a_3 varchar,
      synced_at timestamptz NOT NULL DEFAULT now(), synced_from varchar DEFAULT 'erp.catalogo_completo',
      image_url text, image_source varchar, image_storage_key varchar, image_updated_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS inventory.products_active (sku varchar NOT NULL PRIMARY KEY, codigo_barras varchar,
      subfamilia varchar, nombre varchar, descripcion varchar, unidad_compra varchar, unidad_venta varchar, categoria varchar,
      synced_at timestamptz NOT NULL DEFAULT now(), image_url text, image_source varchar, image_storage_key varchar, image_updated_at timestamptz)`);
    const [{ rls }] = await q(`SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'catalog.products'::regclass`);
    if (!rls) {
      await c.query(`ALTER TABLE catalog.products ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE catalog.products FORCE ROW LEVEL SECURITY`);
      await c.query(`CREATE POLICY t615_tenant ON catalog.products USING (tenant_id = current_tenant_id())`);
    }
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    const marca = async (t, n) => (await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1,$2,$3) RETURNING id`, [t, n, n]))[0].id;
    const B = await marca(M, 'T615M');
    const prod = (t, b, sku, nombre, x = {}) => c.query(
      `INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, barcode, unit_sale, activo, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [t, b, sku, nombre, x.barcode ?? null, x.unit_sale ?? null, x.activo ?? true, x.borrado ? new Date() : null]);
    await prod(M, B, 'T615-A1', 'ALFA T615', { barcode: '7501000615011', unit_sale: 'PZA' });
    await prod(M, B, 'T615-A2', 'INACTIVO T615', { activo: false });
    await prod(M, B, 'T615-A3', 'BORRADO T615', { borrado: true });
    await prod(M, B, 'T615-A6', '   ');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
    await prod(OTRO, await marca(OTRO, 'T615O'), 'T615-A5', 'OTRO TENANT T615');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    await c.query(`INSERT INTO inventory.products (sku, codigo_barras, nombre, subfamilia, categoria, factor_venta, venta_valor_costo_anual,
      venta_unidad_anual, image_url, image_source) VALUES
      ('T615-A1','7501000615999','ALFA VIEJO T615','SF T615','CAT T615',12,100,10,'http://img/t615','cloudinary'),
      ('T615-A6', NULL, 'DESDE INVENTARIO T615', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
      ('T615-A3', NULL, 'BORRADO VIEJO T615', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
      ('T615-FANT', '7501000615998', 'FANTASMA DEL FDW T615', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`);
    const filasTabla = Number((await q(`SELECT count(*)::int n FROM inventory.products`))[0].n);
    let hayRol = false;
    try {
      await c.query('SAVEPOINT rol');
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`);
      await c.query(`GRANT USAGE ON SCHEMA catalog, inventory TO app_runtime`);
      await c.query(`GRANT SELECT ON catalog.products TO app_runtime`);
      await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.products, inventory.products_active TO app_runtime`);
      await c.query('RELEASE SAVEPOINT rol');
      hayRol = true;
    } catch (e) { await c.query('ROLLBACK TO SAVEPOINT rol'); noMedido(`no se pudo preparar el rol app_runtime (${String(e.message).slice(0, 60)})`); }
    // El orden real: products_active ya es vista (6.13) cuando llega esta migración.
    await callado(() => MIG13.up(knex));

    // ── up() real ─────────────────────────────────────────────────────────────────────────────
    await callado(() => MIG.up(knex));
    ok(await relkind('inventory.products') === 'v' && await relkind(LEGADO) === 'r', 'la migración deja una VISTA con el nombre y la tabla renombrada');
    ok(Number((await q(`SELECT count(*)::int n FROM ${LEGADO}`))[0].n) === filasTabla, 'la tabla renombrada conserva sus filas (no se borra nada)');
    const a1 = await fila('T615-A1');
    ok(a1 && a1.nombre === 'ALFA T615' && a1.codigo_barras === '7501000615011' && a1.unidad_venta === 'PZA',
      'nombre, código y unidad salen del catálogo, al momento (la foto decía «ALFA VIEJO» y otro código)', JSON.stringify(a1 && { n: a1.nombre, b: a1.codigo_barras }));
    ok(a1 && a1.subfamilia === 'SF T615' && a1.categoria === 'CAT T615' && Number(a1.factor_venta) === 12 && a1.image_url === 'http://img/t615'
      && Number(a1.venta_valor_costo_anual) / Number(a1.venta_unidad_anual) === 10, 'subfamilia, categoría, factor, costo anual e imagen salen de la foto, tal cual');
    ok(!!(await fila('T615-A2')), 'un producto INACTIVO sigue en el catálogo del almacén (se cuenta lo que hay)');
    ok((await fila('T615-A6') || {}).nombre === 'DESDE INVENTARIO T615', 'nombre vacío en el catálogo: el de la foto');
    const fuera = [];
    for (const s of ['T615-A3', 'T615-A5', 'T615-FANT']) if (await fila(s)) fuera.push(s);
    ok(!fuera.length, 'fuera: borrados del catálogo, otro tenant y fantasmas del FDW', fuera.join(','));

    // ── La razón: un alta se escanea al momento ───────────────────────────────────────────────
    await prod(M, B, 'T615-A7', 'ALTA DE HOY T615', { barcode: '7501000615073' });
    const scan = await q(`SELECT DISTINCT sku, nombre FROM inventory.products WHERE codigo_barras = $1 OR sku = $1`, ['7501000615073']);
    ok(scan.length === 1 && scan[0].sku === 'T615-A7', '⭐ un alta del catálogo se escanea AL MOMENTO (antes, a la mañana siguiente)', JSON.stringify(scan));

    // ── products_active (6.13) sigue a la tabla renombrada ────────────────────────────────────
    const pa = (await q(`SELECT nombre, subfamilia, image_url FROM inventory.products_active WHERE sku = 'T615-A1'`))[0] || {};
    ok(pa.nombre === 'ALFA T615' && pa.subfamilia === 'SF T615' && pa.image_url === 'http://img/t615',
      'products_active (vista de 6.13) sigue trayendo subfamilia e imagen: sigue a la tabla renombrada', JSON.stringify(pa));

    // ── app_runtime sin tenant ────────────────────────────────────────────────────────────────
    const [{ su }] = await q(`SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`);
    if (!su || !hayRol) noMedido('app_runtime: el usuario de la prueba no es superusuario o no hay rol (en prod la vista es de postgres)');
    else {
      await c.query(`SELECT set_config('app.tenant_id', '', true)`);
      await c.query(`SET LOCAL ROLE app_runtime`);
      const directo = Number((await q(`SELECT count(*)::int n FROM catalog.products WHERE sku LIKE 'T615-%'`))[0].n);
      const vista = Number((await q(`SELECT count(*)::int n FROM inventory.products WHERE sku LIKE 'T615-%'`))[0].n);
      await c.query(`RESET ROLE`);
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
      ok(directo === 0, 'CONTROL: app_runtime sin tenant NO ve catalog.products directo (RLS forzada)', `vio ${directo}`);
      ok(vista === 4, 'app_runtime sin tenant SÍ lee la vista completa (A1, A2, A6, A7)', `vio ${vista}`);
      const [pr] = await q(`SELECT has_table_privilege('app_runtime', 'inventory.products', 'SELECT') lee, has_table_privilege('app_runtime', '${LEGADO}', 'SELECT') lee_legado`);
      ok(pr.lee && !pr.lee_legado, 'app_runtime lee la vista y ya no tiene acceso a la tabla renombrada', JSON.stringify(pr));
    }

    // ── Idempotente ───────────────────────────────────────────────────────────────────────────
    let tiro = null;
    try { await callado(() => MIG.up(knex)); } catch (e) { tiro = e.message; }
    ok(!tiro && await relkind('inventory.products') === 'v', 'segunda vez: no hace nada', tiro);

    // ── NEGATIVA: el piso ─────────────────────────────────────────────────────────────────────
    await c.query('SAVEPOINT piso');
    await callado(() => MIG.down(knex));
    await c.query(`UPDATE catalog.products SET deleted_at = now() WHERE tenant_id = $1`, [M]);
    let piso = null;
    try { await callado(() => MIG.up(knex)); } catch (e) { piso = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT piso');
    ok(/PISO/.test(piso || ''), 'NEGATIVA: con el catálogo vacío la migración ABORTA (piso anti-vaciado)', piso || 'no lanzó');

    // ── down() ────────────────────────────────────────────────────────────────────────────────
    await callado(() => MIG.down(knex));
    const ins = hayRol ? (await q(`SELECT has_table_privilege('app_runtime', 'inventory.products', 'INSERT') AS i`))[0] : null;
    ok(await relkind('inventory.products') === 'r' && !(await relkind(LEGADO))
      && Number((await q(`SELECT count(*)::int n FROM inventory.products`))[0].n) === filasTabla && (!ins || ins.i)
      && ((await q(`SELECT subfamilia FROM inventory.products_active WHERE sku = 'T615-A1'`))[0] || {}).subfamilia === 'SF T615',
      'down(): vuelve la tabla con sus filas y sus permisos, y products_active sigue leyéndola');
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
  salir();
})();
