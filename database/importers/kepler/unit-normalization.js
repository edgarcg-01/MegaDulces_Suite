/* eslint-disable no-console */
/**
 * RS.3 — Modelo de normalización de UNIDAD DE VENTA (compartido).
 *
 * La venta on-prem registra cada línea en su unidad real (`unidad`: PAQ/PZA/KG/500/CJA/CUB…).
 * Sumar `cantidad` a ciegas mezcla paquetes + piezas + kg en un solo número. Este módulo
 * convierte cada línea a un CANÓNICO coherente por producto:
 *   · producto de PIEZA → PIEZAS   (PAQ×pack, CJA×box, PZA×1)
 *   · producto de PESO  → KG       (KG×1, 500×.5, PAQ/CUB×gramaje)
 *
 * Lo usan: import-sales-fact.js (sales_daily), import-rotation-from-consolidado.js (rotación),
 * import-sales-boxes-monthly.js (tabla de cajas). Fuente única de la lógica → no divergen.
 */

// Unidades de venta que representan PESO (no cuenta de piezas).
const WEIGHT_U = new Set(['KG', '1KG', '2KG', '3KG', '5KG', 'CUB', 'BTO', 'BULTO']);

// Etiqueta de unidad que es gramos numéricos ("500" = 500 g = 0.5 kg).
const gramsUnitKg = (u) => { const m = /^(\d+(?:\.\d+)?)$/.exec(u); return m ? Number(m[1]) / 1000 : null; };

// kg que representa una línea vendida en unidad `u` (solo unidades de peso conocidas).
function kgFromUnit(u) {
  if (u === 'KG' || u === '1KG') return 1;
  if (u === '2KG') return 2; if (u === '3KG') return 3; if (u === '5KG') return 5;
  return gramsUnitKg(u);
}

// Gramaje del producto en kg (peso de UNA pieza/paquete/bulto) desde content ("9 kg",
// "560 g", "20 kg") o unit_base ("KG"→1, "500"→0.5). null si no se puede inferir.
function gramajeKg(content, unitBase) {
  const c = String(content || '').trim().toLowerCase();
  let m = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilos?|k)\b/.exec(c);
  if (m) return Number(m[1].replace(',', '.'));
  m = /(\d+(?:[.,]\d+)?)\s*(g|gr|gramos?)\b/.exec(c);
  if (m) return Number(m[1].replace(',', '.')) / 1000;
  const ub = String(unitBase || '').trim().toUpperCase();
  if (ub === 'KG') return 1;
  const gb = /^(\d+(?:\.\d+)?)$/.exec(ub);
  if (gb) return Number(gb[1]) / 1000;
  return null;
}

// kind del producto SOLO desde el catálogo (estable, sin mirar ventas):
// peso si la unidad de venta o la unidad base lo indican; si no, pieza.
function productKind(unitSale, unitBase) {
  const us = String(unitSale || '').trim().toUpperCase();
  if (us === 'KGS' || us === 'KG') return 'weight';
  const ub = String(unitBase || '').trim().toUpperCase();
  if (WEIGHT_U.has(ub) || /^\d+(\.\d+)?$/.test(ub)) return 'weight';
  return 'piece';
}

/**
 * Construye el modelo por producto a partir de una fila de catálogo
 * { unit_sale, factor_sale, pack_size, box_size, unit_base, content }.
 * Devuelve { kind, packF, boxF, gk } listo para toCanonical.
 */
function buildModel(row) {
  const kind = productKind(row.unit_sale, row.unit_base);
  const packF = Number(row.pack_size) > 1 ? Number(row.pack_size) : (Number(row.factor_sale) > 1 ? Number(row.factor_sale) : 1);
  const boxF = Number(row.box_size) > 1 ? Number(row.box_size) : (Number(row.factor_sale) > 1 ? Number(row.factor_sale) : 1);
  // Escala de precios PROPIA de Kepler (kdii): c90 pieza, c91 paquete, c92 caja + factores c81/c84.
  // Cuando está presente, toCanonicalPriced identifica el nivel de cada línea por su precio real
  // (sin depender del label `unidad`, que Kepler escribe de forma inconsistente).
  return {
    kind, packF, boxF, gk: gramajeKg(row.content, row.unit_base),
    pPza: Number(row.p_pza) || 0, pPaq: Number(row.p_paq) || 0, pCaja: Number(row.p_caja) || 0,
    c81: Number(row.c81) > 1 ? Number(row.c81) : 0, c84: Number(row.c84) > 1 ? Number(row.c84) : 0,
  };
}

/**
 * Identifica el NIVEL de venta de una línea por su precio unitario real contra la escala de
 * Kepler (c90/c91/c92) y devuelve el factor a PIEZAS: pieza=1, paquete=c81, caja=c84.
 * Copia la aritmética del ERP; los niveles distan ≥ el factor, así que un descuento no salta nivel.
 * null si no hay escala de precio válida.
 */
function pickPriceTier(model, unitPrice) {
  if (!(unitPrice > 0)) return null;
  const opts = [
    [1, model.pPza],
    [model.c81 || model.packF || 1, model.pPaq],
    [model.c84 || model.boxF || 1, model.pCaja],
  ].filter(([f, pr]) => f >= 1 && pr > 0);
  if (!opts.length) return null;
  let bestF = null, bd = Infinity;
  for (const [f, pr] of opts) { const d = Math.abs(Math.log(unitPrice / pr)); if (d < bd) { bd = d; bestF = f; } }
  return bestF;
}

/**
 * Canónico ANCLADO A PRECIO (fiel al ERP). Producto de PIEZA: pieza = cant × factor_del_nivel,
 * donde el nivel sale del precio unitario vs la escala de Kepler. Sin escala → NO infla (la
 * cantidad de Kepler ya suele ser atómica; multiplicar por factor_sale era el bug del 12×).
 * Producto de PESO: cae al canónico por unidad+gramaje (ahí el label sí es fiable).
 */
function toCanonicalPriced(model, u, cant, unitPrice) {
  if (model.kind === 'weight') return toCanonical(model, u, cant);
  const f = pickPriceTier(model, unitPrice);
  if (f != null) return { qty: cant * f, ok: true };
  return { qty: cant, ok: false }; // fallback atómico (no inflar)
}

/**
 * Convierte `cant` de la unidad `u` al canónico del producto `model` (buildModel).
 * Devuelve { qty, ok }: ok=false si no se pudo convertir (se cuenta, se deja crudo).
 */
function toCanonical(model, u, cant) {
  const uu = String(u || '').trim().toUpperCase();
  if (model.kind === 'weight') {
    const k = kgFromUnit(uu);
    if (k != null) return { qty: cant * k, ok: true };
    if (model.gk != null) return { qty: cant * model.gk, ok: true }; // PAQ/PZA/CUB/BTO → gramaje
    return { qty: cant, ok: false };
  }
  if (uu === 'PZA' || uu === 'PZ' || uu === 'PIEZA') return { qty: cant, ok: true };
  if (uu === 'PAQ') return { qty: cant * (model.packF || 1), ok: true };
  if (uu === 'CJA') return { qty: cant * (model.boxF || 1), ok: true };
  return { qty: cant, ok: false }; // unidad de peso en producto de pieza (raro)
}

module.exports = { WEIGHT_U, kgFromUnit, gramajeKg, productKind, buildModel, toCanonical, pickPriceTier, toCanonicalPriced };
