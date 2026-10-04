/**
 * `[CAT-COSTO.4]` — **El costo estándar tiene que ser el mismo en todas las sucursales.**
 *
 * Contexto de Compras (2026-10-04): el costo estándar es el reflejo de la negociación con el
 * proveedor —su lista menos los descuentos acordados— y de él sale el precio de venta con el
 * margen. Un mismo producto con costo estándar distinto según la plaza es, casi siempre, una
 * ficha que alguien actualizó en una sucursal y no en las demás (CE midió que el 74 % de los
 * cambios de costo tocan UNA sola sucursal). La meta es cero diferencias.
 *
 * Este archivo es la REGLA, sin base de datos, para que se pueda probar sola. El servicio sólo
 * trae las fichas; quién se sale, cuál es la referencia y qué se declara lo decide esto.
 *
 * ── Por qué la referencia es la MAYORÍA y no el promedio ni el último cambio ─────────────────
 * Kepler no guarda cuándo se editó la ficha (la historia del costo estándar se reconstruye de la
 * venta, Etapa 2). Sin saber cuál se cambió al último, lo único defendible es el valor que
 * comparte la mayoría de las plazas. Un promedio inventaría un costo que ninguna ficha tiene.
 *
 * ── Lo que se DECLARA en vez de comparar ─────────────────────────────────────────────────────
 *  · `sin_mayoria` — dos o más valores empatan (p. ej. dos plazas, dos costos). Elegir uno sería
 *    afirmar cuál es el bueno sin evidencia.
 *  · `unidad_distinta` — la unidad base de la ficha no es la misma en todas las plazas. Comparar
 *    ahí daría diferencias falsas de ×20 (una plaza por pieza, otra por caja).
 *  · `una_plaza` — sólo una sucursal tiene ficha con costo: no hay con qué comparar.
 */

export type VeredictoEntreSucursales = 'distinto' | 'sin_mayoria' | 'unidad_distinta' | 'igual' | 'una_plaza';

/** Orden de la tabla: primero lo que hay que corregir, `igual` al final. */
export const ORDEN_VEREDICTO_SUCURSALES: VeredictoEntreSucursales[] = [
  'distinto',
  'sin_mayoria',
  'unidad_distinta',
  'igual',
  'una_plaza',
];

/** Tolerancia acordada con Compras: hasta 0.5 % se considera el mismo costo (redondeos). */
export const TOLERANCIA_ENTRE_SUCURSALES = 0.005;

export interface CeldaSucursal {
  sucursal: string;
  /** `kdii.c77` de esa plaza, por la unidad base de SU ficha. */
  costo: number;
  unidad: string | null;
  /** Vendió algo en la ventana de 30 días. */
  vende: boolean;
}

export interface CeldaClasificada extends CeldaSucursal {
  /** Se compara contra la mayoría. `false` si quedó fuera por el filtro de venta. */
  comparada: boolean;
  /** Se sale de la mayoría más allá de la tolerancia. `null` cuando no hay mayoría contra qué medir. */
  fuera: boolean | null;
  /** Desviación contra la mayoría, en %. `null` sin mayoría. */
  desviacion_pct: number | null;
}

export interface ResultadoEntreSucursales {
  veredicto: VeredictoEntreSucursales;
  /** El costo de la mayoría. `null` en `sin_mayoria`, `unidad_distinta` y `una_plaza`. */
  mayoria: number | null;
  /** Mayor desviación contra la mayoría; en `sin_mayoria`, la brecha entre el más caro y el más barato. */
  diferencia_pct: number | null;
  /** Sucursales que se salen de la mayoría. */
  sucursales_fuera: string[];
  celdas: CeldaClasificada[];
}

const redondea = (n: number) => Math.round(n * 100) / 100;

export function clasificarEntreSucursales(
  celdas: CeldaSucursal[],
  opts: { tolerancia?: number; soloConVenta?: boolean } = {},
): ResultadoEntreSucursales {
  const tol = opts.tolerancia ?? TOLERANCIA_ENTRE_SUCURSALES;
  const validas = celdas.filter((c) => Number.isFinite(c.costo) && c.costo > 0);
  const comparadas = opts.soloConVenta ? validas.filter((c) => c.vende) : validas;
  const seCompara = new Set(comparadas.map((c) => c.sucursal));
  const sinMedir = (): CeldaClasificada[] =>
    validas.map((c) => ({ ...c, comparada: seCompara.has(c.sucursal), fuera: null, desviacion_pct: null }));

  if (comparadas.length < 2) {
    return { veredicto: 'una_plaza', mayoria: null, diferencia_pct: null, sucursales_fuera: [], celdas: sinMedir() };
  }

  // Una ficha sin rótulo de unidad cuenta como unidad distinta: no se sabe en qué viene.
  const unidades = new Set(comparadas.map((c) => (c.unidad ?? '').trim().toUpperCase()));
  if (unidades.size > 1) {
    return { veredicto: 'unidad_distinta', mayoria: null, diferencia_pct: null, sucursales_fuera: [], celdas: sinMedir() };
  }

  const cuenta = new Map<number, number>();
  for (const c of comparadas) {
    const v = redondea(c.costo);
    cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  }
  const max = Math.max(...cuenta.values());
  const empatados = [...cuenta.entries()].filter(([, k]) => k === max).map(([v]) => v);

  if (empatados.length > 1) {
    const costos = comparadas.map((c) => c.costo);
    const brecha = (Math.max(...costos) / Math.min(...costos) - 1) * 100;
    return {
      veredicto: 'sin_mayoria',
      mayoria: null,
      diferencia_pct: redondea(brecha),
      sucursales_fuera: [],
      celdas: sinMedir(),
    };
  }

  const mayoria = empatados[0];
  const clasificadas: CeldaClasificada[] = validas.map((c) => {
    if (!seCompara.has(c.sucursal)) return { ...c, comparada: false, fuera: null, desviacion_pct: null };
    const dev = c.costo / mayoria - 1;
    return { ...c, comparada: true, fuera: Math.abs(dev) > tol, desviacion_pct: redondea(dev * 100) };
  });
  const fuera = clasificadas.filter((c) => c.fuera).map((c) => c.sucursal);
  const diferencia = Math.max(...clasificadas.filter((c) => c.comparada).map((c) => Math.abs(c.desviacion_pct ?? 0)));

  return {
    veredicto: fuera.length > 0 ? 'distinto' : 'igual',
    mayoria,
    diferencia_pct: diferencia,
    sucursales_fuera: fuera,
    celdas: clasificadas,
  };
}
