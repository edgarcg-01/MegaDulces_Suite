import type { RemisionLine } from '@megadulces/platform-core';

/**
 * `[RE.53]` Conciliación por renglón: remisión del proveedor ↔ renglones de Kepler de la entrada.
 * Motor PURO (sin base): el servicio carga los datos y llama a `conciliarRenglones`; la regla de
 * qué se aprende solo (`aprendibles`) vive aquí también, junto a la que empareja.
 *
 * Tres cosas que el motor de RE.11 hacía mal, medidas en la entrada 0001088 de 8 Esquinas (AGA):
 *  1. **Comparaba el precio de la remisión CON IVA contra el costo de Kepler SIN IVA** con 5 % de
 *     tolerancia: los 14 renglones salían «Difiere precio» con la factura cuadrando a 5 centavos.
 *     En 8 de ellos el importe de la remisión entre el de Kepler da exactamente 1.16. Ahora la base
 *     se decide UNA vez por documento (con o sin IVA), por mayoría de los pares que ya cuadran en
 *     cantidad. ⛔ No se supone: en una muestra de 50 entradas la base normal es sin IVA (52
 *     renglones a 1.00 contra 9 a 1.16).
 *  2. **Emparejaba en el orden de la remisión** (el primero se llevaba el mejor nombre libre):
 *     «RED COLA 24/400» se quedó con «RED COLA 600 ML» y la 24/600 con «400ML». Ahora el
 *     emparejamiento es global y suma la cantidad y el importe como evidencia, no sólo el nombre.
 *  3. **Aprender era un botón por renglón** que nadie usó (la tabla de equivalencias tiene 0
 *     filas). Ahora se aprende solo al dar por buena la factura, con el umbral de `aprendibles`.
 */

export const QTY_TOL = 0.02;   // 2 % en cantidad (normalizada a piezas)
export const PRICE_TOL = 0.05; // 5 % en importe del renglón, en la misma base de IVA
export const IVA = 0.16;
/** Similitud mínima de nombre para considerar un par (la de RE.11). */
export const SIM_MIN = 0.34;
/**
 * `[RE.53]` UMBRAL DE APRENDIZAJE (decisión de diseño, 2026-10-29). Un par se aprende solo cuando
 * la factura se da por buena y además, en ese renglón:
 *   · la cantidad cuadra Y el importe cuadra (en la base de IVA del documento): dos evidencias que
 *     no dependen del nombre — un par cruzado las rompe (RED COLA 400↔600 da 1.58 y 0.63);
 *   · el nombre se parece al menos `SIM_APRENDER` (o vino por código de barras, que es exacto);
 *   · ningún otro renglón de la misma remisión resolvió al mismo SKU (si hay duda, no se aprende).
 */
export const SIM_APRENDER = 0.5;

export interface RenglonKepler {
  linea: string; sku: string | null; nombre: string | null; unidad: string | null;
  cantidad: number; costo_unitario: number; importe: number;
}
export interface AliasAprendido { sku: string; nombre_interno: string | null; box_factor: number | null }

export interface EntradaConciliar {
  remision: RemisionLine[];
  kepler: RenglonKepler[];
  /** descripción normalizada (`normStr`) → alias aprendido para ESTE proveedor */
  aliases: Map<string, AliasAprendido>;
  /** código de barras → sku */
  barcodes: Map<string, string>;
  /** sku → piezas por caja */
  boxFactor: Map<string, number>;
}

export type BasePrecio = 'sin_iva' | 'con_iva' | 'sin_medir';

export interface ReconciledLine {
  idx: number;
  remision: RemisionLine;
  kepler: RenglonKepler | null;
  resolved_sku: string | null;
  resolved_nombre: string | null;
  method: 'alias' | 'barcode' | 'descripcion' | 'sin_match';
  score: number;
  box_factor: number;
  qty_remision_pz: number | null;
  qty_kepler: number | null;
  qty_match: boolean | null;
  price_match: boolean | null;
  status: 'cuadra' | 'difiere_cantidad' | 'difiere_precio' | 'revisar' | 'sin_match';
  alias_hit: boolean;
}

export interface Conciliacion {
  lines: ReconciledLine[];
  kepler_orphans: RenglonKepler[];
  base_precio: BasePrecio;
}

/** Normaliza texto para comparar: minúsculas, sin acentos, puntuación → espacio. */
export function normStr(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'con', 'sin', 'para',
  'pz', 'pza', 'pzs', 'pzas', 'gr', 'grs', 'kg', 'ml', 'lt', 'cja', 'caja', 'paq', 'c', 'pieza', 'piezas']);

/** Tokeniza: descarta tokens de 1 carácter, palabras vacías y unidades sueltas. */
export function tokenize(s: string): string[] {
  return normStr(s).split(/\s+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

/**
 * Similitud nombre del proveedor ↔ nombre Kepler: cobertura de tokens con Jaccard suave y un
 * bono por el primer token (la marca). 0..1. Es la de RE.11, sin cambios.
 */
export function lineSimilarity(remTokens: string[], kepTokens: string[]): number {
  if (!remTokens.length || !kepTokens.length) return 0;
  const kepSet = new Set(kepTokens);
  const matched = remTokens.filter((t) => kepSet.has(t)).length;
  const coverage = matched / remTokens.length;
  const union = new Set([...remTokens, ...kepTokens]).size;
  const jaccard = matched / union;
  let score = 0.7 * coverage + 0.3 * jaccard;
  if (remTokens[0] && kepSet.has(remTokens[0])) score = Math.min(1, score + 0.1);
  return score;
}

const esCaja = (unidad: string | null | undefined) => /(CJA|CAJA|CJ|BULTO|PAQ|DISPLAY|MASTER)/.test((unidad || '').toUpperCase());

/** Importe del renglón de la remisión: el impreso, o cantidad × precio si no vino. */
function importeRemision(r: RemisionLine): number | null {
  const imp = Number(r.importe);
  if (r.importe != null && Number.isFinite(imp) && imp > 0) return imp;
  const q = Number(r.cantidad), p = Number(r.precio_unitario);
  return r.cantidad != null && r.precio_unitario != null && q > 0 && p > 0 ? q * p : null;
}

function cantidadPiezas(r: RemisionLine, bf: number): number | null {
  if (r.cantidad == null || !Number.isFinite(Number(r.cantidad))) return null;
  return esCaja(r.unidad) ? Number(r.cantidad) * bf : Number(r.cantidad);
}

function cuadraCantidad(qtyPz: number | null, k: RenglonKepler): boolean | null {
  if (qtyPz == null) return null;
  return Math.abs(qtyPz - k.cantidad) / Math.max(Math.abs(k.cantidad), 1) <= QTY_TOL;
}

/** El importe de la remisión, llevado a la base de Kepler (sin IVA), contra el de Kepler. */
function cuadraImporte(r: RemisionLine, k: RenglonKepler, base: BasePrecio): boolean | null {
  const ri = importeRemision(r);
  if (ri == null || !(k.importe > 0)) return null;
  const dentro = (x: number) => Math.abs(x - k.importe) / k.importe <= PRICE_TOL;
  // Con IVA: el renglón exento (tasa 0) llega sin IVA aunque el resto lo traiga.
  return base === 'con_iva' ? dentro(ri / (1 + IVA)) || dentro(ri) : dentro(ri);
}

interface Par { i: number; j: number; sim: number; metodo: ReconciledLine['method']; bf: number }

/**
 * Concilia la remisión contra los renglones de Kepler. Puro y determinista: mismo insumo, mismo
 * resultado (los empates se rompen por orden de remisión y luego de Kepler).
 */
export function conciliarRenglones(e: EntradaConciliar): Conciliacion {
  const rem = e.remision.filter((l) => l && l.descripcion);
  const kep = e.kepler;
  const kepTokens = kep.map((k) => tokenize(k.nombre || ''));
  const bfDe = (sku: string | null, alias?: AliasAprendido | null) =>
    (sku && e.boxFactor.get(sku)) || alias?.box_factor || 1;

  // 1) Lo determinista primero: alias aprendido y código de barras fijan el SKU.
  const fijo = new Map<number, { sku: string; nombre: string | null; metodo: 'alias' | 'barcode'; alias: AliasAprendido | null }>();
  rem.forEach((r, i) => {
    const alias = e.aliases.get(normStr(r.descripcion || ''));
    if (alias) { fijo.set(i, { sku: alias.sku, nombre: alias.nombre_interno, metodo: 'alias', alias }); return; }
    const bc = (r.codigo_barras || '').trim();
    const sku = bc.length >= 8 ? e.barcodes.get(bc) : undefined;
    if (sku) fijo.set(i, { sku, nombre: null, metodo: 'barcode', alias: null });
  });

  // 2) Candidatos: el SKU fijo contra su renglón de Kepler; el resto, por nombre contra todos.
  const cands: Par[] = [];
  rem.forEach((r, i) => {
    const f = fijo.get(i);
    if (f) {
      kep.forEach((k, j) => { if (k.sku === f.sku) cands.push({ i, j, sim: f.metodo === 'alias' ? 1 : 0.95, metodo: f.metodo, bf: bfDe(k.sku, f.alias) }); });
      return;
    }
    const t = tokenize(r.descripcion || '');
    kep.forEach((k, j) => {
      const sim = lineSimilarity(t, kepTokens[j]);
      if (sim >= SIM_MIN) cands.push({ i, j, sim, metodo: 'descripcion', bf: bfDe(k.sku) });
    });
  });

  // 3) La base de IVA del DOCUMENTO: entre los pares que cuadran en cantidad, ¿el importe de la
  //    remisión es el de Kepler (sin IVA) o el de Kepler × 1.16? Gana la mayoría; sin pares, no se
  //    sabe y se declara.
  let a1 = 0, aIva = 0;
  for (const p of cands) {
    const r = rem[p.i], k = kep[p.j];
    if (cuadraCantidad(cantidadPiezas(r, p.bf), k) !== true) continue;
    const ri = importeRemision(r);
    if (ri == null || !(k.importe > 0)) continue;
    const q = ri / k.importe;
    if (Math.abs(q - 1) <= PRICE_TOL) a1++;
    else if (Math.abs(q / (1 + IVA) - 1) <= PRICE_TOL) aIva++;
  }
  const base: BasePrecio = a1 + aIva === 0 ? 'sin_medir' : aIva > a1 ? 'con_iva' : 'sin_iva';

  // 4) Emparejamiento GLOBAL: nombre + cantidad + importe. Un par fijo (alias/barras) va primero.
  const puntaje = (p: Par) => {
    const r = rem[p.i], k = kep[p.j];
    const q = cuadraCantidad(cantidadPiezas(r, p.bf), k) === true ? 0.5 : 0;
    const m = cuadraImporte(r, k, base) === true ? 0.5 : 0;
    return (p.metodo === 'descripcion' ? 0 : 10) + p.sim + q + m;
  };
  const orden = cands.map((p) => ({ p, s: puntaje(p) }))
    .sort((a, b) => b.s - a.s || a.p.i - b.p.i || a.p.j - b.p.j);
  const remUsado = new Map<number, Par>();
  const kepUsado = new Set<number>();
  for (const { p } of orden) {
    if (remUsado.has(p.i) || kepUsado.has(p.j)) continue;
    remUsado.set(p.i, p); kepUsado.add(p.j);
  }

  const lines: ReconciledLine[] = rem.map((r, i) => {
    const p = remUsado.get(i);
    const f = fijo.get(i);
    if (!p) {
      // Un SKU fijo cuyo renglón de Kepler no está en esta entrada sigue resuelto, sin par.
      return {
        idx: i, remision: r, kepler: null,
        resolved_sku: f?.sku ?? null, resolved_nombre: f?.nombre ?? null,
        method: f ? f.metodo : 'sin_match', score: f ? (f.metodo === 'alias' ? 1 : 0.95) : 0,
        box_factor: bfDe(f?.sku ?? null, f?.alias), qty_remision_pz: cantidadPiezas(r, bfDe(f?.sku ?? null, f?.alias)),
        qty_kepler: null, qty_match: null, price_match: null, status: 'sin_match', alias_hit: f?.metodo === 'alias',
      };
    }
    const k = kep[p.j];
    const qtyPz = cantidadPiezas(r, p.bf);
    const qty_match = cuadraCantidad(qtyPz, k);
    const price_match = cuadraImporte(r, k, base);
    const status: ReconciledLine['status'] =
      qty_match === false ? 'difiere_cantidad'
      : price_match === false ? 'difiere_precio'
      : qty_match === true ? 'cuadra' : 'revisar';
    return {
      idx: i, remision: r, kepler: k,
      resolved_sku: k.sku, resolved_nombre: f?.nombre || k.nombre,
      method: p.metodo, score: Number(p.sim.toFixed(3)), box_factor: p.bf,
      qty_remision_pz: qtyPz, qty_kepler: k.cantidad, qty_match, price_match, status,
      alias_hit: p.metodo === 'alias',
    };
  });

  return { lines, kepler_orphans: kep.filter((_, j) => !kepUsado.has(j)), base_precio: base };
}

export interface Aprendible {
  descripcion: string; sku: string; nombre_interno: string | null;
  unidad_proveedor: string | null; box_factor: number | null; refuerza: boolean;
}

/**
 * `[RE.53]` Qué se aprende solo al dar por buena la factura (umbral en `SIM_APRENDER`). Un alias que
 * ya existía y volvió a cuadrar se REFUERZA (sube su confianza); uno que no cuadró no se toca.
 */
export function aprendibles(c: Conciliacion): Aprendible[] {
  const porSku = new Map<string, number>();
  for (const l of c.lines) if (l.resolved_sku) porSku.set(l.resolved_sku, (porSku.get(l.resolved_sku) ?? 0) + 1);
  return c.lines
    .filter((l) => l.kepler && l.resolved_sku && l.remision.descripcion
      && l.qty_match === true && l.price_match === true
      && porSku.get(l.resolved_sku) === 1
      && (l.method === 'alias' || l.method === 'barcode' || (l.method === 'descripcion' && l.score >= SIM_APRENDER)))
    .map((l) => ({
      descripcion: l.remision.descripcion as string,
      sku: l.resolved_sku as string,
      nombre_interno: l.resolved_nombre,
      unidad_proveedor: (l.remision.unidad || '').toUpperCase() || null,
      box_factor: esCaja(l.remision.unidad) ? l.box_factor : null,
      refuerza: l.method === 'alias',
    }));
}
