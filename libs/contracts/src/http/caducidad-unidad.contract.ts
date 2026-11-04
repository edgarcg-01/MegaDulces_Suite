/**
 * `[P2.9 paso 1]` Las unidades en que se CUENTA una caducidad — **una sola definición** para la base (CHECK de
 * `commercial.expiry_review_lines.unit`), el servicio (validación y pista del código escaneado) y la pantalla
 * (botones, plural, hoja impresa). Antes vivían escritas a mano en 7 lugares que no se hablaban.
 *
 * Decisiones del PM (2026-10-19, `FASE_FEFO_CADUCIDAD` §P2.9):
 *  · D1 — `g250`/`g500` cuentan **bolsas** (la presentación); el kilo es otra unidad del mismo producto.
 *  · D2 — `PAQ` es **paquete** (antes se sugería «caja»).
 *  · D5 — cubeta (`CUB`) fuera, hasta que una sucursal la pida: agregarla = una fila aquí + una migración.
 *
 * Medido el 2026-10-30 (prod, sólo lectura): 74 de los 104 productos capturados son de base `PAQ` y
 * sólo el 46 % de los renglones estaba en una unidad que el producto tiene en Kepler.
 *
 * ⛔ Agregar una unidad aquí sin ampliar el CHECK hace que la base rechace el guardado (500).
 */
import { unidadLegible } from './price-presentation.contract';

export const CADUCIDAD_UNIDADES = ['pieza', 'paquete', 'caja', 'bulto', 'kg', 'g250', 'g500'] as const;
export type CaducidadUnidad = (typeof CADUCIDAD_UNIDADES)[number];

export interface CaducidadUnidadDef {
  codigo: CaducidadUnidad;
  /** Lo que dice el botón. */
  etiqueta: string;
  singular: string;
  plural: string;
  /** Rótulo de Kepler equivalente (`kdii.c11/c80/c83`). */
  kepler: string;
  /** `peso`: la cantidad puede llevar decimales. */
  tipo: 'conteo' | 'peso';
  /** Ayuda corta para quien captura. */
  pista: string;
}

const KEPLER: Readonly<Record<CaducidadUnidad, string>> = {
  pieza: 'PZA', paquete: 'PAQ', caja: 'CJA', bulto: 'BTO', kg: 'KG', g250: '250', g500: '500',
};

const PISTA: Readonly<Record<CaducidadUnidad, string>> = {
  pieza: 'Suelto, de a uno',
  paquete: 'El empaque con varias piezas',
  caja: 'Caja cerrada de proveedor',
  bulto: 'Bolsa grande o costal',
  kg: 'Granel pesado en báscula',
  g250: 'Bolsa de 250 gramos',
  g500: 'Bolsa de 500 gramos',
};

/** Las 7, en el orden en que se ofrecen. Singular/plural salen de `unidadLegible` (un solo vocabulario). */
export const CADUCIDAD_UNIDADES_DEF: readonly CaducidadUnidadDef[] = CADUCIDAD_UNIDADES.map((codigo) => {
  const k = KEPLER[codigo];
  const legible = unidadLegible(k);
  const bolsa = codigo === 'g250' || codigo === 'g500';
  return {
    codigo,
    etiqueta: bolsa ? legible.singular : legible.singular.charAt(0).toUpperCase() + legible.singular.slice(1),
    singular: bolsa ? `bolsa de ${legible.singular}` : legible.singular,
    plural: bolsa ? `bolsas de ${legible.plural}` : legible.plural,
    kepler: k,
    tipo: codigo === 'kg' ? 'peso' : 'conteo',
    pista: PISTA[codigo],
  };
});

export function esCaducidadUnidad(v: unknown): v is CaducidadUnidad {
  return typeof v === 'string' && (CADUCIDAD_UNIDADES as readonly string[]).includes(v);
}

export function caducidadUnidadDef(codigo: string | null | undefined): CaducidadUnidadDef | null {
  return CADUCIDAD_UNIDADES_DEF.find((d) => d.codigo === codigo) ?? null;
}

/**
 * «3 paquetes» · «1 caja» · «2.5 kg» · «4 bolsas de 250 g». Un valor que no es de las 7 (renglón viejo o
 * de una versión posterior) se muestra CRUDO, no se traduce a otra cosa; sin unidad, «pz» (lo que la hoja
 * mostraba antes de que existiera la columna).
 */
export function unidadEnTexto(cantidad: number | string | null | undefined, codigo: string | null | undefined): string {
  if (!codigo) return 'pz';
  const d = caducidadUnidadDef(codigo);
  if (!d) return String(codigo);
  return Number(cantidad) === 1 ? d.singular : d.plural;
}

/**
 * La unidad que sugiere el CÓDIGO escaneado (`catalog.product_barcodes.unit` o la ranura de `kdii`).
 * Reemplaza a `unitHint`: `PAQ` ya **no** da «caja» (D2). Sin unidad declarada, el factor todavía dice
 * algo (>1 = empaque cerrado, 1 = pieza); sin unidad ni factor, **no inventa**.
 */
export function unidadDesdeKepler(unidad: string | null | undefined, factor: number | null | undefined): CaducidadUnidad | null {
  const u = String(unidad ?? '').trim().toUpperCase();
  if (u) {
    if (u.startsWith('PAQ') || u === 'PAQUETE') return 'paquete';
    if (u.startsWith('PZ') || u === 'PIEZA' || u === 'UN') return 'pieza';
    if (u.startsWith('CJ') || u === 'CAJA' || u === 'BOX') return 'caja';
    if (u.startsWith('KG') || u === 'KILO') return 'kg';
    if (u.startsWith('BUL') || u === 'BTO' || u.startsWith('COS')) return 'bulto';
    if (u === '250') return 'g250';
    if (u === '500') return 'g500';
  }
  if (factor != null && factor > 1) return 'caja';
  if (factor === 1) return 'pieza';
  return null;
}
