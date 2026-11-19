/**
 * `[GP.RF.33][GP.RF.34]` Lo que el surtidor necesita de cada renglón para escanear y para caminar, sin
 * base de datos (el servicio trae los hechos): las presentaciones del producto con sus códigos de Kepler
 * y el lugar del producto en el almacén. Decisión de Edgar (2026-11-17): Surtir muestra la ubicación,
 * ordena por recorrido y al escanear marca Completo.
 */

/** Una asignación viva de Ubicaciones (`commercial.bin_assignments` + `warehouse_bins`). */
export interface AsignacionDeSurtido {
  product_id: string;
  presentacion_rotulo: string | null;
  papel: string;
  code: string;
  pick_sequence: number | string | null;
}

/** Dónde se surte primero: el lugar fijo; si no hay, la exhibición de tienda; al final, la reserva. */
const ORDEN_PAPEL: Record<string, number> = { surtido_fijo: 0, exhibicion_tienda: 1, reserva_preferida: 2 };

/**
 * El lugar donde se va a buscar el renglón. Entre las asignaciones del producto gana el papel (lugar
 * fijo antes que tienda o reserva) y, en el mismo papel, la de la presentación pedida. `null` = el
 * producto no tiene ubicación en ese almacén: se dice así, no se inventa una.
 */
export function ubicacionDe(
  asignaciones: readonly AsignacionDeSurtido[],
  productId: string,
  unidad: string | null,
): { code: string; orden: number | null } | null {
  const u = (unidad ?? '').trim().toUpperCase();
  const delProducto = asignaciones
    .filter((a) => a.product_id === productId && a.papel in ORDEN_PAPEL)
    .sort((a, b) =>
      ORDEN_PAPEL[a.papel] - ORDEN_PAPEL[b.papel] ||
      Number((b.presentacion_rotulo ?? '').trim().toUpperCase() === u) - Number((a.presentacion_rotulo ?? '').trim().toUpperCase() === u),
    );
  const a = delProducto[0];
  if (!a) return null;
  const orden = a.pick_sequence == null || a.pick_sequence === '' ? null : Number(a.pick_sequence);
  return { code: a.code, orden: Number.isFinite(orden) ? orden : null };
}

/** Las presentaciones con rótulo y al menos un código: lo único útil para reconocer un escaneo. */
export function presentacionesConCodigo(
  presentaciones: ReadonlyArray<{ rotulo: string | null; codigos: string[] }> | undefined,
): Array<{ unit: string; codigos: string[] }> {
  return (presentaciones ?? [])
    .filter((p) => (p.rotulo ?? '').trim() && p.codigos.length)
    .map((p) => ({ unit: (p.rotulo as string).trim().toUpperCase(), codigos: [...p.codigos] }));
}
