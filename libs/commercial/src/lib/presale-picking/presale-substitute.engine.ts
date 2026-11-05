/**
 * `[MCP.13]` Reglas puras del cambio de producto al surtir: qué se le sugiere al surtidor en lugar
 * de lo que no hubo y en qué unidades se puede poner. Sin base ni HTTP (presale-substitute.engine.spec.ts).
 *
 * ⛔ «Similar» NO se afirma: el catálogo no trae familia ni línea (medido en prod el 2026-11-04:
 * `department` y `product_line` vacíos en 11,141 productos; la «categoría» es el nombre del
 * proveedor; `kdii.c8` sin verificar). Por eso se SUGIERE por lo único que sí hay —palabras del
 * nombre y proveedor— y elige el surtidor, que tiene la bodega enfrente.
 */
import type { PresaleSubstituteCandidate, PresaleSubstituteUnit } from '@megadulces/contracts';

/**
 * Palabras que no dicen QUÉ es el producto sino su tamaño, empaque o presentación: compartirlas no
 * lo hace parecido («GRANDE», «CJA», «VIT» = vitrolero, «EXH» = exhibidor…).
 */
const VACIAS = new Set([
  'GRANDE', 'GDE', 'CHICO', 'CHICA', 'CH', 'MEDIANO', 'MEDIANA', 'MINI', 'MEGA', 'JUMBO', 'FAMILIAR', 'INDIVIDUAL', 'IND',
  'CAJA', 'CJA', 'CJS', 'PZA', 'PZAS', 'PAQ', 'PAQUETE', 'BLS', 'BOLSA', 'BOLSITA', 'EXH', 'EXHIBIDOR', 'VIT', 'VITROLERO',
  'TIRA', 'TUBO', 'FRASCO', 'BOTE', 'BOT', 'LATA', 'SOBRE', 'DISPLAY', 'CUBETA', 'BTO', 'BULTO',
  'CON', 'SIN', 'DEL', 'LAS', 'LOS', 'UNA', 'UNO', 'PARA', 'POR', 'SURTIDO', 'SURTIDA', 'SURT', 'NUEVO', 'NVO',
  'GRS', 'GRAMOS', 'KGS', 'LTS', 'LITRO', 'LITROS', 'PIEZAS', 'GRATIS',
]);

/** Sin acentos y en mayúsculas, para comparar nombres de Kepler escritos de mil formas. */
export function normalizar(s: string | null | undefined): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/**
 * Las palabras que dicen qué es el producto: tres letras o más, sin números ni medidas, sin las de
 * empaque. «VIT BANDERILLA GRANDE CHILE PI» → [BANDERILLA, CHILE].
 */
export function palabrasClave(nombre: string | null | undefined): string[] {
  const vistas = new Set<string>();
  for (const t of normalizar(nombre).split(/[^A-Z0-9Ñ]+/)) {
    if (t.length < 3 || /\d/.test(t) || VACIAS.has(t)) continue;
    vistas.add(t);
  }
  return [...vistas];
}

export interface ProductoParaComparar {
  product_id: string;
  nombre: string;
  supplier_id: string | null;
}

/**
 * ¿Por qué se sugeriría `cand` en lugar de `original`? `null` = no comparte nada.
 * Puntaje: 10 por palabra clave compartida + 4 si es del mismo proveedor.
 */
export function puntuarSustituto(
  original: ProductoParaComparar,
  cand: ProductoParaComparar,
): { score: number; match: PresaleSubstituteCandidate['match'] } | null {
  if (cand.product_id === original.product_id) return null;
  const mias = new Set(palabrasClave(original.nombre));
  const comunes = palabrasClave(cand.nombre).filter((p) => mias.has(p)).length;
  const proveedor = !!original.supplier_id && original.supplier_id === cand.supplier_id;
  if (!comunes && !proveedor) return null;
  return {
    score: comunes * 10 + (proveedor ? 4 : 0),
    match: comunes && proveedor ? 'nombre_y_proveedor' : comunes ? 'nombre' : 'proveedor',
  };
}

/** La escalera de unidades de un producto en la sucursal, como la necesita la pantalla. */
export interface EscaleraParaSustituto {
  unit_base: string | null;
  rungs: Partial<Record<'base' | 'pack' | 'box', { label: string | null; price: number | null; size: number | null } | undefined>>;
}

/**
 * Las unidades en que se puede poner el sustituto, de menor a mayor: la base siempre; paquete y
 * caja sólo si Kepler las declara con factor mayor a 1 (con factor 1 el rótulo ES la base).
 */
export function unidadesDeEscalera(led: EscaleraParaSustituto | null | undefined): PresaleSubstituteUnit[] {
  if (!led) return [];
  const base = led.rungs.base;
  const out: PresaleSubstituteUnit[] = [
    { unit: String(base?.label || led.unit_base || 'PZA').trim().toUpperCase() || 'PZA', factor: 1, price: base?.price ?? null },
  ];
  for (const k of ['pack', 'box'] as const) {
    const r = led.rungs[k];
    const size = Number(r?.size);
    const label = String(r?.label ?? '').trim().toUpperCase();
    if (!label || !(size > 1) || out.some((u) => u.unit === label)) continue;
    out.push({ unit: label, factor: size, price: r?.price ?? null });
  }
  return out;
}

/** La unidad del renglón original si el sustituto la tiene; si no, su unidad base. */
export function unidadSugerida(units: PresaleSubstituteUnit[], unidadOriginal: string): PresaleSubstituteUnit | null {
  if (!units.length) return null;
  const u = normalizar(unidadOriginal).trim();
  return units.find((x) => x.unit === u) ?? units[0];
}

/**
 * Ordena las sugerencias: primero las que más se parecen por nombre, luego las de más existencia.
 * Las que no tienen existencia medida van al final (no se esconden: el surtidor puede verlas en el anaquel).
 */
export function ordenarSugerencias<T extends { score: number; stock_qty: number | null }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => b.score - a.score || (b.stock_qty ?? -1) - (a.stock_qty ?? -1));
}
