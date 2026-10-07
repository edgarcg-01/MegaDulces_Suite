/**
 * `[GX.65.3]` — **Lo que «Mis gastos» necesita de Kepler para sus 3 columnas**, además de la
 * etapa: el **proveedor** por su clave y los **gastos `XA1001`** que nacieron de cada solicitud.
 *
 * ## El proveedor: la clave, no el nombre libre
 * Decisión del usuario: «por el código de proveedor — para hacer un gasto tienes que, a
 * fuerzas, en Kepler partir de un proveedor». Es `kdm1.c10`, publicado como
 * `analytics.expense_requests.cuenta_clave` (100% poblada) con su nombre canónico `acreedor`
 * del catálogo `kdxd`. El nombre libre (`c32`) tiene 367 variantes para 337 claves.
 *
 * ## Los gastos: una LISTA
 * Medido en `[GX.15]`: 8,705 solicitudes tienen 1 gasto, 165 tienen 2, 10 tienen 3 y 2 tienen
 * 4. El puente es `c39` (`analytics.expense_documents.solicitud_folio`), el mismo que usa el
 * Expediente desde `[GX.62]`.
 *
 * ⚠️ Esto es DATO, no decisión: que exista un `XA1001` ya no mueve el vale de columna (decidido
 * el 2026-10-03). La etapa de ejercicio sigue igual para las pestañas de hoy.
 */

export interface FilaGastoKepler {
  sucursal?: unknown;
  solicitud_folio?: unknown;
  doc_folio?: unknown;
}

/** La llave de una solicitud: el folio sólo no alcanza, se repite entre plazas. */
export const llaveSolicitud = (folio: unknown, sucursal: unknown): string =>
  `${String(folio ?? '').trim()}|${String(sucursal ?? '').trim()}`;

/**
 * Agrupa los gastos `XA1001` por solicitud. Sin duplicados y en orden de folio, para que la
 * misma solicitud muestre siempre la misma lista.
 */
export function agruparGastosPorSolicitud(filas: readonly FilaGastoKepler[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of filas) {
    const sol = String(f.solicitud_folio ?? '').trim();
    const doc = String(f.doc_folio ?? '').trim();
    if (!sol || !doc) continue;
    const k = llaveSolicitud(sol, f.sucursal);
    const lista = out.get(k) ?? [];
    if (!lista.includes(doc)) lista.push(doc);
    out.set(k, lista);
  }
  for (const lista of out.values()) lista.sort();
  return out;
}

/**
 * Lo que viaja en cada fila. `null` en el proveedor = no se pudo leer de Kepler (vale sin
 * folio, vista ausente, o la columna no existe en este entorno): se DECLARA, no se rellena con
 * el nombre que tecleó quien capturó, que es otra cosa.
 */
export interface DatosKeplerDeLaFila {
  proveedor_clave: string | null;
  proveedor_nombre: string | null;
  gasto_folios: string[];
}

export function datosKeplerDeLaFila(
  kep: { cuenta_clave?: string | null; acreedor?: string | null } | undefined,
  gastos: Map<string, string[]>,
  folio: unknown,
  sucursal: unknown,
): DatosKeplerDeLaFila {
  const limpio = (v: unknown) => {
    const s = String(v ?? '').trim();
    return s ? s : null;
  };
  return {
    proveedor_clave: limpio(kep?.cuenta_clave),
    proveedor_nombre: limpio(kep?.acreedor),
    gasto_folios: [...(gastos.get(llaveSolicitud(folio, sucursal)) ?? [])],
  };
}
