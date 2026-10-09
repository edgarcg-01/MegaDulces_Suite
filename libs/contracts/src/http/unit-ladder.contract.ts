/**
 * La ESCALERA de unidades de un artículo (pieza → paquete → caja) y cómo se escribe una cantidad
 * en ella. Funciones PURAS: las usan la pantalla de Pedido (`/compras/pedido`, RA-PRO.70), la de
 * Productos nuevos (`[NP.16]`) y el servidor, para que las tres partan la misma cantidad igual.
 *
 * `[NP.16]` La regla vivía en `apps/view/.../pedido-redondeo.ts`; se movió aquí sin cambiarla
 * cuando el servidor también la necesitó (ADR-056: un primitivo no se copia, se comparte).
 */

/** `[RA-PRO.70]` Una unidad real del artículo: su abreviatura, su nombre y cuántas unidades BASE trae. */
export interface UnidadEscalera {
  abr: string;
  nombre: string;
  factor: number;
  /** `[NP.16]` El rótulo tal como lo escribe Kepler (`PZA`, `PAQ`, `CJA`, `500`…). */
  rotulo?: string;
}

const ABR: Record<string, string> = {
  PZA: 'pz', PAQ: 'paq', KG: 'kg', CJA: 'cj', CAJA: 'cj', BTO: 'bto', BULTO: 'bto', CUB: 'cub', CUBETA: 'cub',
};
const NOMBRE: Record<string, string> = {
  pz: 'Pieza', paq: 'Paquete', kg: 'Kilo', cj: 'Caja', bto: 'Bulto', cub: 'Cubeta', 'u.': 'Unidad',
};

/** Abreviatura de un rótulo de Kepler. Un GRAMAJE (`500`, `250`) es "u." (UNIDADES_DE_MEDIDA §7.6). */
function abrDe(raw: string): string {
  if (!raw) return '';
  if (/^[\d.]+$/.test(raw)) return 'u.';
  return ABR[raw] ?? raw.toLowerCase();
}

/**
 * `[RA-PRO.70]` La escalera REAL de unidades del artículo, de menor a mayor: 1, 2 o 3 unidades.
 *
 * Kepler RELLENA los tres peldaños aunque el artículo no los tenga: repite el rótulo con factor 1
 * (`70001` mazapán = PAQ ×1 · PAQ ×1 · CJA ×20; `17063` rollo = KG · KG · KG). Leer sólo los
 * rótulos daba botones "kg | kg" o una "cj" que no existe (`57009` cubeta). La regla: hay una
 * unidad por cada peldaño donde el FACTOR crece (≥ 1.5× el anterior), con el factor que se deriva
 * del costo por peldaño (`f2`, `f3`, contra la base).
 *
 * Medido en prod el 2026-10-03 sobre 6,291 artículos del plan: 604 con 1 unidad, 5,313 con 2 y
 * 374 con 3. La unidad MAYOR siempre trae el factor del motor (`uxc`), que es el que convierte el
 * pedido: en 22 artículos el peldaño de Kepler no coincide y manda `uxc`.
 *
 * Sin factores (feed viejo) cae a los rótulos + la etiquetera, como antes.
 */
export function escaleraUnidades(o: {
  u1?: string | null; u2?: string | null; u3?: string | null;
  f2?: number | string | null; f3?: number | string | null;
  uxc?: number | null; boxSize?: number | null; packSize?: number | null;
}): UnidadEscalera[] {
  const up = (s: string | null | undefined) => (s || '').trim().toUpperCase();
  const u1 = up(o.u1), u2 = up(o.u2), u3 = up(o.u3);
  const uxc = Number(o.uxc) > 0 ? Number(o.uxc) : 1;
  const mk = (raw: string, factor: number): UnidadEscalera => {
    const abr = abrDe(raw) || (factor === 1 ? 'pz' : 'cj');
    return { abr, nombre: NOMBRE[abr] ?? raw, factor, rotulo: raw };
  };
  const base = mk(u1, 1);
  if (uxc <= 1) return [base];   // una sola unidad: el pedido se cuenta en la base

  const f2 = Number(o.f2), f3 = Number(o.f3);
  const tieneFactores = Number.isFinite(f2) && f2 > 0 || Number.isFinite(f3) && f3 > 0;
  const cerca = (a: number, b: number) => Math.abs(a - b) <= 0.02 * Math.max(a, b);
  const real2 = !!u2 && Number.isFinite(f2) && f2 >= 1.5;
  const real3 = !!u3 && Number.isFinite(f3) && f3 >= 1.5 && (!real2 || f3 / f2 >= 1.5);

  // La mayor: el peldaño cuyo factor coincide con el del motor; si ninguno, el rótulo más alto.
  let mayorRaw = '';
  if (real3 && cerca(f3, uxc)) mayorRaw = u3;
  else if (real2 && cerca(f2, uxc)) mayorRaw = u2;
  else mayorRaw = [u3, u2].find((u) => u && u !== u1) || 'CJA';
  let mayor = mk(mayorRaw, uxc);
  // Kepler a veces rotula base y mayor igual con factor distinto (89106: PAQ ×1 y PAQ ×24, medido
  // 2026-10-03 en 3 artículos). Dos botones "paq | paq" no se distinguen: la mayor lleva su tamaño.
  if (mayor.abr === base.abr) mayor = { ...mayor, abr: mayor.abr + '×' + uxc, nombre: mayor.nombre + ' de ' + uxc };

  // El del medio: el peldaño 2 cuando es real, no es la mayor, cabe exacto en la caja y su rótulo
  // no repite el de la base (20323 trae PAQ/PAQ: "1 paq 3 paq" no se lee como nada).
  let medio: UnidadEscalera | null = null;
  if (tieneFactores) {
    const m = Math.round(f2);
    if (real2 && mayorRaw !== u2 && m > 1 && m < uxc && cerca(uxc / m, Math.round(uxc / m)) && u2 !== u1) medio = mk(u2, m);
  } else {
    // Feed viejo: la etiquetera (pack que cabe exacto en la caja y caja = factor del motor).
    const pack = Number(o.packSize), box = Number(o.boxSize);
    if (u3 && u2 && u2 !== u1 && pack > 1 && pack < uxc && uxc % pack === 0 && box === uxc) medio = mk(u2, pack);
  }
  return medio ? [base, medio, mayor] : [base, mayor];
}

/**
 * `[NP.16]` Cuántas unidades BASE trae un rótulo de Kepler en esta escalera: `PAQ` → 10.
 * NULL si el rótulo no está en la escalera, o si dos peldaños lo comparten (`PAQ ×1` y `PAQ ×24`):
 * ahí no se sabe cuál de los dos registró el documento, y adivinar es inventar la cantidad.
 */
export function factorDeRotulo(rotulo: string | null | undefined, esc: ReadonlyArray<UnidadEscalera>): number | null {
  const r = (rotulo ?? '').trim().toUpperCase();
  if (!r) return null;
  let cand = esc.filter((e) => (e.rotulo ?? '').toUpperCase() === r);
  // `CAJA` y `CJA` son la misma unidad: se busca por abreviatura sólo si el rótulo exacto no está.
  if (!cand.length) cand = esc.filter((e) => e.abr.split('×')[0] === abrDe(r));
  return cand.length === 1 ? cand[0].factor : null;
}

/** `[NP.16]` Una cantidad en un peldaño de la escalera, con el rótulo de Kepler de ese peldaño. */
export interface CantidadEnRotulo {
  rotulo: string;
  cantidad: number;
}

/**
 * `[NP.16]` Cantidades por rótulo de Kepler (`{ PAQ: 178, PZA: 2 }`) escritas en la escalera del
 * artículo, de la mayor a la base: con caja de 60 y paquete de 10 son 29 cajas, 7 paquetes y 2
 * piezas. Las cajas y paquetes van ENTEROS; la base lleva el resto (con decimales si es kilo).
 *
 * Lo que no se puede convertir (un rótulo fuera de la escalera o ambiguo) se devuelve aparte en
 * `sin_convertir`, tal cual: no se suma a nada. Devuelve NULL si no hay nada que convertir o si el
 * total no es positivo (una devolución neta no se parte en cajas).
 */
export function componerEnEscalera(
  cantidades: Readonly<Record<string, number>> | null | undefined,
  esc: ReadonlyArray<UnidadEscalera> | null | undefined,
): { partes: CantidadEnRotulo[]; sin_convertir: Record<string, number> } | null {
  if (!esc?.length) return null;
  let total = 0;
  let convertidas = 0;
  const sin: Record<string, number> = {};
  for (const [rot, q] of Object.entries(cantidades ?? {})) {
    if (!Number.isFinite(q) || Math.abs(q) < 0.0005) continue;
    const f = factorDeRotulo(rot, esc);
    if (f === null) { sin[rot] = q; continue; }
    total += q * f;
    convertidas += 1;
  }
  total = Math.round(total * 1000) / 1000;
  if (!convertidas || total <= 0) return null;
  const partes: CantidadEnRotulo[] = [];
  // De la mayor hacia abajo; la base (índice 0) se lleva el resto.
  for (let i = esc.length - 1; i >= 1; i--) {
    // El épsilon evita que 59.999999 cuente como 0 cajas por el redondeo del flotante.
    const n = Math.floor(total / esc[i].factor + 1e-9);
    if (n > 0) partes.push({ rotulo: esc[i].rotulo ?? esc[i].abr, cantidad: n });
    total = Math.round((total - n * esc[i].factor) * 1000) / 1000;
  }
  if (total > 0) partes.push({ rotulo: esc[0].rotulo ?? esc[0].abr, cantidad: total });
  return { partes, sin_convertir: sin };
}
