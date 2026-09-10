/**
 * Orden CANÓNICO de presentación de las tiendas/almacenes (pedido de negocio 2026-09-10 para
 * `/compras/pedido`): PH · MA · MM · 8ESQ · LPA · YUR · CAN · Zamora Centro · CEDIS (BPIRAPUATO).
 *
 * Es orden de PANTALLA, no de datos: no cambia ningún cálculo, sólo en qué secuencia aparecen
 * columnas, filas agrupadas y opciones de filtro. Vive acá (contrato compartido) para que el
 * backend (columnas/filtros que arma el server) y el frontend (sorts locales) lean la MISMA lista;
 * antes cada uno ordenaba por `code` alfabético y salía 00,01,02,…,MD-30, que no es como el
 * negocio piensa la red.
 *
 * Una tienda tiene más de un código según el sistema que la nombra (Kepler '01'/'07', Wincaja
 * 'MD-30'/'MD-32', finanzas 'MD-10'…): todos los alias de la misma plaza comparten rango.
 * Código desconocido → va DESPUÉS de los conocidos, alfabético, para que nada se pierda.
 * Dato chico (una decena de strings): puede vivir en el barrel sin pegarle al bundle inicial.
 */
export const WAREHOUSE_DISPLAY_ORDER: ReadonlyArray<{ label: string; codes: ReadonlyArray<string> }> = Object.freeze([
  { label: 'PH',            codes: ['01', 'MD-10'] },
  { label: 'MA',            codes: ['MD-30', '30'] },
  { label: 'MM',            codes: ['MD-32', '32', '07'] },
  { label: '8ESQ',          codes: ['03', 'MD-40'] },
  { label: 'LPA',           codes: ['02', 'MD-42'] },
  { label: 'YUR',           codes: ['04', 'MD-44'] },
  { label: 'CAN',           codes: ['06', 'MD-50', '50'] },
  { label: 'ZAMORA CENTRO', codes: ['05', 'MD-54'] },
  { label: 'CEDIS',         codes: ['00', 'MD-00'] },
]);

// Bucles simples a propósito (sin flatMap/spread): este archivo lo compilan tres targets distintos.
const RANK = new Map<string, number>();
WAREHOUSE_DISPLAY_ORDER.forEach((g, i) => { g.codes.forEach((c) => RANK.set(c, i)); });

/** Rango de presentación del código (0 = primero). Desconocido → `WAREHOUSE_DISPLAY_ORDER.length`. */
export function warehouseDisplayRank(code: string | null | undefined): number {
  const c = String(code ?? '').trim().toUpperCase();
  return RANK.get(c) ?? WAREHOUSE_DISPLAY_ORDER.length;
}

/** Comparador para `Array.prototype.sort`: orden canónico; los desconocidos al final, alfabético. */
export function compareWarehouseCodes(a: string | null | undefined, b: string | null | undefined): number {
  const ra = warehouseDisplayRank(a), rb = warehouseDisplayRank(b);
  if (ra !== rb) return ra - rb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}
