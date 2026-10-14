/**
 * `[GX.85]` **Cuando Kepler aplica la solicitud, el vale se cierra.**
 *
 * Decisión del usuario (2026-10-13), sobre la constancia «Autorizado y aplicado — el dinero
 * salió» (`XA1501-…` en `F`): *«el status se va a basar en esto porque tenemos un caos (…)
 * cuando ocurra ya puede cerrar el círculo, pasar directo a historial»*.
 *
 * ## Qué cambia respecto de GX.39
 * GX.39 dejó el ejercicio como dimensión APARTE de `status` para que un hecho de Kepler no
 * moviera nuestro trámite. Lo que costó, medido en prod el 2026-10-13: **13 vales abiertos**
 * (3 `recibida`, 7 `aprobada`, 3 `revision`) que Kepler ya tenía en `F` — el dinero ya había
 * salido y la persona seguía viendo el vale «pendiente» en la Suite. La `F` es el testigo que
 * acierta **7,949 de 7,949** (ver `ejercicio.contract.ts`): no hay falso positivo que temer.
 *
 * ## Qué NO cierra, a propósito
 *  · `rechazada`: es una decisión nuestra. Si Kepler pagó algo que aquí se devolvió, eso es un
 *    hallazgo para que alguien lo mire, no algo que se tape solo (4 casos en prod hoy).
 *  · `validada`: ya está cerrado.
 *  · Cualquier letra que no sea `F` (`A` autoriza pero el dinero no ha salido; `C` cancela).
 *  · Un folio que vive en OTRA sucursal: el folio no es único entre plazas (373 se repiten),
 *    así que el cruce va por `(sucursal, folio)` y nunca por el folio solo.
 */

/** Los estados de NUESTRO trámite que la `F` de Kepler puede cerrar. */
export const ESTADOS_QUE_CIERRA_KEPLER: readonly string[] = ['recibida', 'aprobada', 'revision'];

/** Quién firma el cierre. No es una persona: es el hecho de Kepler, y así se lee en el historial. */
export const FIRMA_CIERRE_KEPLER = 'Kepler: autorizado y aplicado (el dinero salió)';

export interface ValeAbierto {
  id: string;
  status: string;
  sucursal: string | null;
  folio_solicitud: string | null;
}

export interface SolicitudKepler {
  sucursal: string | null;
  folio: string | null;
  estado: string | null;
}

const llave = (sucursal: string | null | undefined, folio: string | null | undefined) =>
  `${String(sucursal ?? '').trim()}|${String(folio ?? '').trim()}`;

/** ¿Este vale se cierra con lo que dice Kepler? */
export function cierraPorKepler(status: string | null | undefined, estadoKepler: string | null | undefined): boolean {
  return estadoKepler === 'F' && ESTADOS_QUE_CIERRA_KEPLER.includes(String(status ?? ''));
}

/**
 * Los vales que se cierran: cruza por `(sucursal, folio)` y devuelve sus ids.
 * Un vale sin folio o sin sucursal no se cierra — sin la llave completa no se sabe cuál
 * solicitud de Kepler es la suya.
 */
export function valesQueCierraKepler(abiertos: readonly ValeAbierto[], solicitudes: readonly SolicitudKepler[]): string[] {
  const estado = new Map<string, string | null>();
  for (const s of solicitudes) estado.set(llave(s.sucursal, s.folio), s.estado);
  return abiertos
    .filter((v) => String(v.sucursal ?? '').trim() && String(v.folio_solicitud ?? '').trim())
    .filter((v) => cierraPorKepler(v.status, estado.get(llave(v.sucursal, v.folio_solicitud))))
    .map((v) => v.id);
}
