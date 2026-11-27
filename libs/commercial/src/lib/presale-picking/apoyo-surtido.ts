/**
 * `[GP.RF.33][GP.RF.34]` Lo que el surtidor necesita de cada renglón para escanear y para caminar, sin
 * base de datos (el servicio trae los hechos): las presentaciones del producto con sus códigos de Kepler
 * y el lugar del producto en el almacén. Decisión de Edgar (2026-11-17): Surtir muestra la ubicación,
 * ordena por recorrido y al escanear marca Completo.
 */

import {
  ordenDeRecorrido,
  ubicacionDe as ubicacionGanadora,
  type UbicacionDelProducto,
} from '../warehouse-locations/ubicacion-del-producto';

/**
 * Una asignación viva de Ubicaciones (`commercial.bin_assignments` + `warehouse_bins`).
 *
 * ⭐ `[ICR.0.2]` La regla de **cuál gana** ya no vive acá: se mudó a
 * `warehouse-locations/ubicacion-del-producto.ts`, que es el módulo dueño del catálogo, porque el
 * inventario físico la necesitaba igual y la había vuelto a escribir (ADR-056). Acá queda la forma
 * que el surtido pide — el código y el orden del recorrido, nada más.
 */
export interface AsignacionDeSurtido extends UbicacionDelProducto {
  product_id: string;
  presentacion_rotulo: string | null;
  papel: string;
  code: string;
  pick_sequence: number | string | null;
}

/**
 * El lugar donde se va a buscar el renglón. Entre las asignaciones del producto gana el papel (lugar
 * fijo antes que tienda o reserva) y, en el mismo papel, la de la presentación pedida. `null` = el
 * producto no tiene ubicación en ese almacén: se dice así, no se inventa una.
 *
 * ⭐ `descartarPapelDesconocido` es de **este** oficio y por eso se dice acá: un papel que este
 * código no conoce bien podría ser cuarentena o merma, y mandar al surtidor ahí sería sacar
 * mercancía que no debe salir. Entre equivocarse y no ir, no ir. ⚠️ El inventario físico usa el
 * mismo primitivo con la respuesta CONTRARIA, a propósito: lo que está en cuarentena hay que
 * contarlo. Hoy la diferencia no se puede ejercer (`ck_bin_assignments_papel` admite tres valores),
 * pero las dos pruebas negativas la fijan para el día que UB agregue uno.
 */
export function ubicacionDe(
  asignaciones: readonly AsignacionDeSurtido[],
  productId: string,
  unidad: string | null,
): { code: string; orden: number | null } | null {
  const a = ubicacionGanadora(asignaciones, productId, {
    unidad,
    descartarPapelDesconocido: true,
  });
  return a ? { code: a.code, orden: ordenDeRecorrido(a) } : null;
}

/** Las presentaciones con rótulo y al menos un código: lo único útil para reconocer un escaneo. */
export function presentacionesConCodigo(
  presentaciones: ReadonlyArray<{ rotulo: string | null; codigos: string[] }> | undefined,
): Array<{ unit: string; codigos: string[] }> {
  return (presentaciones ?? [])
    .filter((p) => (p.rotulo ?? '').trim() && p.codigos.length)
    .map((p) => ({ unit: (p.rotulo as string).trim().toUpperCase(), codigos: [...p.codigos] }));
}
