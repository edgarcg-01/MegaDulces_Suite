/**
 * Una cantidad en la unidad base dicha en las unidades del producto, de la mayor a la menor:
 * 1,305 PAQ con CJA = 20 → 65 CJA 5 PAQ. Lo que sobra queda en la unidad menor y puede traer
 * decimales (Kepler los guarda: 606.9 PAQ → 30 CJA 6.9 PAQ). Función pura, sin Angular.
 *
 * - 0 o no finito → [] (quien pinta decide cómo decir «nada»; aquí no se inventa un «0 CJA»).
 * - Negativo (Kepler llega a tener existencia negativa) → la cifra tal cual en la unidad menor:
 *   partir un negativo en cajas no significa nada y esconderlo sería mentir.
 * - Unidades con factor no positivo o repetido se ignoran.
 */
export interface UnidadFactor {
  unidad: string;
  factorBase: number;
}

export interface CantidadEnUnidad {
  cantidad: number;
  unidad: string;
}

/** Tres decimales: los de Kepler; evita el 6.899999 de la resta en coma flotante. */
const redondeo = (v: number) => Math.round(v * 1000) / 1000;

export function componerEnUnidades(cantidadBase: number, unidades: UnidadFactor[]): CantidadEnUnidad[] {
  if (!Number.isFinite(cantidadBase) || cantidadBase === 0) return [];
  const vistos = new Set<number>();
  const orden = unidades
    .filter((u) => u && u.unidad && Number.isFinite(u.factorBase) && u.factorBase > 0)
    .sort((a, b) => b.factorBase - a.factorBase)
    .filter((u) => (vistos.has(u.factorBase) ? false : (vistos.add(u.factorBase), true)));
  if (!orden.length) return [];
  const menor = orden[orden.length - 1];
  if (cantidadBase < 0) return [{ cantidad: redondeo(cantidadBase / menor.factorBase), unidad: menor.unidad }];

  let resto = redondeo(cantidadBase);
  const partes: CantidadEnUnidad[] = [];
  for (const u of orden) {
    const esMenor = u === menor;
    const n = esMenor ? redondeo(resto / u.factorBase) : Math.floor(resto / u.factorBase + 1e-9);
    if (n > 0) partes.push({ cantidad: n, unidad: u.unidad });
    resto = esMenor ? 0 : redondeo(resto - n * u.factorBase);
  }
  return partes;
}
