/**
 * Cantidades del pedido EN LA PRESENTACION QUE ELIGE EL VENDEDOR.
 *
 * La linea del pedido se guarda SIEMPRE en unidad base; la presentacion (pieza /
 * paquete / caja) es capa de captura. Eso obliga a una sola invariante, y es la
 * razon de ser de este archivo:
 *
 *    lo que el vendedor VE  x  factor  =  lo que el pedido PIDE
 *
 * Antes se rompia: la fila mostraba Math.round(base / factor). Medido contra prod
 * (analytics.product_units, 8,928 SKU): 393 arrancan con una presentacion de
 * factor > 1, y la cantidad inicial sale del promedio historico del cliente, que
 * casi nunca es multiplo del factor. Consecuencias reales, todas reportadas como
 * "bugs al agregar al carrito":
 *
 *   - promedio 5 piezas con paquete de 6  ->  la fila mostraba 1 y pedia 5
 *   - promedio 3 piezas con caja de 8     ->  la fila mostraba 0 con la linea creada
 *   - "+" y luego "-" no volvian al punto de partida (la base no caia en la rejilla)
 *   - teclear el MISMO numero que ya se veia cambiaba la cantidad (se multiplicaba)
 *
 * La regla aca es simple: toda cantidad que nace o se toca desde la fila cae en la
 * REJILLA del factor activo. Y lo que llega de afuera fuera de rejilla (voz, canasta
 * predicha, pedido viejo, otro dispositivo) NO se redondea ni se corrige solo: se
 * DECLARA en unidad base (ADR-056 -- lo que no cuadra se declara, no se dibuja).
 */

/** Una presentacion de venta: el rotulo que ve el vendedor y cuantas unidades base trae. */
export interface Presentacion {
  unit: string;
  factor: number;
}

/**
 * Normaliza la escalera de medidas que manda el catalogo.
 *
 * Dos saneos distintos, porque son dos problemas distintos:
 *
 *  - Rotulo repetido con el MISMO factor = es la misma presentacion contada dos
 *    veces. Se colapsa. Medido en prod: 2,061 de 8,928 SKU (23.1%) traen
 *    unit_alt1 = unit_base, y 163 traen los tres peldanos con el mismo rotulo.
 *    Sin colapsar, el selector pintaba 2 o 3 chips identicos, se marcaban todos
 *    como activos a la vez (la comparacion es por rotulo) y el @for de la
 *    plantilla quedaba con clave duplicada.
 *
 *  - Rotulo repetido con factor DISTINTO = contradiccion real de la fuente, no
 *    ruido. Medido: 1 SKU donde PAQ vale 1 y 11 a la vez. Ahi NO se elige uno en
 *    silencio (esconderia media escalera): se desambigua el rotulo con su factor
 *    para que la ambiguedad se vea y se pueda elegir.
 */
export function escalera(units: readonly Presentacion[] | null | undefined): Presentacion[] {
  if (!units?.length) return [];
  const usables = units.filter((u) => !!u?.unit && Number.isFinite(Number(u.factor)) && Number(u.factor) > 0);
  const porRotulo = new Map<string, Set<number>>();
  for (const u of usables) {
    const s = porRotulo.get(u.unit) ?? new Set<number>();
    s.add(Number(u.factor));
    porRotulo.set(u.unit, s);
  }
  const out: Presentacion[] = [];
  const vistos = new Set<string>();
  for (const u of usables) {
    const factor = Number(u.factor);
    const ambiguo = (porRotulo.get(u.unit)?.size ?? 0) > 1;
    const rotulo = ambiguo && factor > 1 ? `${u.unit} x${factor}` : u.unit;
    const clave = `${rotulo}|${ambiguo ? factor : ''}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({ unit: rotulo, factor });
  }
  return out;
}

/** Ofrecer el selector solo si quedan DOS presentaciones distintas de verdad. */
export function hayEleccion(units: readonly Presentacion[] | null | undefined): boolean {
  return escalera(units).length > 1;
}

/** Factor usable: nunca 0, nunca negativo, nunca NaN. Sin presentacion, 1. */
export function factorDe(p: Presentacion | null | undefined): number {
  const f = Math.floor(Number(p?.factor));
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/**
 * Conteo EXACTO en la presentacion activa, o null si la cantidad base no cae en
 * la rejilla. null no es "cero": es "esta cantidad no se puede expresar en esta
 * presentacion sin mentir" -- quien lo consume debe mostrar la unidad base.
 */
export function conteoExacto(base: number, factor: number): number | null {
  const b = Math.max(0, Math.floor(Number(base) || 0));
  const f = Math.max(1, Math.floor(Number(factor) || 1));
  if (b % f !== 0) return null;
  return b / f;
}

/** Sube un escalon completo desde donde este la cantidad (aunque venga fuera de rejilla). */
export function subirEscalon(base: number, factor: number): number {
  const b = Math.max(0, Math.floor(Number(base) || 0));
  const f = Math.max(1, Math.floor(Number(factor) || 1));
  return (Math.floor(b / f) + 1) * f;
}

/** Baja un escalon completo. Desde fuera de rejilla, baja al escalon inmediato inferior. */
export function bajarEscalon(base: number, factor: number): number {
  const b = Math.max(0, Math.floor(Number(base) || 0));
  const f = Math.max(1, Math.floor(Number(factor) || 1));
  if (b <= 0) return 0;
  const piso = Math.floor(b / f) * f;
  return piso === b ? Math.max(0, b - f) : piso;
}

/**
 * Lleva una cantidad a la rejilla del factor, hacia ARRIBA y con al menos un
 * escalon completo, respetando el minimo de compra (que viene en unidad base).
 * Es lo que convierte un promedio historico de 5 piezas en 1 paquete de 6.
 */
export function ajustarARejilla(base: number, factor: number, minimoBase = 1): number {
  const f = Math.max(1, Math.floor(Number(factor) || 1));
  const min = Math.max(1, Math.floor(Number(minimoBase) || 1));
  const b = Math.max(Math.floor(Number(base) || 0), min);
  return Math.max(1, Math.ceil(b / f)) * f;
}
