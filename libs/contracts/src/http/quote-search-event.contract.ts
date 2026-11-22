/**
 * `[COT.53]` Un evento del buscador de artículos del cotizador — la forma del wire de
 * `POST /commercial/quotes/search-events`. Se guarda ANÓNIMO y agregado
 * (`commercial.quote_search_stats`): por día, sucursal, término, artículo elegido y posición.
 * Ni el evento ni la tabla llevan quién buscó (decisión de Francisco, 2026-11-22).
 *
 * Dos momentos: se ELIGIÓ un artículo (`chosen_sku` + `position`), o la búsqueda NO trajo nada
 * (`results = 0`, sin `chosen_sku`).
 */
export interface EventoBusquedaCotizacion {
  branch: string;
  term: string;
  /** El SKU elegido; ausente o null = la búsqueda no trajo nada. */
  chosen_sku?: string | null;
  /** 1 = el primero de la lista. Sólo con `chosen_sku`. */
  position?: number | null;
  /** Cuántos artículos mostraba la lista. */
  results: number;
}

export interface BusquedaRegistrada {
  /** false = no se guardó (término vacío, o un evento que no dice nada). No es un error. */
  registrada: boolean;
}

/** Tope del término guardado: lo que alguien teclea buscando un artículo, no un párrafo. */
export const LARGO_TERMINO_BUSQUEDA = 80;

/**
 * El término como se cuenta: sin espacios de más y en minúsculas, para que «Mazapan » y
 * «mazapan» sumen en el mismo renglón. Los acentos se conservan: son parte de lo que se tecleó.
 */
export function normalizarTerminoBusqueda(term: string | null | undefined): string {
  return (term ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, LARGO_TERMINO_BUSQUEDA);
}
