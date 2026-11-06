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
  /** `[RE.56]` `numeros` = el nombre no alcanzaba, pero la cantidad y el importe cuadran exactos. */
  method: 'alias' | 'barcode' | 'descripcion' | 'numeros' | 'sin_match';
  score: number;
  box_factor: number;
  qty_remision_pz: number | null;
  qty_kepler: number | null;
  qty_match: boolean | null;
  price_match: boolean | null;
  /** `[RE.56]` `agrupado` = junto con otros renglones de la remisión forma UN renglón de Kepler. */
  status: 'cuadra' | 'difiere_cantidad' | 'difiere_precio' | 'revisar' | 'agrupado' | 'sin_match';
  alias_hit: boolean;
  /** `[RE.56]` Si es parte de un grupo: la línea de Kepler y cuántos renglones lo forman. */
  grupo?: { linea: string; renglones: number } | null;
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
  const enKep = (t: string) => kepTokens.some((k) => k === t || casiIgual(t, k));
  const matched = remTokens.filter(enKep).length;
  const coverage = matched / remTokens.length;
  const union = new Set([...remTokens, ...kepTokens]).size;
  const jaccard = matched / union;
  let score = 0.7 * coverage + 0.3 * jaccard;
  if (remTokens[0] && enKep(remTokens[0])) score = Math.min(1, score + 0.1);
  return score;
}

/**
 * `[RE.56]` Una falta de ortografía del proveedor: «OJUELA» por «HOJUELA» (0000276 de Canindo).
 * Distancia de edición 1, sólo entre palabras de 5+ LETRAS: «400» y «600» siguen siendo distintos
 * (es el cruce RED COLA 400↔600 de RE.53), y una palabra corta cambia de sentido con una letra.
 */
export function casiIgual(a: string, b: string): boolean {
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (!/^[a-z]+$/.test(a) || !/^[a-z]+$/.test(b)) return false;
  // Levenshtein acotado a 1: se recorre una vez y se permite un solo tropiezo.
  let i = 0, j = 0, tropiezos = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++tropiezos > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return tropiezos + (a.length - i) + (b.length - j) <= 1;
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

  // 3b) `[RE.56]` Pares por NÚMEROS: el nombre no llegó al mínimo, pero la cantidad cuadra y el
  //     importe también (o no se puede medir y esa cantidad es única en la entrada). En 0000276
  //     «FRANCESA SABOR PAPA ADOBADA 10» sólo tenía por nombre a «HOJUELA PAPA ADOBADA 20»; el
  //     suyo, «FRITURA ADOBADA 10», se parecía 0.22 y nunca entraba a competir.
  const yaEs = new Set(cands.map((p) => `${p.i}|${p.j}`));
  rem.forEach((r, i) => {
    if (fijo.has(i)) return;
    const t = tokenize(r.descripcion || '');
    kep.forEach((k, j) => {
      if (yaEs.has(`${i}|${j}`)) return;
      const bf = bfDe(k.sku);
      if (cuadraCantidad(cantidadPiezas(r, bf), k) !== true) return;
      const imp = cuadraImporte(r, k, base);
      if (imp === false) return;
      if (imp === null && kep.filter((o) => Math.abs(o.cantidad - k.cantidad) / Math.max(Math.abs(k.cantidad), 1) <= QTY_TOL).length > 1) return;
      cands.push({ i, j, sim: lineSimilarity(t, kepTokens[j]), metodo: 'numeros', bf });
    });
  });

  // 4) Emparejamiento GLOBAL: nombre + cantidad + importe. Un par fijo (alias/barras) va primero.
  const puntaje = (p: Par) => {
    const r = rem[p.i], k = kep[p.j];
    const q = cuadraCantidad(cantidadPiezas(r, p.bf), k) === true ? 0.5 : 0;
    const m = cuadraImporte(r, k, base) === true ? 0.5 : 0;
    return (p.metodo === 'descripcion' || p.metodo === 'numeros' ? 0 : 10) + p.sim + q + m;
  };
  const orden = cands.map((p) => ({ p, s: puntaje(p) }))
    .sort((a, b) => b.s - a.s || a.p.i - b.p.i || a.p.j - b.p.j);
  const remUsado = new Map<number, Par>();
  const kepUsado = new Set<number>();
  for (const { p } of orden) {
    if (remUsado.has(p.i) || kepUsado.has(p.j)) continue;
    remUsado.set(p.i, p); kepUsado.add(p.j);
  }

  // 5) `[RE.56]` N:1 — Kepler capturó varias figuras del proveedor con UN código (0000276:
  //    MINIRRUEDA 40 + ENFRUTA DE HARINA 30 + ANILLO 30 = «FRITURA DE HARINA» 100). Para cada
  //    renglón de Kepler sin pareja, se busca el subconjunto de renglones sueltos que suma su
  //    cantidad y su importe. ⛔ Sólo si es ÚNICO: con dos combinaciones posibles no se elige.
  const grupos = agruparHuerfanos(rem, kep, remUsado, kepUsado, fijo, bfDe, base);

  const lines: ReconciledLine[] = rem.map((r, i) => {
    const p = remUsado.get(i);
    const f = fijo.get(i);
    const g = grupos.get(i);
    if (!p && g) {
      const k = kep[g.j];
      return {
        idx: i, remision: r, kepler: k, resolved_sku: k.sku, resolved_nombre: k.nombre,
        method: 'numeros', score: 0, box_factor: bfDe(k.sku),
        qty_remision_pz: cantidadPiezas(r, bfDe(k.sku)), qty_kepler: k.cantidad,
        qty_match: null, price_match: null, status: 'agrupado', alias_hit: false,
        grupo: { linea: k.linea, renglones: g.n },
      };
    }
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

  const agrupados = new Set([...grupos.values()].map((g) => g.j));
  return { lines, kepler_orphans: kep.filter((_, j) => !kepUsado.has(j) && !agrupados.has(j)), base_precio: base };
}

/** `[RE.56]` Cuántos renglones sueltos se prueban como máximo, y de qué tamaño puede ser un grupo. */
export const GRUPO_MAX_SUELTOS = 14;
export const GRUPO_MAX = 5;

/**
 * `[RE.56]` renglón de la remisión → el renglón de Kepler que forma con otros. Un suelto con SKU fijo
 * (alias o barras) sólo entra al grupo de SU SKU. Sin importes medibles en todo el subconjunto,
 * decide la cantidad sola, y la regla de unicidad es la que evita adivinar.
 */
function agruparHuerfanos(
  rem: RemisionLine[], kep: RenglonKepler[], remUsado: Map<number, Par>, kepUsado: Set<number>,
  fijo: Map<number, { sku: string }>, bfDe: (sku: string | null) => number, base: BasePrecio,
): Map<number, { j: number; n: number }> {
  const out = new Map<number, { j: number; n: number }>();
  kep.forEach((k, j) => {
    if (kepUsado.has(j)) return;
    const sueltos = rem.map((_, i) => i)
      .filter((i) => !remUsado.has(i) && !out.has(i) && (!fijo.has(i) || fijo.get(i)!.sku === k.sku))
      .slice(0, GRUPO_MAX_SUELTOS);
    if (sueltos.length < 2) return;
    const bf = bfDe(k.sku);
    const qty = sueltos.map((i) => cantidadPiezas(rem[i], bf));
    const imp = sueltos.map((i) => importeRemision(rem[i]));
    const hallados: number[][] = [];
    const elegir = (desde: number, tomados: number[]) => {
      if (hallados.length > 1) return; // ya es ambiguo
      if (tomados.length >= 2) {
        const q = tomados.reduce((s, x) => s + (qty[x] ?? NaN), 0);
        if (Math.abs(q - k.cantidad) / Math.max(Math.abs(k.cantidad), 1) <= QTY_TOL) {
          const is = tomados.map((x) => imp[x]);
          const ok = is.every((x) => x != null) && k.importe > 0
            ? importeCuadra(is.reduce((s: number, x) => s + (x as number), 0), k.importe, base)
            : true;
          if (ok) hallados.push([...tomados]);
        }
      }
      if (tomados.length === GRUPO_MAX) return;
      for (let x = desde; x < sueltos.length; x++) if (qty[x] != null) elegir(x + 1, [...tomados, x]);
    };
    elegir(0, []);
    if (hallados.length !== 1) return;
    for (const x of hallados[0]) out.set(sueltos[x], { j, n: hallados[0].length });
  });
  return out;
}

/** El importe de la remisión (en la base del documento) contra el de Kepler, ±`PRICE_TOL`. */
function importeCuadra(ri: number, kImporte: number, base: BasePrecio): boolean {
  const dentro = (x: number) => Math.abs(x - kImporte) / kImporte <= PRICE_TOL;
  return base === 'con_iva' ? dentro(ri / (1 + IVA)) || dentro(ri) : dentro(ri);
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
