/**
 * `[PQ.19]` D24 — **El factor de caja según la FICHA de Kepler (`md.kdii`) de un servidor.**
 *
 * Es la misma regla que `analytics.v_kepler_unit_ladder` (mig `20260915120000`), escrita en TS
 * para leerla en el servidor donde se va a escribir, no en el ODS:
 *
 *   Base c11 · Unidad Dos c80/c81 (costo c78) · Unidad Tres c83/c84 (costo c79) · costo base c77.
 *
 * - Factor efectivo de un peldaño: el capturado si es > 1; si no, `round(costo_peldaño / costo_base)`
 *   cuando eso es > 1. Un peldaño rotulado pero vacío NO es un peldaño.
 * - La caja es el peldaño de MAYOR factor (la escalera puede venir corrida: SKU 14030).
 * - Sin peldaños superiores rotulados → unidad única, factor 1. Rotulado sin factor ni costo →
 *   `null` (ignorancia, no una unidad).
 *
 * ⛔ Para qué existe: el traspaso viaja en unidad base (D24), así que la cantidad escrita es
 * `cajas × piezas_por_caja`. Si el factor de la Suite y el de la ficha del ORIGEN no coinciden,
 * el documento saldría con otra cantidad —el error de 50× de `[KR.6]`— viéndose perfecto en
 * pantalla. El adapter contrasta y rechaza.
 */
export interface FilaFichaKepler {
  c11?: unknown; c80?: unknown; c81?: unknown; c83?: unknown; c84?: unknown;
  c77?: unknown; c78?: unknown; c79?: unknown;
}

const rotulo = (v: unknown): string | null => {
  const s = String(v ?? '').trim().toUpperCase();
  return s ? s : null;
};

const numero = (v: unknown): number | null => {
  const s = String(v ?? '').replace(/[^0-9.]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const efectivo = (cap: number | null, costo: number | null, costoBase: number | null): number | null => {
  if (cap !== null && cap > 1) return cap;
  if (costoBase !== null && costoBase > 0 && costo !== null && costo > 0 && costo / costoBase > 1) return Math.round(costo / costoBase);
  return null;
};

/**
 * `[PQ.87]` Un peldaño que REPITE la base no es una caja: sin rótulo, o con el mismo rótulo que la
 * base, factor ≤ 1 y costo vacío o igual al de la base (±1 %). Kepler llena así la ficha de los
 * productos que se compran sueltos (15151 Lico: PAQ / PAQ ×1 $30.45 / PAQ ×1 $30.45).
 */
const repiteBase = (u: string | null, u1: string | null, cap: number | null, costo: number | null, c1: number | null): boolean =>
  u === null || (u === u1 && (cap ?? 0) <= 1 && (!costo || (c1 !== null && c1 > 0 && Math.abs(costo - c1) <= 0.01 * c1)));

/** Unidad base y factor de caja de la ficha. `factor: null` = la ficha no lo dice. */
export function factorFichaKepler(f: FilaFichaKepler): { unidad_base: string | null; factor: number | null } {
  const u1 = rotulo(f.c11), u2 = rotulo(f.c80), u3 = rotulo(f.c83);
  const c1 = numero(f.c77);
  const f2 = efectivo(numero(f.c81), numero(f.c78), c1);
  const f3 = efectivo(numero(f.c84), numero(f.c79), c1);
  let factor: number | null;
  if (f3 !== null && f3 >= (f2 ?? 0)) factor = f3;
  else if (f2 !== null) factor = f2;
  else if (u2 === null && u3 === null) factor = 1;
  else if (c1 !== null && c1 > 0
    && repiteBase(u2, u1, numero(f.c81), numero(f.c78), c1)
    && repiteBase(u3, u1, numero(f.c84), numero(f.c79), c1)) factor = 1;
  else factor = null;
  return { unidad_base: u1, factor };
}

/**
 * ⛔ `[PQ.87]` **La ficha de la sucursal donde se escribe manda sobre la caja de la Suite** (compra).
 * Si Kepler dice que el producto no tiene caja (factor 1) y la Suite lo pidió en cajas de N, el
 * costo de Kepler es por unidad y la Suite lo dividiría entre N: la OC 0000346 de Morelia Abastos
 * (2026-11-06) salió con el paquete de Lico a $0.76 contra $30.45 (÷40). Se rechaza nombrando los
 * SKU; no se adivina cuál de los dos tiene razón. Con caja 1 en los dos lados, el renglón va en la
 * unidad base de la ficha (`sinCaja`: sku → unidad), no en `CJA`, que esa ficha no tiene.
 * `[PQ.91]` Sin factor de la Suite cuenta como 1, igual que en la mesa (`GREATEST(COALESCE(bf, 1), 1)`).
 */
export function frenoFichaSinCaja(
  lineas: ReadonlyArray<{ sku: string; piezas_por_caja?: number | null }>,
  ficha: ReadonlyMap<string, { unidad_base: string | null; factor: number | null }>,
  sucursal: string,
): { motivo: string | null; sinCaja: Map<string, string> } {
  const ppc = (l: { piezas_por_caja?: number | null }): number => (Number(l.piezas_por_caja) > 0 ? Number(l.piezas_por_caja) : 1);
  const choca = lineas.filter((l) => ficha.get(l.sku)?.factor === 1 && ppc(l) > 1);
  if (choca.length) {
    const unidad = (sku: string): string => ficha.get(sku)?.unidad_base ?? 'unidad';
    return {
      motivo: `En Kepler (sucursal ${sucursal}) ${choca.slice(0, 5).map((l) => `${l.sku} se compra por ${unidad(l.sku)}`).join(', ')}${choca.length > 5 ? ` y ${choca.length - 5} más` : ''}, sin caja, y la Suite los pidió en cajas de ${[...new Set(choca.map(ppc))].join('/')}: el costo saldría dividido. No se escribe; vuelve a capturar esos renglones cuando la mesa los muestre por ${unidad(choca[0].sku)}.`,
      sinCaja: new Map(),
    };
  }
  const sinCaja = new Map<string, string>();
  for (const l of lineas) {
    const f = ficha.get(l.sku);
    if (f?.factor === 1 && f.unidad_base) sinCaja.set(l.sku, f.unidad_base);
  }
  return { motivo: null, sinCaja };
}

/**
 * `[COT.7]` Cuántas unidades base trae la presentación `rotuloPres` según la ficha: 1 si es la
 * base (`c11`), el factor efectivo de la Unidad Dos (`c80`) o de la Tres (`c83`) si el rótulo es
 * el suyo, y `null` si la ficha no declara esa presentación. Con la misma regla de factor efectivo
 * que `factorFichaKepler`. Ej. (01, 2026-11-03): 32008 `CJA` → 14 · 70500 `KG` → 2 · 44415 `PAQ` → 1.
 */
export function factorPresentacionFicha(f: FilaFichaKepler, rotuloPres: string | null | undefined): number | null {
  const p = rotulo(rotuloPres);
  if (p === null) return null;
  if (p === rotulo(f.c11)) return 1;
  const c1 = numero(f.c77);
  if (p === rotulo(f.c80)) return efectivo(numero(f.c81), numero(f.c78), c1);
  if (p === rotulo(f.c83)) return efectivo(numero(f.c84), numero(f.c79), c1);
  return null;
}
