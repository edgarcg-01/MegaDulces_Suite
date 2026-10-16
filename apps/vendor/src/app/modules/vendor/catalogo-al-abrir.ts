/**
 * `[VTK.11]` Abrir un cliente con el catálogo que el celular YA tiene, y refrescarlo detrás.
 *
 * El catálogo de la toma de pedido es el mismo para todos los clientes de una lista de precios y
 * una sucursal, y se bajaba COMPLETO en cada cliente (9,429 productos, ~1.2 MB comprimido; medido
 * el 2026-10-15: 13.7–18.1 s por apertura en prod). El celular ya lo guardaba en su base local
 * para el modo sin conexión (`VendorCatalogCache`), pero con red no se usaba.
 *
 * Reglas:
 *  - Se abre con la copia si es de la MISMA sucursal (la existencia cambia por almacén) y no
 *    tiene más de un día. Más vieja, se espera la descarga como antes.
 *  - Si la copia tiene más de `CATALOGO_FRESCO_MS`, se baja la nueva detrás y se reemplaza.
 *  - La edad de lo que se ve se dice en pantalla (ADR-056): nunca se presenta como de este momento.
 *  - Lo que se COBRA no sale de aquí: el renglón lo tarifa el servidor al agregarlo.
 */
export type OrigenCatalogo = 'memoria' | 'telefono' | 'servidor';

/** Una copia que se puede servir mientras llega la nueva. Menos de esto, ni se refresca. */
export const CATALOGO_FRESCO_MS = 2 * 60_000;
/** Más vieja que esto, no se muestra: se espera la descarga. */
export const CATALOGO_MAX_EDAD_MS = 24 * 60 * 60_000;

/** ¿Sirve esta copia para abrir? Misma sucursal y con menos de un día. */
export function sirveCopia(
  copia: { warehouseId: string; at: number } | null | undefined,
  warehouseId: string,
  ahora: number,
): boolean {
  if (!copia || !Number.isFinite(copia.at)) return false;
  if ((copia.warehouseId || '') !== (warehouseId || '')) return false;
  const edad = ahora - copia.at;
  return edad >= 0 && edad < CATALOGO_MAX_EDAD_MS;
}

/** ¿Hay que bajar el catálogo nuevo detrás? Sólo si lo que se mostró es copia y ya no es fresca. */
export function hayQueRefrescar(origen: OrigenCatalogo, at: number, ahora: number): boolean {
  if (origen === 'servidor') return false;
  return !(ahora - at < CATALOGO_FRESCO_MS);
}

/** «hace 4 min», «hace 3 h». Lo de menos de un minuto es «hace un momento». */
export function edadCatalogo(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.floor(min / 60)} h`;
}
