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
 * ── Unidades (NP.11) ──
 * Cada renglón se siembra como lo escribe Kepler: unidad base `c11` con su cantidad `c9`, y —si el
 * movimiento fue en otra unidad— `c55` (unidad), `c56` (cuántas) y `c58` (factor), con
 * `c9 = c56 × c58`. En cada producto: `base` (rótulo `c11`, `PZA` si no se dice) y, por renglón,
 * `u`/`f` (unidad y factor declarados). `rota: true` siembra un renglón que DECLARA caja pero cuya
 * identidad no cierra: tiene que contarse en su unidad base, no en cajas. `ficha` es la ficha de
 * Kepler (`kdii`) por plaza: los rótulos y factores de su escalera, para nombrar la existencia.
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
    // Vendida en su unidad base, y el renglón lo DECLARA (c55 = PZA, factor 1).
    ventas: Array.from({ length: 59 }, (_, i) => ({
      d: -119 + i * 2, plaza: ['03', '04', '05'][i % 3], qty: 6, precio: 19.5, u: 'PZA', f: 1,
    })),
    existencia: ['03', '04', '05'],
    // [NP.15] IEPS 8%, costo del renglón $13 la pieza y la meta de la ficha: 25% sobre costo en la
    // pieza y 12% en el paquete (Kepler la guarda como markup).
    ieps: 8, costo_venta: 13,
    ficha: { c80: 'PAQ', c81: 12, k1: 25, k2: 12 },
  },
  {
    clave: '02', nombre: 'NPDEMO GOMITA ACIDA SANDIA 1KG', alta: -78, L: -75,
    entradas: [{ d: -75, plaza: '02', qty: 40, costo: 150 }],
    // Sin c55: el renglón sólo dice su unidad base, y eso es lo que se publica.
    ventas: Array.from({ length: 18 }, (_, i) => ({ d: -73 + i * 4, plaza: '02', qty: 2, precio: 210 })),
    existencia: ['02'],
    // [NP.15] Sin impuesto, y uno de cada dos renglones SIN costo (como la venta de mayoreo, U-D-8):
    // el margen real tiene que cubrir sólo la mitad, no promediar ceros. La ficha no trae meta.
    costo_venta: 140, sin_costo_cada: 2,
    ficha: {},
  },
  {
    clave: '03', nombre: 'NPDEMO CHOCOLATE RELLENO CAJETA 12PZ', alta: -48, L: -45,
    // Se compra por CAJA de 12 y se vende por caja en la 01 y por pieza en la 04.
    entradas: [
      { d: -45, plaza: '01', qty: 50, costo: 190, u: 'CJA', f: 12 },
      { d: -44, plaza: '04', qty: 35, costo: 200, u: 'CJA', f: 12 },
      { d: -20, plaza: '01', qty: 50, costo: 190, u: 'CJA', f: 12 },
    ],
    ventas: Array.from({ length: 43 }, (_, i) => (i % 2
      ? { d: -43 + i, plaza: '04', qty: 4, precio: 24, u: 'PZA', f: 1 }
      : { d: -43 + i, plaza: '01', qty: 1, precio: 265, u: 'CJA', f: 12 })),
    existencia: ['01', '04'],
    // [NP.15] IVA 16%; la caja (factor 12) tiene su propia meta: el margen de lista se pondera por
    // el peldaño VENDIDO, no por el base.
    iva: 16, costo_venta: 15,
    ficha: { c80: 'CJA', c81: 12, k1: 30, k2: 10 },
  },
  {
    // Entró y NO se vendió: es la señal temprana de un lanzamiento que no despegó.
    clave: '04', nombre: 'NPDEMO CHICLE MENTA XTRA 100PZ', alta: -53, L: -50,
    entradas: [{ d: -50, plaza: '05', qty: 4, costo: 1300, u: 'CJA', f: 100 }],
    ventas: [],
    existencia: ['05'],
    stock: 400,
    ficha: { c80: 'CJA', c81: 100 },
  },
  {
    // Base "500": el gramaje de la bolsa. No es un nombre de unidad y no se traduce como tal.
    clave: '05', nombre: 'NPDEMO CACAHUATE JAPONES LIMON 500G', alta: -15, L: -12, base: '500',
    entradas: [{ d: -12, plaza: '06', qty: 60, costo: 40 }],
    ventas: [-10, -6, -2].map((d) => ({ d, plaza: '06', qty: 2, precio: 58 })),
    existencia: ['06'],
    ficha: {},
  },
  {
    // Mismo código de barras que un producto más viejo: posible recodificación.
    clave: '06', nombre: 'NPDEMO MAZAPAN FRESA 30PZ', alta: -43, L: -40, recodifica: true,
    entradas: [{ d: -40, plaza: '01', qty: 30, costo: 95 }],
    ventas: Array.from({ length: 13 }, (_, i) => ({ d: -39 + i * 3, plaza: '01', qty: 2, precio: 130 })),
    existencia: ['01'],
    ficha: { c80: 'CJA', c81: 30 },
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
    // Sin ficha en Kepler para su plaza: la existencia sale sin rótulo (se declara, no se inventa).
    // Y un renglón que dice "caja" sin que su identidad cierre: cuenta en su base, no en cajas.
    clave: '09', nombre: 'NPDEMO PALOMITAS CARAMELO 80G', alta: -38, L: -35,
    entradas: [],
    ventas: Array.from({ length: 17 }, (_, i) => ({
      d: -35 + i * 2, plaza: '03', qty: 4, precio: 22, ...(i === 0 ? { u: 'CJA', f: 24, rota: true } : {}),
    })),
    existencia: ['03'],
    // [NP.15] Con costo en el renglón, pero sin ficha (sin meta) y sin compras (sin "pagado").
    costo_venta: 16,
  },
  {
    // [NP.13] Viejo en el catálogo (la Suite lo vio hace 400 días) y SIN ningún movimiento hasta
    // HOY, cuando se vende por primera vez: un lanzamiento EN VIVO. No entra por fecha de alta
    // (tiene más de 90 días): sólo la detección en vivo lo puede traer.
    clave: '10', nombre: 'NPDEMO GOMITA ENCHILADA ESTRENO HOY', alta: -400,
    entradas: [],
    ventas: [],
    existencia: [],
  },
  {
    // [NP.13] Dado de alta hace 3 días y sin ningún movimiento: el caso "sin movimiento" (el 08,
    // que lo era, ahora recibe hoy y pasa a lanzamiento en vivo).
    clave: '11', nombre: 'NPDEMO OBLEA CAJETA SIN MOVIMIENTO', alta: -3,
    entradas: [],
    ventas: [],
    existencia: [],
  },
];

const sku = (p) => `${PREFIJO_SKU}${p.clave}`;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Las columnas de unidad de un renglón, como las escribe Kepler. Con `u` declarada, `c9` es la
 * cantidad en la base (`qty × f`), salvo `rota`, que deja `c9 = qty` y rompe la identidad.
 */
function unidadRenglon(p, x) {
  const base = p.base || 'PZA';
  if (!x.u) return { c9: x.qty, c11: base, c55: null, c56: null, c58: null };
  return { c9: x.rota ? x.qty : x.qty * x.f, c11: base, c55: x.u, c56: String(x.qty), c58: String(x.f) };
}
/** La unidad que el candado espera ver publicada: la declarada sólo si su identidad cierra. */
const unidadEsperada = (p, x) => (x.u && !x.rota ? x.u : (p.base || 'PZA'));

/**
 * `[NP.15]` Las columnas de impuesto y costo de un renglón de VENTA, como las escribe Kepler: `c17`
 * la tasa de IVA y `c18` la de IEPS (en negativo), y `c62` el costo de UNA unidad del peldaño
 * vendido. Sin `costo_venta`, o en los renglones `sin_costo_cada`, no hay costo (como el mayoreo).
 * El renglón "roto" no lleva costo: su identidad no cierra y no se sabe qué unidad costearía.
 */
function costoRenglon(p, x, i) {
  const sinCosto = p.costo_venta === undefined || x.rota || (p.sin_costo_cada && i % p.sin_costo_cada === 1);
  return {
    c17: p.iva ? String(-p.iva) : '0',
    c18: p.ieps ? String(-p.ieps) : '0',
    c62: sinCosto ? null : String(r2(p.costo_venta * (x.u ? x.f : 1))),
  };
}
function acumularUnidades(lista, p) {
  const out = {};
  for (const x of lista) {
    out[x.plaza] = out[x.plaza] || {};
    const u = unidadEsperada(p, x);
    out[x.plaza][u] = r3((out[x.plaza][u] || 0) + x.qty);
  }
  return out;
}

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
    // `{ plaza: { unidad: cantidad } }`, calculado aquí de lo sembrado.
    unidades_venta: acumularUnidades(p.ventas, p),
    unidades_entrada: acumularUnidades(p.entradas, p),
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
      const ue = unidadRenglon(p, e);
      await db.raw(
        `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c55, c56, c58)
         VALUES (?, ?, 'X', 'A', 20, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [e.plaza, e.plaza, SERIE, f, sku(p), ue.c9, p.nombre, ue.c11, r2(e.costo / (e.f || 1)), r2(e.qty * e.costo),
          ue.c55, ue.c56, ue.c58]);
    }
    for (const [iv, v] of p.ventas.entries()) {
      folio += 1;
      const f = `NPDV${String(folio).padStart(6, '0')}`;
      const importe = r2(v.qty * v.precio);
      await db.raw(
        `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c12, c13, c16, c43)
         VALUES (?, ?, 'U', 'D', 10, ?, ?, ?::timestamp, '991', 0, ?, 'N')`,
        [v.plaza, v.plaza, SERIE, f, fecha(hoy, v.d), importe]);
      const uv = unidadRenglon(p, v);
      const cv = costoRenglon(p, v, iv);
      await db.raw(
        `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c11, c12, c13, c55, c56, c58, c17, c18, c62)
         VALUES (?, ?, 'U', 'D', 10, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.plaza, v.plaza, SERIE, f, sku(p), uv.c9, uv.c11, r2(v.precio / (v.f || 1)), importe, uv.c55, uv.c56, uv.c58,
          cv.c17, cv.c18, cv.c62]);
    }
    for (const plaza of p.existencia) {
      await db.raw(
        `INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9) VALUES (?, ?, 1, ?, ?, 0, 0)`,
        [plaza, plaza, sku(p), p.stock ?? 24]);
      // La ficha de Kepler de esa plaza: rótulo base y, si tiene, la Unidad Dos con su factor.
      if (p.ficha) {
        // [NP.15] c87/c88 = el % de margen de la ficha (markup sobre costo) de la base y la Unidad Dos.
        await db.raw(
          `INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c11, c77, c80, c81, c78, c87, c88)
           VALUES (?, ?, ?, ?, '10', ?, ?, ?, ?, ?)`,
          [plaza, sku(p), p.nombre, p.base || 'PZA', p.ficha.c80 ?? null, p.ficha.c81 ?? null,
            p.ficha.c81 ? 10 * p.ficha.c81 : null, p.ficha.k1 ?? null, p.ficha.k2 ?? null]);
      }
    }
    out.push({ clave: p.clave, sku: sku(p), product_id: productId, esperado: esperado(p) });
  }
  return { hoy, productos: out };
}

/**
 * Lo que pasa HOY: no entra a la historia (la matvista corta antes de hoy) y lo tiene que traer la
 * parte en vivo. Una venta, una RECOMPRA hoy y la PRIMERA entrada de un producto que estaba sin
 * movimiento (que tiene que pasar a "día 0").
 */
const VIVO = [
  { clave: '03', tipo: 'venta', plaza: '04', qty: 2, precio: 24, u: 'PZA', f: 1 },
  { clave: '03', tipo: 'venta', plaza: '01', qty: 1, precio: 265, u: 'CJA', f: 12 },
  { clave: '02', tipo: 'entrada', plaza: '02', qty: 40, costo: 150 },
  { clave: '08', tipo: 'entrada', plaza: '01', qty: 24, costo: 35 },
  // [NP.13] La primera venta de su vida, hoy: tiene que entrar al universo en el refresco siguiente.
  { clave: '10', tipo: 'venta', plaza: '03', qty: 3, precio: 15, u: 'PZA', f: 1 },
];

async function sembrarVivo(db, hoy) {
  let folio = 900000;
  const out = [];
  for (const v of VIVO) {
    folio += 1;
    const sk = `${PREFIJO_SKU}${v.clave}`;
    const prod = PRODUCTOS.find((p) => p.clave === v.clave);
    const nombre = prod.nombre;
    const uv = unidadRenglon(prod, v);
    if (v.tipo === 'venta') {
      const f = `NPDV${folio}`;
      const importe = r2(v.qty * v.precio);
      await db.raw(
        `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c12, c13, c16, c43)
         VALUES (?, ?, 'U', 'D', 10, ?, ?, ?::timestamp, '991', 0, ?, 'N')`, [v.plaza, v.plaza, SERIE, f, hoy, importe]);
      await db.raw(
        `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c11, c12, c13, c55, c56, c58)
         VALUES (?, ?, 'U', 'D', 10, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.plaza, v.plaza, SERIE, f, sk, uv.c9, uv.c11, r2(v.precio / (v.f || 1)), importe, uv.c55, uv.c56, uv.c58]);
      out.push({ clave: v.clave, tipo: 'venta', plaza: v.plaza, importe, unidad: unidadEsperada(prod, v), cantidad: v.qty });
    } else {
      const f = `NPDR${folio}`;
      const importe = r2(v.qty * v.costo);
      await db.raw(
        `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c43)
         VALUES (?, ?, 'X', 'A', 20, ?, ?, ?::timestamp, 'N')`, [v.plaza, v.plaza, SERIE, f, hoy]);
      await db.raw(
        `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c55, c56, c58)
         VALUES (?, ?, 'X', 'A', 20, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.plaza, v.plaza, SERIE, f, sk, uv.c9, nombre, uv.c11, r2(v.costo / (v.f || 1)), importe, uv.c55, uv.c56, uv.c58]);
      out.push({ clave: v.clave, tipo: 'entrada', plaza: v.plaza, importe, folio: f, unidad: unidadEsperada(prod, v), cantidad: v.qty });
    }
  }
  return out;
}

/** Borra todo lo sembrado (incluida la historia de fondo del script de demo). */
async function limpiar(db) {
  await db.raw(`DELETE FROM kepler_ods.kdm2 WHERE c5 = ? AND c6 LIKE 'NPD%'`, [SERIE]);
  await db.raw(`DELETE FROM kepler_ods.kdm1 WHERE c5 = ? AND c6 LIKE 'NPD%'`, [SERIE]);
  await db.raw(`DELETE FROM kepler_ods.kdil WHERE c3 LIKE ?`, [`${PREFIJO_SKU}%`]);
  await db.raw(`DELETE FROM kepler_ods.kdii WHERE c1 LIKE ?`, [`${PREFIJO_SKU}%`]);
  await db.raw(`DELETE FROM catalog.new_product_reviews WHERE product_id IN (SELECT id FROM catalog.products WHERE sku LIKE ?)`, [`${PREFIJO_SKU}%`]);
  await db.raw(`DELETE FROM catalog.products WHERE sku LIKE ?`, [`${PREFIJO_SKU}%`]);
}

/** Refresca, en orden, las matvistas de las que depende la pantalla. */
async function refrescar(db) {
  await db.raw('REFRESH MATERIALIZED VIEW analytics.mv_kepler_sales_daily');
  await db.raw('REFRESH MATERIALIZED VIEW analytics.mv_new_products');
}

module.exports = {
  TENANT, SERIE, PREFIJO_SKU, PRODUCTOS, VIVO, sembrar, sembrarVivo, limpiar, refrescar, fecha, hoyMx,
  unidadRenglon, costoRenglon,
};
