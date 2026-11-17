'use strict';
/**
 * `[CANON.6.21]` Andamio y escenario compartidos por las pruebas de la oleada 8b (existencia por llave y por evento).
 * Corre DENTRO de la transacción de la prueba (que la revierte). Lo que ya exista en la base se usa tal cual; lo que
 * falte se monta con los tipos de prod. Las cuatro vistas con regla, si la base no las trae iguales a su plantilla (la
 * base de CI salta las migraciones que asertan datos del ERP), se montan con la plantilla de la migración
 * 20261117085622, que es la definición de prod del 2026-11-17.
 *
 * El escenario pone, para cada pieza donde la forma por llave mete el filtro, un dato que SÍ debe entrar y uno vecino
 * que no: claves crudas con espacios en `kdii`, en Wincaja y en la escalera de costo, la moda de rótulos decidida por
 * renglones con espacios, el factor capturado, la sustitución manual, el peldaño comprado y el costo de `kdik`.
 *
 * @param {import('pg').Client} c
 * @returns {Promise<{ montadas: string[], peldanosEnTabla: boolean, wh: Record<string,string>, pid: Record<string,string> }>}
 */
const factores = require('../../migrations-newdb/20261117085622_canon621_factores_y_costo_por_llave.js');

const M = '00000000-0000-0000-0000-00000000d01c';

async function montarExistencia(c) {
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const existe = async (o) => (await q(`SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass($1)`, [o]))[0]?.relkind || null;

  // ── Andamio ─────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const r of ['app_runtime', 'dev_ro']) {
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
  }
  for (const s of ['kepler_ods', 'catalog', 'commercial', 'analytics', 'wincaja']) {
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`GRANT USAGE ON SCHEMA ${s} TO app_runtime`);
  }
  const cols = async (t, defs) => { for (const [col, ty] of defs) await c.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${col} ${ty}`); };
  await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdii (sucursal text NOT NULL, c1 text NOT NULL, PRIMARY KEY (sucursal, c1))`);
  await cols('kepler_ods.kdii', [['c11', 'text'], ['c77', 'text'], ['c78', 'numeric'], ['c79', 'numeric'], ['c80', 'text'], ['c81', 'numeric'],
    ['c83', 'text'], ['c84', 'numeric'], ['c87', 'numeric'], ['c88', 'numeric'], ['c89', 'numeric'], ['c90', 'numeric'], ['c91', 'numeric'], ['c92', 'numeric'],
    // c50 (una fecha de la ficha) no la lee ninguna regla: un cambio sólo en ella no debe anotar nada.
    ['c50', 'timestamp']]);
  await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdik (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL, PRIMARY KEY (sucursal, c1, c2))`);
  // c5 (entradas acumuladas) no la lee ninguna regla: sirve para probar que un cambio ajeno no anota nada.
  await cols('kepler_ods.kdik', [['c5', 'numeric'], ['c16', 'double precision']]);
  await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prov_prod (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL, PRIMARY KEY (sucursal, c1, c2))`);
  await cols('kepler_ods.kdpv_prov_prod', [['c3', 'text'], ['c4', 'numeric'], ['c8', 'numeric'], ['c9', 'numeric'], ['c10', 'numeric']]);
  // Lo que lee el precio (recalcular_existencia también lo recalcula).
  await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdm1 (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL, c3 text NOT NULL,
    c4 numeric NOT NULL, c5 numeric NOT NULL, c6 text NOT NULL, PRIMARY KEY (sucursal, c1, c2, c3, c4, c5, c6))`);
  await cols('kepler_ods.kdm1', [['c9', 'timestamp'], ['c10', 'text'], ['c43', 'text']]);
  await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdm2 (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL, c3 text NOT NULL,
    c4 numeric NOT NULL, c5 numeric NOT NULL, c6 text NOT NULL, c7 numeric NOT NULL, PRIMARY KEY (sucursal, c1, c2, c3, c4, c5, c6, c7))`);
  await cols('kepler_ods.kdm2', [['c8', 'text'], ['c9', 'double precision'], ['c11', 'text'], ['c12', 'numeric']]);
  await c.query(`CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_prod_util (sucursal text NOT NULL, c1 text NOT NULL, c2 text NOT NULL,
    c3 numeric NOT NULL, c4 numeric, c5 numeric, c6 numeric, c7 numeric, PRIMARY KEY (sucursal, c1, c2, c3))`);
  await c.query(`CREATE TABLE IF NOT EXISTS catalog.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    nombre varchar NOT NULL, code varchar, deleted_at timestamptz)`);
  await c.query(`CREATE TABLE IF NOT EXISTS catalog.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    brand_id uuid NOT NULL, sku varchar(20), nombre varchar NOT NULL, deleted_at timestamptz)`);
  await cols('catalog.products', [['cost_base', 'numeric'], ['is_promo', 'boolean NOT NULL DEFAULT false'], ['factor_sale', 'integer']]);
  await c.query(`CREATE TABLE IF NOT EXISTS commercial.warehouses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    code varchar(50) NOT NULL, name varchar NOT NULL, deleted_at timestamptz)`);
  await cols('commercial.warehouses', [['kepler_code', 'text'], ['wincaja_source_branch', 'text']]);
  await c.query(`CREATE TABLE IF NOT EXISTS commercial.product_prices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    price_list_id uuid NOT NULL, product_id uuid NOT NULL, price numeric(14,4) NOT NULL, deleted_at timestamptz)`);
  await c.query(`CREATE TABLE IF NOT EXISTS commercial.product_label_prices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    product_id uuid NOT NULL, sucursal varchar(2) NOT NULL, source varchar(12) NOT NULL DEFAULT 'kepler', created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), sold_by_kg boolean NOT NULL DEFAULT false)`);
  await cols('commercial.product_label_prices', [['content', 'varchar(40)'], ['barcode', 'varchar(30)'], ['barcode_format', 'varchar(10)'],
    ['piece_price', 'numeric(14,4)'], ['wholesale_piece_min_qty', 'integer'], ['wholesale_piece_price', 'numeric(14,4)'], ['pack_size', 'integer'],
    ['pack_price', 'numeric(14,4)'], ['wholesale_pack_price', 'numeric(14,4)'], ['box_size', 'integer'], ['box_price', 'numeric(14,4)'],
    ['computed_at', 'timestamptz'], ['unit_base', 'varchar(8)'], ['wholesale_pack_min_qty', 'integer']]);
  await c.query(`CREATE TABLE IF NOT EXISTS commercial.product_unit_overrides (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    product_id uuid NOT NULL, box_factor numeric, deleted_at timestamptz)`);
  await c.query(`CREATE TABLE IF NOT EXISTS analytics.product_box_factor (tenant_id uuid NOT NULL, product_id uuid NOT NULL, box_factor numeric NOT NULL,
    source text NOT NULL DEFAULT 'kepler_c84', updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, product_id))`);
  await c.query(`CREATE TABLE IF NOT EXISTS wincaja.articulos (tenant_id uuid NOT NULL, source_branch text NOT NULL, source_dataset text NOT NULL,
    articulo text NOT NULL, unidad_venta text, factor_venta numeric, PRIMARY KEY (tenant_id, source_branch, source_dataset, articulo))`);
  // Las piezas que la regla lee por nombre. Si faltan, se montan: las etiquetas y el costo con su definición de prod;
  // la escalera de Kepler MÍNIMA (fila por fila, como la real: lo que importa es que el filtro baje igual).
  if (!await existe('commercial.v_product_label_prices')) {
    await c.query(`CREATE VIEW commercial.v_product_label_prices AS
      WITH moda AS (SELECT tenant_id, product_id,
             mode() WITHIN GROUP (ORDER BY piece_price DESC) FILTER (WHERE sucursal::text <> '00'::text) AS m_retail,
             mode() WITHIN GROUP (ORDER BY piece_price DESC) AS m_any
           FROM commercial.product_label_prices WHERE piece_price IS NOT NULL GROUP BY tenant_id, product_id)
      SELECT DISTINCT ON (l.tenant_id, l.product_id) l.id, l.tenant_id, l.product_id, l.content, l.barcode, l.barcode_format, l.piece_price,
             l.wholesale_piece_min_qty, l.wholesale_piece_price, l.pack_size, l.pack_price, l.wholesale_pack_price, l.box_size, l.box_price,
             l.source, l.computed_at, l.created_at, l.updated_at, l.unit_base, l.wholesale_pack_min_qty, l.sold_by_kg, l.sucursal
        FROM commercial.product_label_prices l LEFT JOIN moda m ON m.tenant_id = l.tenant_id AND m.product_id = l.product_id
       ORDER BY l.tenant_id, l.product_id, (NOT l.piece_price IS DISTINCT FROM COALESCE(m.m_retail, m.m_any)) DESC, (l.sucursal::text = '00'::text), l.sucursal`);
  }
  if (!await existe('analytics.v_kepler_item_cost')) {
    await c.query(`CREATE VIEW analytics.v_kepler_item_cost AS SELECT sucursal AS kepler_code, btrim(c2) AS sku,
        CASE WHEN c16 = c16 AND c16 > '-Infinity'::double precision AND c16 < 'Infinity'::double precision THEN c16::numeric ELSE NULL::numeric END AS costo_unitario
      FROM kepler_ods.kdik k WHERE sucursal = btrim(c1)`);
  }
  if (!await existe('analytics.v_kepler_unit_ladder')) {
    await c.query(`CREATE VIEW analytics.v_kepler_unit_ladder AS SELECT btrim(k.sucursal) AS sucursal, btrim(k.c1) AS sku,
        CASE WHEN k.c84 > 1 THEN k.c84 END AS factor_caja, CASE WHEN k.c84 > 1 THEN 'capturado'::text END AS factor_source
      FROM kepler_ods.kdii k WHERE btrim(COALESCE(k.c1, ''::text)) <> ''::text`);
  }
  // Los dos peldaños son matviews nocturnas en prod; si faltan, tablas (son entradas de la regla, no lo que se prueba).
  const peldanosEnTabla = !await existe('analytics.mv_kepler_bought_rung') && !await existe('analytics.mv_kepler_sold_rung');
  if (peldanosEnTabla) {
    await c.query(`CREATE TABLE analytics.mv_kepler_bought_rung (sku text PRIMARY KEY, rung_max numeric, rung_modal numeric, peldanos bigint,
      renglones bigint, primer_visto date, ultimo_visto date)`);
    await c.query(`CREATE TABLE analytics.mv_kepler_sold_rung (sucursal text, sku text, rung_max numeric, rung_modal numeric, peldanos bigint,
      renglones bigint, importe numeric, primer_visto date, ultimo_visto date, PRIMARY KEY (sucursal, sku))`);
  }
  // Las cuatro vistas con regla.
  const montadas = [];
  for (const [v, regla] of factores.PLANTILLAS) {
    const r = await existe(v);
    const igual = r === 'v' && (await q(`SELECT pg_get_viewdef($1::regclass, false) AS d`, [v]))[0].d === regla(null);
    if (!igual) montadas.push(v);
  }
  if (montadas.length) {
    for (const v of ['analytics.v_warehouse_box_factor', 'analytics.v_product_box_factor', 'analytics.v_supplier_cost_ladder', 'analytics.v_kepler_unit_cost']) {
      await c.query(`DROP VIEW IF EXISTS ${v} CASCADE`);
    }
    const reglas = Object.fromEntries(factores.PLANTILLAS);
    for (const v of ['analytics.v_supplier_cost_ladder', 'analytics.v_product_box_factor', 'analytics.v_kepler_unit_cost', 'analytics.v_warehouse_box_factor']) {
      await c.query(`CREATE VIEW ${v} AS ${factores.sinPuntoYComa(reglas[v](null))}`);
    }
  }
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);

  // ── Escenario ─────────────────────────────────────────────────────────────────────────────────────────────────
  const wh = {};
  for (const [code, kepler, wincaja, borrado] of [['Z1', 'Z1', null, false], ['Z2', 'Z2', null, false], ['ZW', null, 'ZW', false], ['Z3', 'Z3', null, true]]) {
    wh[code] = (await q(`INSERT INTO commercial.warehouses (tenant_id, code, name, kepler_code, wincaja_source_branch, deleted_at)
      VALUES ($1, $2, $3, $4, $5, ${borrado ? 'now()' : 'NULL'}) RETURNING id`, [M, code, `Prueba ${code}`, kepler, wincaja]))[0].id;
  }
  const marca = (await q(`INSERT INTO catalog.brands (tenant_id, nombre, code) VALUES ($1, 'Marca F621', 'F621') RETURNING id`, [M]))[0].id;
  const pid = {};
  const alta = async (sku, { fs = null, borrado = false } = {}) => {
    pid[sku.trim()] = (await q(`INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, factor_sale, deleted_at)
      VALUES ($1, $2, $3, $4, $5, ${borrado ? 'now()' : 'NULL'}) RETURNING id`, [M, marca, sku, `Producto ${sku}`, fs]))[0].id;
  };
  for (const s of ['F621A', ' F621B ', 'F621C', 'F621E', 'F621G', 'F621H', 'F621Z']) await alta(s, { fs: s === 'F621E' ? 2 : null });
  await alta('F621D', { borrado: true });
  const kdii = (suc, c1, v = {}) => c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c11, c77, c79, c80, c81, c83, c84, c90)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [suc, c1, v.c11 ?? 'PZA', v.c77 ?? null, v.c79 ?? null, v.c80 ?? null, v.c81 ?? null, v.c83 ?? null, v.c84 ?? null, v.c90 ?? null]);
  await kdii('Z1', 'F621A', { c77: '10', c79: 120, c83: 'CJA', c84: 12, c90: 11 }); await kdii('Z2', 'F621A', { c77: '10', c79: 120, c83: 'CJA', c84: 12 });
  await kdii('Z1', ' F621B ', { c11: 'KG' });                     // crudo con espacios: la escalera lo une CRUDO al producto ' F621B '
  await kdii('Z1', 'F621C', { c84: 10 }); await kdii('Z1', 'F621D', { c84: 5 });
  await kdii('Z1', 'F621E', { c11: 'PZA' });                      // sin factor en la ficha: manda el peldaño comprado
  await kdii('Z1', 'F621G', { c11: 'PZA', c83: 'CJA' }); await kdii('Z2', 'F621G', { c11: 'PZA', c83: 'CJA' }); await kdii('Z3', 'F621G', { c11: 'PZA', c83: 'BOL' });
  // La moda de rótulos agrupa por btrim(kdii.c1): estos dos renglones CRUDOS con espacios (en sucursales sin almacén,
  // para no duplicar la ficha) deciden que la caja de G sea BOL (3 contra 2). Un filtro crudo los perdería.
  await kdii('Z8', ' F621G ', { c11: 'PZA', c83: 'BOL' }); await kdii('Z9', ' F621G ', { c11: 'PZA', c83: 'BOL' });
  await kdii('Z1', 'F621Z', { c77: '2', c79: 96, c83: 'CJA', c84: 48 }); await kdii('Z2', 'F621Z', { c84: 48 });
  const kdik = (suc, sku, costo) => c.query(`INSERT INTO kepler_ods.kdik (sucursal, c1, c2, c16) VALUES ($1, $1, $2, $3)`, [suc, sku, costo]);
  await kdik('Z1', 'F621A', 5.5); await kdik('Z2', 'F621A', 6); await kdik('Z1', ' F621B ', 4); await kdik('Z1', 'F621C', 3);
  await kdik('Z1', 'F621G', 0); await kdik('Z1', 'F621Z', 7); await kdik('Z2', 'F621Z', 7.25); await kdik('Z1', 'F621D', 9);
  await c.query(`INSERT INTO kepler_ods.kdik (sucursal, c1, c2, c16) VALUES ('Z1', 'Z2', 'F621A', 99)`);   // otra sucursal: fuera por la regla
  const prov = (suc, p, sku, caja, u1) => c.query(`INSERT INTO kepler_ods.kdpv_prov_prod (sucursal, c1, c2, c4, c8) VALUES ($1, $2, $3, $4, $5)`, [suc, p, sku, caja, u1]);
  await prov('Z1', 'P1', 'F621G', 240, 10); await prov('Z2', 'P2', 'F621G', 260, 11); await prov('Z1', 'P1', 'F621Z', 480, 10); await prov('Z1', 'P1', 'F621A', 120, 10);
  // H: su ÚNICO renglón de proveedor viene crudo con espacios; es lo que le da escalera (y su rótulo PAQ, de una ficha
  // en una sucursal sin almacén). Un filtro crudo en la escalera de costo lo perdería.
  await prov('Z1', 'P1', ' F621H ', 50, 5); await kdii('Z9', 'F621H', { c83: 'PAQ' });
  const etiqueta = (sku, suc, caja, pieza) => c.query(`INSERT INTO commercial.product_label_prices (tenant_id, product_id, sucursal, box_size, piece_price)
    VALUES ($1, $2, $3, $4, $5)`, [M, pid[sku], suc, caja, pieza]);
  await etiqueta('F621A', 'Z1', 12, 10); await etiqueta('F621G', 'Z1', 24, 5); await etiqueta('F621Z', 'Z1', 48, 2); await etiqueta('F621H', 'Z1', null, 1);
  await c.query(`INSERT INTO analytics.product_box_factor (tenant_id, product_id, box_factor) VALUES ($1, $2, 12), ($1, $3, 10), ($1, $4, 48)`,
    [M, pid.F621A, pid.F621C, pid.F621Z]);
  await c.query(`INSERT INTO commercial.product_unit_overrides (tenant_id, product_id, box_factor) VALUES ($1, $2, 6), ($1, $3, 24)`, [M, pid.F621C, pid.F621Z]);
  await c.query(`INSERT INTO wincaja.articulos (tenant_id, source_branch, source_dataset, articulo, factor_venta, unidad_venta)
    VALUES ($1, 'ZW', 'actual', ' F621B ', 4, 'PZA'), ($1, 'ZW', 'actual', 'F621Z', 12, 'CJA'), ($1, 'ZW', 'historico', 'F621A', 9, 'CJA')`, [M]);
  if (peldanosEnTabla) {
    await c.query(`INSERT INTO analytics.mv_kepler_bought_rung (sku, rung_max, peldanos) VALUES ('F621E', 30, 1), ('F621Z', 48, 2)`);
    await c.query(`INSERT INTO analytics.mv_kepler_sold_rung (sucursal, sku, rung_max, peldanos) VALUES ('Z1', 'F621E', 30, 1), ('Z2', 'F621Z', 24, 1)`);
  }
  return { montadas, peldanosEnTabla, wh, pid };
}

module.exports = { montarExistencia, M };
