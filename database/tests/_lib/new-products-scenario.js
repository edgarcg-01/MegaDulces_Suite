'use strict';
/**
 * `[NP.3]` Escenario de Productos nuevos con resultado CONOCIDO.
 *
 * Lo comparten dos consumidores para que describan exactamente el mismo caso:
 *   · `database/tests/test-newdb-new-products.js` — siembra en una transacción, refresca, mide
 *     contra lo esperado y REVIERTE (no deja rastro).
 *   · `database/scripts/seed-local-new-products-demo.js` — siembra y CONFIRMA, para ver la
 *     pantalla en local. Tiene `--undo`.
 *
 * Siembra por el camino REAL: documentos de Kepler en `kepler_ods.kdm1/kdm2` (entradas `X-A-20`
 * y tickets `U-D-10`) y existencia en `kdil`, y después refresca las matvistas. Así la prueba
 * ejercita las vistas de verdad (`erp_goods_receipt_lines`, `mv_kepler_sales_daily`,
 * `v_sellout_daily`, `v_erp_stock_on_hand`), no una copia de su lógica.
 *
 * Todo lo sembrado se reconoce por su marca: SKU `NPDEMO-*`, folios `NPD*` con serie 99.
 * Las fechas son RELATIVAS a hoy (TZ México), así que el escenario no envejece.
 *
 * ⚠️ Las plazas no se eligen al azar. `v_sellout_daily` toma la venta de Kepler de cada plaza
 * sólo desde que esa plaza pasó a Kepler (01 desde el 1-jul-2026, 02 desde el 1-oct-2025, 06
 * desde el 15-ago-2026; antes su verdad es Wincaja). Una venta de Kepler sembrada en la 01 en
 * junio NO existe para el sell-out, y así fue como la primera versión de este escenario perdió
 * ventas. Lo que va más atrás de esas fechas se siembra en 03/04/05, que siempre fueron Kepler.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SERIE = 99;
const PREFIJO_SKU = 'NPDEMO-';

/**
 * Cada producto, con lo que debe medir la matvista. `L` = día de su lanzamiento (relativo a hoy,
 * negativo = en el pasado). Entradas y ventas también son relativas a hoy.
 */
const PRODUCTOS = [
  {
    clave: 'OLD', nombre: 'NPDEMO PRODUCTO CON HISTORIA', alta: -270,
    // Se mueve desde hace 260 días: NO es nuevo. Además le da historia a tienda y entradas.
    entradas: [{ d: -262, plaza: '03', qty: 100, costo: 10 }],
    ventas: Array.from({ length: 17 }, (_, i) => ({ d: -260 + i * 15, plaza: '03', qty: 3, precio: 18 })),
    existencia: [],
  },
  {
    clave: '01', nombre: 'NPDEMO PALETA MANGO CHILE 30G', alta: -123, L: -120,
    entradas: [
      { d: -120, plaza: '03', qty: 400, costo: 12 },
      { d: -118, plaza: '04', qty: 300, costo: 12 },
      { d: -75, plaza: '03', qty: 400, costo: 12 }, // recompra en una plaza que ya lo tenía
    ],
    ventas: Array.from({ length: 59 }, (_, i) => ({
      d: -119 + i * 2, plaza: ['03', '04', '05'][i % 3], qty: 6, precio: 19.5,
    })),
    existencia: ['03', '04', '05'],
  },
  {
    clave: '02', nombre: 'NPDEMO GOMITA ACIDA SANDIA 1KG', alta: -78, L: -75,
    entradas: [{ d: -75, plaza: '02', qty: 40, costo: 150 }],
    ventas: Array.from({ length: 18 }, (_, i) => ({ d: -73 + i * 4, plaza: '02', qty: 2, precio: 210 })),
    existencia: ['02'],
  },
  {
    clave: '03', nombre: 'NPDEMO CHOCOLATE RELLENO CAJETA 12PZ', alta: -48, L: -45,
    entradas: [
      { d: -45, plaza: '01', qty: 50, costo: 190 },
      { d: -44, plaza: '04', qty: 35, costo: 200 },
      { d: -20, plaza: '01', qty: 50, costo: 190 },
    ],
    ventas: Array.from({ length: 43 }, (_, i) => ({ d: -43 + i, plaza: i % 2 ? '04' : '01', qty: 3, precio: 265 })),
    existencia: ['01', '04'],
  },
  {
    // Entró y NO se vendió: es la señal temprana de un lanzamiento que no despegó.
    clave: '04', nombre: 'NPDEMO CHICLE MENTA XTRA 100PZ', alta: -53, L: -50,
    entradas: [{ d: -50, plaza: '05', qty: 40, costo: 130 }],
    ventas: [],
    existencia: ['05'],
  },
  {
    clave: '05', nombre: 'NPDEMO CACAHUATE JAPONES LIMON 500G', alta: -15, L: -12,
    entradas: [{ d: -12, plaza: '06', qty: 60, costo: 40 }],
    ventas: [-10, -6, -2].map((d) => ({ d, plaza: '06', qty: 2, precio: 58 })),
    existencia: ['06'],
  },
  {
    // Mismo código de barras que un producto más viejo: posible recodificación.
    clave: '06', nombre: 'NPDEMO MAZAPAN FRESA 30PZ', alta: -43, L: -40, recodifica: true,
    entradas: [{ d: -40, plaza: '01', qty: 30, costo: 95 }],
    ventas: Array.from({ length: 13 }, (_, i) => ({ d: -39 + i * 3, plaza: '01', qty: 2, precio: 130 })),
    existencia: ['01'],
  },
  {
    // Código de descuento por volumen (CV.12): se excluye solo.
    clave: '07', nombre: 'DESC VOLUMEN NPDEMO PALETA', alta: -23, L: -18,
    entradas: [],
    ventas: [{ d: -18, plaza: '01', qty: 1, precio: 1 }],
    existencia: [],
  },
  {
    // Dado de alta hace 6 días y sin ningún movimiento todavía.
    clave: '08', nombre: 'NPDEMO BOMBON GIGANTE TUTTI 1KG', alta: -6,
    entradas: [],
    ventas: [],
    existencia: [],
  },
  {
    // Se vende pero NO tiene entrada en Kepler (llegó por traspaso del CEDIS): inversión no medida.
    clave: '09', nombre: 'NPDEMO PALOMITAS CARAMELO 80G', alta: -38, L: -35,
    entradas: [],
    ventas: Array.from({ length: 17 }, (_, i) => ({ d: -35 + i * 2, plaza: '03', qty: 4, precio: 22 })),
    existencia: ['03'],
  },
];

const sku = (p) => `${PREFIJO_SKU}${p.clave}`;
const r2 = (v) => Math.round(v * 100) / 100;

function fecha(hoy, d) {
  const t = Date.parse(`${hoy}T12:00:00Z`) + d * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

async function hoyMx(db) {
  const { rows } = await db.raw(
    `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS hoy`);
  return rows[0].hoy;
}

/** Lo que la matvista TIENE que medir, calculado aquí por separado (segunda implementación). */
function esperado(p) {
  const dias = [...p.entradas.map((e) => e.d), ...p.ventas.map((v) => v.d)];
  if (!dias.length) return { lanzamiento: null };
  // El lanzamiento se calcula de lo sembrado, no se copia de `p.L`: si alguien mueve una fecha
  // y no actualiza `L`, el candado tiene que ver la diferencia, no heredarla.
  const L = Math.min(...dias);
  if (p.L !== undefined && p.L !== L) throw new Error(`escenario incoherente: ${p.clave} declara L=${p.L} y sus datos dan ${L}`);
  const suma = (lista, hasta, f) => {
    const sel = lista.filter((x) => hasta === undefined || x.d < L + hasta);
    return sel.length ? r2(sel.reduce((s, x) => s + f(x), 0)) : null;
  };
  const inv = (h) => suma(p.entradas, h, (x) => x.qty * x.costo);
  const ven = (h) => suma(p.ventas, h, (x) => x.qty * x.precio);
  // Recompra = segunda fecha de entrada en una plaza que ya lo había recibido.
  const porPlaza = new Map();
  for (const e of p.entradas) porPlaza.set(e.plaza, [...(porPlaza.get(e.plaza) || []), e.d]);
  const segundas = [...porPlaza.values()].map((ds) => [...new Set(ds)].sort((a, b) => a - b)[1]).filter((d) => d !== undefined);
  return {
    lanzamiento: L,
    inversion_30: inv(30), inversion_60: inv(60), inversion_90: inv(90), inversion_total: inv(undefined),
    venta_30: ven(30), venta_60: ven(60), venta_90: ven(90), venta_total: ven(undefined),
    recompra: segundas.length ? Math.min(...segundas) : null,
    entradas: p.entradas.length,
    plazas_recibido: new Set(p.entradas.map((e) => e.plaza)).size,
    plazas_venta: new Set(p.ventas.map((v) => v.plaza)).size,
    dias_con_venta_30: new Set(p.ventas.filter((v) => v.d < L + 30).map((v) => v.d)).size,
    plazas_con_existencia: p.existencia.length,
  };
}

/**
 * Siembra el escenario. `db` es un knex o una transacción de knex.
 * Devuelve `{ hoy, productos }` con el id y lo esperado de cada producto.
 */
async function sembrar(db) {
  const hoy = await hoyMx(db);
  const marca = (await db.raw(
    `SELECT id FROM catalog.brands WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY (code = 'SIN-LINEA') DESC, created_at LIMIT 1`,
    [TENANT])).rows[0];
  if (!marca) throw new Error('No hay ninguna marca en catalog.brands para colgar los productos de prueba');
  // El código de barras del producto "recodificado": el de un producto real dado de alta antes.
  const viejo = (await db.raw(
    `SELECT btrim(barcode) AS barcode FROM catalog.products
      WHERE tenant_id = ? AND deleted_at IS NULL AND btrim(coalesce(barcode,'')) ~ '^[0-9]{13}$'
        AND sku NOT LIKE ? ORDER BY created_at LIMIT 1`, [TENANT, `${PREFIJO_SKU}%`])).rows[0];

  let folio = 0;
  const out = [];
  for (const p of PRODUCTOS) {
    const barcode = p.recodifica && viejo ? viejo.barcode : null;
    const ins = await db.raw(
      `INSERT INTO catalog.products (tenant_id, brand_id, nombre, sku, barcode, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'kepler', (?::date + time '10:00')::timestamptz, now())
       RETURNING id`,
      [TENANT, marca.id, p.nombre, sku(p), barcode, fecha(hoy, p.alta)]);
    const productId = ins.rows[0].id;

    for (const e of p.entradas) {
      folio += 1;
      const f = `NPDR${String(folio).padStart(6, '0')}`;
      await db.raw(
        `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c43)
         VALUES (?, ?, 'X', 'A', 20, ?, ?, ?::timestamp, 'N')`, [e.plaza, e.plaza, SERIE, f, fecha(hoy, e.d)]);
      await db.raw(
        `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13)
         VALUES (?, ?, 'X', 'A', 20, ?, ?, 1, ?, ?, ?, 'PZA', ?, ?)`,
        [e.plaza, e.plaza, SERIE, f, sku(p), e.qty, p.nombre, e.costo, r2(e.qty * e.costo)]);
    }
    for (const v of p.ventas) {
      folio += 1;
      const f = `NPDV${String(folio).padStart(6, '0')}`;
      const importe = r2(v.qty * v.precio);
      await db.raw(
        `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c12, c13, c16, c43)
         VALUES (?, ?, 'U', 'D', 10, ?, ?, ?::timestamp, '991', 0, ?, 'N')`,
        [v.plaza, v.plaza, SERIE, f, fecha(hoy, v.d), importe]);
      await db.raw(
        `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c11, c12, c13)
         VALUES (?, ?, 'U', 'D', 10, ?, ?, 1, ?, ?, 'PZA', ?, ?)`,
        [v.plaza, v.plaza, SERIE, f, sku(p), v.qty, v.precio, importe]);
    }
    for (const plaza of p.existencia) {
      await db.raw(
        `INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9) VALUES (?, ?, 1, ?, 24, 0, 0)`,
        [plaza, plaza, sku(p)]);
    }
    out.push({ clave: p.clave, sku: sku(p), product_id: productId, esperado: esperado(p) });
  }
  return { hoy, productos: out };
}

/** Borra todo lo sembrado (incluida la historia de fondo del script de demo). */
async function limpiar(db) {
  await db.raw(`DELETE FROM kepler_ods.kdm2 WHERE c5 = ? AND c6 LIKE 'NPD%'`, [SERIE]);
  await db.raw(`DELETE FROM kepler_ods.kdm1 WHERE c5 = ? AND c6 LIKE 'NPD%'`, [SERIE]);
  await db.raw(`DELETE FROM kepler_ods.kdil WHERE c3 LIKE ?`, [`${PREFIJO_SKU}%`]);
  await db.raw(`DELETE FROM catalog.new_product_reviews WHERE product_id IN (SELECT id FROM catalog.products WHERE sku LIKE ?)`, [`${PREFIJO_SKU}%`]);
  await db.raw(`DELETE FROM catalog.products WHERE sku LIKE ?`, [`${PREFIJO_SKU}%`]);
}

/** Refresca, en orden, las matvistas de las que depende la pantalla. */
async function refrescar(db) {
  await db.raw('REFRESH MATERIALIZED VIEW analytics.mv_kepler_sales_daily');
  await db.raw('REFRESH MATERIALIZED VIEW analytics.mv_new_products');
}

module.exports = { TENANT, SERIE, PREFIJO_SKU, PRODUCTOS, sembrar, limpiar, refrescar, fecha, hoyMx };
