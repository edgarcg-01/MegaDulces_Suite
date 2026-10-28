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

/** Unidad base y factor de caja de la ficha. `factor: null` = la ficha no lo dice. */
export function factorFichaKepler(f: FilaFichaKepler): { unidad_base: string | null; factor: number | null } {
  const u1 = rotulo(f.c11), u2 = rotulo(f.c80), u3 = rotulo(f.c83);
  const c1 = numero(f.c77);
  const f2 = efectivo(numero(f.c81), numero(f.c78), c1);
  const f3 = efectivo(numero(f.c84), numero(f.c79), c1);
  let factor: number | null;
  if (f3 !== null && f3 >= (f2 ?? 0)) factor = f3;
  else if (f2 !== null) factor = f2;
  else factor = u2 === null && u3 === null ? 1 : null;
  return { unidad_base: u1, factor };
}
