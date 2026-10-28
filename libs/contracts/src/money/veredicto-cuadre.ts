/**
 * `[MX.1.2]` — **Veredicto de un cuadre en TRES estados: cuadra · difiere · sin datos** (Fase MX;
 * ADR-056: lo que no se midió se declara, nunca se dibuja como bueno).
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * El Cuadre de traspasos (`/almacen/movimientos`) y su PDF decidían «cuadra» con
 * `Math.abs(Number(delta) || 0) < tolerancia`. Un lente vacío —sin balanza 515 en el rango, sin
 * Wincaja, un mes sin movimiento— daba delta 0 y salía «cuadra» en verde: lo que no se midió se
 * pintaba como bueno. Reportado por Edgar el 2026-10-28 («si en los dos viene vacío, saldrá
 * positivo»). La regla vivía copiada en la pantalla y en el PDF; aquí vive una vez.
 *
 * ── Reglas ─────────────────────────────────────────────────────────────────────────────────
 *  · Delta no numérico (null, '', NaN) → `sin_datos`.
 *  · Base vacía o cero con delta 0 → `sin_datos`: no hubo nada que cuadrar.
 *  · Base vacía o cero con delta ≠ 0 → `difiere`: hay dinero de un solo lado.
 *  · Si no, la tolerancia del lente decide `cuadra` o `difiere`.
 */
export type VeredictoCuadre = 'cuadra' | 'difiere' | 'sin_datos';

/** Tolerancia de un lente: recibe |Δ| y |base|, ambos finitos y la base > 0. */
export type ToleranciaCuadre = (delta: number, base: number) => boolean;

/** Mayor 515 «Ajuste traspasos internos»: |Δ| < $1 o < 0.1 % de la entrada del periodo. */
export const TOLERANCIA_MAYOR_515: ToleranciaCuadre = (d, b) => d < 1 || d < b * 0.001;

/** Kepler → Wincaja (valuación distinta): |Δ| < $500 o < 2 % de lo despachado. */
export const TOLERANCIA_KEPLER_WINCAJA: ToleranciaCuadre = (d, b) => d < 500 || d < b * 0.02;

const numero = (v: unknown): number => (v == null || v === '' ? NaN : Math.abs(Number(v)));

export function veredictoCuadre(delta: unknown, base: unknown, tolera: ToleranciaCuadre): VeredictoCuadre {
  const d = numero(delta);
  const b = numero(base);
  if (!Number.isFinite(d)) return 'sin_datos';
  if (!Number.isFinite(b) || b === 0) return d === 0 ? 'sin_datos' : 'difiere';
  return tolera(d, b) ? 'cuadra' : 'difiere';
}
