// [TDA.1] Eventos del proyecto Tienda que viajan por WebSocket, compartidos por backend y frontend
// (ADR-052 / ADR-056).
//
// ── POR QUÉ ACÁ ──────────────────────────────────────────────────────────────────────────
// El módulo de tienda ya tiene `LiveTicket` y `StoreAlert` escritos DOS veces a mano —una en
// `apps/api/src/modules/store/store.types.ts` y otra en
// `apps/view/.../tienda/store-socket.service.ts`— porque un tipo de `apps/api` no se puede importar
// desde `apps/view`. Es el patrón exacto que `provenance.contract.ts` existe para cortar: dos
// declaraciones del mismo hecho que se separan en silencio y nadie se entera hasta que el payload
// cambia de un lado.
//
// El evento nuevo entra derecho acá. Los dos viejos NO se retrofitean en este pase: son 3 interfaces
// con campos opcionales en uso vivo, y mezclar el retrofit con la feature haría un diff donde no se
// puede ver qué cambió de comportamiento. Queda anotado como deuda con nombre.

/**
 * El precio de etiqueta de estos productos cambió en Kepler y ya está recomputado en la base.
 *
 * ── Qué problema resuelve que esto exista ────────────────────────────────────────────────
 * La cadena Kepler → base es rápida (replicación lógica → carril hash @15 s → `hop-2` sincrónico),
 * pero el último tramo no existía: el sistema es 100 % pull y la etiquetera sólo consulta el precio
 * cuando el operador escanea, con la frescura congelada pegada a cada ítem de la cola. Si se
 * corregía un precio mientras alguien tenía etiquetas en cola, esas filas conservaban el precio
 * viejo **y se imprimían así**. Es el incidente del SKU 88222 visto desde la pantalla: se arregló en
 * Kepler un precio 54 % bajo costo y el cambio no llegaba.
 *
 * ── Cómo leerlo sin equivocarse ──────────────────────────────────────────────────────────
 * · Lleva `product_id`, no `sku`: es la llave que la pantalla ya tiene por ítem (la devuelve
 *   `resolve`), así que el match es exacto y no hay que resolver nada de vuelta.
 * · **`truncated` no es un detalle.** En un cambio masivo de catálogo la lista viene recortada; ahí
 *   la pantalla tiene que asumir que CUALQUIERA de sus filas puede estar vieja, en vez de creerle a
 *   una lista parcial y dar por buenas las que no aparecen.
 * · Es un AVISO, no el dato. El precio nuevo se pide por HTTP como siempre. Un aviso perdido
 *   degrada al comportamiento viejo (se ve al siguiente escaneo), nunca a un precio inventado.
 */
export interface LabelPricesChanged {
  /** Los productos que cambiaron. Puede venir recortada — ver `truncated`. */
  product_ids: string[];
  /** Cuántos cambiaron en total. Puede ser mayor que `product_ids.length`. */
  total: number;
  /** `true` = la lista está recortada y no alcanza para decidir qué NO cambió. */
  truncated: boolean;
  /** ISO del momento en que se recomputaron. */
  at: string;
}
