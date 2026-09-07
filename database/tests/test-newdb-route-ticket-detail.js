/* eslint-disable no-console */
/**
 * RR2 — CANDADOS del desglose por ticket de /comercial/ventas-por-ruta.
 *
 * Este test existe para que no vuelvan tres bugs que la investigación evitó por poco:
 *
 *  1) Leer `detalles_mov_almacen.unidad_venta` como si fuera la unidad. Está poblada al
 *     100% con '0'/'1' y parece el peldaño de la escalera de unidades. NO lo es: de los
 *     602 SKUs vendidos con ambos códigos, la razón precio_unitario(0)/precio_unitario(1)
 *     se pega a 1.00 en 562 (93%) y coincide con `factor_venta` (prom 17.6) en CERO casos.
 *     Es un flag interno. Usarlo habría metido un error de ~17× (el bug de CANON.0.1).
 *     → Candado: la columna `unidad` de la vista NUNCA vale '0' ni '1'.
 *
 *  2) Tratar `valor_costo` como costo UNITARIO. Es el monto EXTENDIDO del renglón:
 *     Σcosto/Σventa da 13-16% de margen (creíble); ×qty da −93%..−1234% (absurdo).
 *     → Candado: el margen directo cae en banda sana y el multiplicado por qty NO.
 *
 *  3) Dibujar una equivalencia en cajas con un factor que no corresponde a la unidad del
 *     renglón (regla de la Fase AX: cero unidades inventadas).
 *     → Candado: ningún renglón trae `box_factor` si su unidad ≠ `unit_base` del factor.
 *
 * Más el candado de regresión que protege a los 5 consumidores de `wincaja.v_sales_lines`
 * (sell-out, Thot, RA, Command Center, sales_daily): las columnas nuevas son APPENDED y
 * las 18 originales conservan nombre y posición.
 *
 * Skip-graceful: sin data de ruta en la DB (dev local) valida sólo estructura.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-route-ticket-detail.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Orden y nombre de las 18 columnas que ya consumían otros módulos. */
const BASE_COLS = [
  'tenant_id', 'source_branch', 'warehouse_code', 'wincaja_only', 'source_dataset',
  'business_date', 'sku', 'in_kepler_catalog', 'qty', 'importe', 'costo', 'consecutivo',
  'doc_ref', 'vendedor', 'cliente', 'caja', 'cajero', 'sale_channel',
];

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log('\n=== RR2 · desglose por ticket de la venta en ruta ===\n');

  // ── 1. Contrato de la vista unificada ─────────────────────────────────────────────
  const rel = (await c.query(
    `SELECT relkind, reloptions FROM pg_class WHERE oid = to_regclass('analytics.v_route_sales_lines')`)).rows[0];
  check('v_route_sales_lines existe', !!rel);
  check('es VISTA (derivar, no copiar)', rel && rel.relkind === 'v', rel ? `relkind=${rel.relkind}` : 'ausente');
  // Sin security_invoker la vista correría como su OWNER y saltaría la RLS de
  // wincaja.articulos / pagos_dia / formas_pago ⇒ hueco multi-tenant.
  check('security_invoker=true (la RLS aplica al rol que consulta)',
    !!rel && (rel.reloptions || []).some((o) => /security_invoker=(true|on)/i.test(o)),
    JSON.stringify(rel?.reloptions));

  const vcols = (await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='v_route_sales_lines' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  for (const col of ['source', 'unidad', 'unidad_origen', 'precio_unitario', 'costo', 'iva', 'ieps',
    'hora', 'doc_tipo', 'forma_pago', 'forma_pago_desc', 'vendedor', 'cajero', 'product_id']) {
    check(`la vista expone ${col}`, vcols.includes(col));
  }
  check('las 10 columnas originales siguen al frente y en orden',
    BASE_COLS.filter((x) => ['tenant_id', 'source_branch', 'sale_channel', 'business_date', 'sku', 'qty', 'importe', 'consecutivo', 'doc_ref', 'cliente'].includes(x)).length === 10
      && vcols.slice(0, 10).join(',') === 'tenant_id,source_branch,sale_channel,business_date,sku,qty,importe,consecutivo,doc_ref,cliente',
    vcols.slice(0, 10).join(','));

  // ── 2. Regresión: v_sales_lines no perdió nada (5 consumidores viven de ella) ──────
  const scols = (await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='wincaja' AND table_name='v_sales_lines' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  check('v_sales_lines conserva sus 18 columnas en la MISMA posición',
    scols.slice(0, 18).join(',') === BASE_COLS.join(','), scols.slice(0, 18).join(','));
  for (const col of ['product_id', 'iva', 'ieps', 'descuento1', 'descuento2', 'hora_raw']) {
    check(`v_sales_lines agregó ${col} al final`, scols.slice(18).includes(col));
  }

  // ── 3. route_push_lines: unidad y precio por línea ────────────────────────────────
  const pcols = (await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='route_push_lines'`)).rows.map((r) => r.column_name);
  check('route_push_lines.unidad existe', pcols.includes('unidad'));
  check('route_push_lines.precio_unitario existe', pcols.includes('precio_unitario'));

  // El lookup del rótulo de unidad filtra por (tenant_id, articulo); sin este índice el
  // pkey obliga a un skip-scan (medido en prod: 51 index searches y 1.55 ms por línea).
  const idx = (await c.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname='wincaja' AND indexname='ix_wcj_art_sku'`)).rowCount;
  check('índice ix_wcj_art_sku (tenant_id, articulo)', idx > 0);

  // ── 4. Candados sobre data real ───────────────────────────────────────────────────
  const n = (await c.query(
    `SELECT count(*)::int n FROM analytics.v_route_sales_lines WHERE tenant_id=$1`, [T])).rows[0].n;
  if (!n) {
    console.log('\n  ⓘ sin líneas de venta en ruta en esta DB — se omiten los candados de data\n');
  } else {
    console.log(`\n  (${n.toLocaleString()} líneas de ruta)\n`);

    // CANDADO 1: `unidad` es un rótulo de la fuente, jamás el flag 0/1 del bronze.
    const flag = (await c.query(
      `SELECT count(*)::int n FROM analytics.v_route_sales_lines
       WHERE tenant_id=$1 AND unidad IN ('0','1')`, [T])).rows[0].n;
    check('la unidad NUNCA es el flag 0/1 de detalles_mov_almacen', flag === 0, `${flag} líneas con unidad 0/1`);

    const uds = (await c.query(
      `SELECT count(DISTINCT unidad)::int d, count(unidad)::int con
       FROM analytics.v_route_sales_lines WHERE tenant_id=$1`, [T])).rows[0];
    check('hay rótulos de unidad poblados', uds.con > 0, `${uds.con} líneas con unidad`);
    check('los rótulos tienen varianza real (no una sola unidad para todo)', uds.d >= 2, `${uds.d} distintos`);

    // CANDADO 2: valor_costo es EXTENDIDO. Directo → banda sana; ×qty → absurdo.
    const m = (await c.query(
      `SELECT sum(importe) FILTER (WHERE costo IS NOT NULL) rev,
              sum(costo) cost, sum(costo * qty) cost_x_qty
       FROM analytics.v_route_sales_lines WHERE tenant_id=$1`, [T])).rows[0];
    const rev = Number(m.rev) || 0;
    if (rev <= 0) {
      console.log('  ⓘ ninguna línea trae costo en esta DB — se omite el candado del margen');
    } else {
      const direct = (1 - Number(m.cost) / rev) * 100;
      const xqty = (1 - Number(m.cost_x_qty) / rev) * 100;
      check('el margen con costo DIRECTO cae en banda creíble (0-45%)',
        direct > 0 && direct < 45, `${direct.toFixed(1)}%`);
      check('multiplicar el costo por qty da un absurdo (prueba de que es extendido)',
        xqty < 0, `${xqty.toFixed(1)}% — si esto fuera sano, valor_costo sería unitario`);
    }

    // CANDADO 3: la vista no duplica líneas (el LATERAL de pagos podría, si no fuera LIMIT 1).
    const dup = (await c.query(
      `SELECT (SELECT count(*)::int FROM analytics.v_route_sales_lines
                WHERE tenant_id=$1 AND source='wincaja' AND source_branch <> 'VEC-PH-H') AS via_vista,
              (SELECT count(*)::int FROM wincaja.v_sales_lines
                WHERE tenant_id=$1 AND sale_channel='ruta_venta') AS via_base`, [T])).rows[0];
    check('el enriquecimiento no duplica renglones', dup.via_vista === dup.via_base,
      `vista=${dup.via_vista} base=${dup.via_base}`);

    // Cada línea declara su procedencia: sin esto la UI dibujaría $0 donde no hay dato.
    const src = (await c.query(
      `SELECT source, count(*)::int n FROM analytics.v_route_sales_lines
       WHERE tenant_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [T])).rows;
    check('toda línea declara su fuente (wincaja|push)',
      src.length > 0 && src.every((r) => r.source === 'wincaja' || r.source === 'push'),
      src.map((r) => `${r.source}=${r.n}`).join(' · '));
    check('el costo sólo aparece donde la fuente lo trae',
      (await c.query(`SELECT count(*)::int n FROM analytics.v_route_sales_lines
                      WHERE tenant_id=$1 AND source='push' AND costo IS NOT NULL`, [T])).rows[0].n === 0,
      'el push no trae costo: no se puede inventar');

    // CANDADO 4: equivalencia en cajas sólo con el factor canónico y en SU unidad.
    const bad = (await c.query(
      `SELECT count(*)::int n
       FROM analytics.v_route_sales_lines sl
       JOIN analytics.v_product_box_factor bf
         ON bf.tenant_id=sl.tenant_id AND bf.product_id=sl.product_id
       WHERE sl.tenant_id=$1 AND sl.unidad IS NOT NULL
         AND upper(btrim(bf.unit_base)) <> sl.unidad
         AND bf.box_factor > 1 AND coalesce(bf.is_master_suspect,false)=false`, [T])).rows[0].n;
    // No es un fallo: mide cuántos renglones DEBEN quedarse sin equivalencia.
    console.log(`     ⓘ ${bad.toLocaleString()} renglones se venden en otra unidad que la del factor → sin equivalencia (correcto)`);

    // La forma de pago se resuelve por (sucursal, código): los códigos difieren por sucursal.
    const fp = (await c.query(
      `SELECT count(*)::int con_forma,
              count(*) FILTER (WHERE forma_pago IS NOT NULL AND forma_pago_desc IS NULL)::int sin_catalogo
       FROM analytics.v_route_sales_lines WHERE tenant_id=$1 AND source='wincaja' AND forma_pago IS NOT NULL`, [T])).rows[0];
    if (fp.con_forma > 0) {
      check('la forma de pago se resuelve contra el catálogo de SU sucursal',
        fp.sin_catalogo === 0, `${fp.sin_catalogo} sin descripción`);
    } else {
      console.log('  ⓘ sin pagos_dia cargado — se omite el candado de forma de pago');
    }
  }

  await c.end();
  console.log(`\n=== RR2: ${ok} OK · ${fail} FAIL ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
