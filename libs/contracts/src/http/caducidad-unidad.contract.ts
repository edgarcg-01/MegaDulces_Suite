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

// ───── [P2.9 paso 3] las unidades de UN producto (D3: el selector se filtra) ─────

/** Una unidad en que se puede contar ESTE producto, con su factor contra la base de Kepler. */
export interface CaducidadUnidadProducto {
  codigo: CaducidadUnidad;
  /** Rótulo del ERP del que salió: `PAQ`, `CJA`, `500`… */
  kepler: string;
  /**
   * Cuántas unidades base entran en ésta (la base vale 1). Es lo que usará FEFO (paso 4).
   * `null` = el ERP no lo dice: medido el 2026-11-07, **toda** presentación que sale sólo de la
   * escalera (`kdpv_prod_util`) llega sin factor (1,226 en la plaza 01). No se rellena con 1.
   */
  factor: number | null;
  /** Es la unidad base del producto (`kdii.c11`). */
  base: boolean;
}

/**
 * `GET /commercial/expiry-reviews/products/:sku/unidades`. Las presentaciones del producto
 * (`analytics.v_label_presentations`: base + ranuras + escalera) traducidas a las 7.
 *
 * `unidades: null` NO es «el producto no tiene unidades»: es que **no se supo** (Kepler no publica
 * presentaciones para ese SKU, o la lectura falló) y la pantalla ofrece las 7. `motivo` dice cuál.
 */
export interface CaducidadUnidadesProducto {
  sku: string;
  /** Plaza de Kepler de la que salió la lista (`01`…). `null` cuando no salió de ninguna. */
  plaza: string | null;
  /** `true` si no era la plaza del almacén y se tomó la de otra (el almacén no tiene plaza, o ésta no lo publica). */
  otra_plaza: boolean;
  unidades: CaducidadUnidadProducto[] | null;
  base: CaducidadUnidad | null;
  /** Rótulos del producto que NO son de las 7 (`CUB`, `SER`, `400`…): se dicen, no se esconden. */
  fuera_de_las_7: string[];
  motivo: 'ok' | 'sin_presentaciones' | 'sin_lectura';
}

/**
 * Presentaciones del ERP → las unidades de la hoja. Una por código (si dos rótulos caen en la misma,
 * gana la que trae factor y, entre ésas, la menor), en el orden del contrato. Un rótulo que no es de las 7 va a
 * `fuera_de_las_7`: **no se traduce por su factor** (un `CUB` de 20 no es una «caja»).
 */
export function unidadesDesdePresentaciones(
  ps: ReadonlyArray<{ unidad: string | null; factor: number | string | null; origen: string }>,
): Pick<CaducidadUnidadesProducto, 'unidades' | 'base' | 'fuera_de_las_7'> {
  const porCodigo = new Map<CaducidadUnidad, CaducidadUnidadProducto>();
  const fuera = new Set<string>();
  for (const p of ps) {
    const rotulo = String(p.unidad ?? '').trim().toUpperCase();
    if (!rotulo) continue;
    const codigo = unidadDesdeKepler(rotulo, null);
    if (!codigo) { fuera.add(rotulo); continue; }
    const base = p.origen === 'base';
    const f = p.factor == null || p.factor === '' ? NaN : Number(p.factor);
    const factor = base ? 1 : Number.isFinite(f) && f > 0 ? f : null;
    const previa = porCodigo.get(codigo);
    const gana = !previa || (factor != null && (previa.factor == null || factor < previa.factor));
    if (gana) porCodigo.set(codigo, { codigo, kepler: rotulo, factor, base: base || !!previa?.base });
    else if (base) previa.base = true;
  }
  const unidades = CADUCIDAD_UNIDADES.map((c) => porCodigo.get(c)).filter((u): u is CaducidadUnidadProducto => !!u);
  return {
    unidades: unidades.length ? unidades : null,
    base: unidades.find((u) => u.base)?.codigo ?? null,
    fuera_de_las_7: Array.from(fuera).sort(),
  };
}

/**
 * Qué botones ofrece el selector. Sin lista del producto (no se supo) → las 7. Con lista → sólo las
 * del producto, más las que ya están en juego (`extra`: la que sugirió el código escaneado, la del
 * renglón que se edita) para que nunca desaparezca lo marcado. `verTodas` es la salida «otra unidad»:
 * el catálogo se equivoca, y un filtro que oculta la unidad correcta bloquea la captura.
 */
export function unidadesOfrecidas(
  producto: Pick<CaducidadUnidadesProducto, 'unidades'> | null,
  verTodas: boolean,
  extra: ReadonlyArray<string | null | undefined> = [],
): readonly CaducidadUnidadDef[] {
  if (verTodas || !producto?.unidades?.length) return CADUCIDAD_UNIDADES_DEF;
  const si = new Set<string>(producto.unidades.map((u) => u.codigo));
  for (const e of extra) if (e) si.add(e);
  return CADUCIDAD_UNIDADES_DEF.filter((d) => si.has(d.codigo));
}
