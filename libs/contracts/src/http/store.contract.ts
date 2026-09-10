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

/**
 * [TDA.4] Un escalón de mayoreo, tal como lo publica el mostrador.
 *
 * ── Por qué esto existe ──────────────────────────────────────────────────────────────────
 * Medido en prod (2026-09-09): **8,481 de 9,020 productos (94 %) tienen mayoreo real**. No es un
 * extra: es el caso normal, y el verificador —la pantalla donde se cierra la venta— no lo mostraba.
 *
 * ── Cómo leerlo sin equivocarse ──────────────────────────────────────────────────────────
 * · **`desde` es SIEMPRE un umbral real del ERP**, nunca un default. Si Kepler no lo tiene, el tier
 *   no viaja — la etiquetera aprendió por las malas que *"un mayoreo cuya condición de cantidad no
 *   se conoce fabrica una discusión en el mostrador"*. Un `MayoreoTier` que llega es un tier que se
 *   puede afirmar.
 * · **`realza` separa el DATO de la SEÑAL.** El precio es cierto igual, pero por debajo del 1 % de
 *   descuento pintarlo como oferta sería mentir con el color. Medido: 366 tiers caen ahí.
 * · **`ahorro_en_el_minimo` es lo que cierra la venta**: no es lo mismo "$44.57 c/u" que "llevando
 *   10 te ahorrás $14.10".
 * · `palabra` sale de la unidad BASE del producto, no del tier: si la base es KG, "desde 20 piezas"
 *   sería falso — son 20 kilos.
 */
export interface MayoreoTier {
  /** `pieza` | `paquete` — de qué escalera es este tier. */
  etiqueta: string;
  /** El umbral REAL del ERP. Nunca un default. */
  desde: number;
  /** piezas / paquetes / cajas / kg. */
  palabra: string;
  precio_con_iva: number;
  ahorro_por_unidad: number;
  ahorro_en_el_minimo: number;
  descuento_pct: number;
  /** `true` = el descuento es perceptible (≥ 1 %) y merece señal visual. */
  realza: boolean;
}

/**
 * El mismo tier con las claves cortas del snapshot offline.
 *
 * No es una segunda definición: el cómputo y las reglas viven una sola vez, del lado del servidor.
 * Esto es la codificación del cable, y la comparte el resto del snapshot (`c`/`b`/`bu`/`n`/`u`).
 * Medido: con nombres largos el snapshot crecía **1,386 KB crudos** y los nombres eran el **51 %**
 * de los bytes, repetidos 8,383 veces — medio mega de nombres de campo por cero información.
 */
export interface MayoreoTierCompacto {
  e: string;
  d: number;
  w: string;
  p: number;
  au: number;
  am: number;
  pc: number;
  r: 0 | 1;
}

/**
 * Comprime un tier a la forma de cable. Vive PEGADO a su inversa a propósito: son las dos
 * mitades de la misma codificación y separarlas es cómo se desincronizan.
 */
export function compactarTier(t: MayoreoTier): MayoreoTierCompacto {
  return {
    e: t.etiqueta,
    d: t.desde,
    w: t.palabra,
    p: t.precio_con_iva,
    au: t.ahorro_por_unidad,
    am: t.ahorro_en_el_minimo,
    pc: t.descuento_pct,
    r: t.realza ? 1 : 0,
  };
}

/** Expande la forma de cable. Es la inversa exacta de `compactarTier`. */
export function expandirTier(t: MayoreoTierCompacto): MayoreoTier {
  return {
    etiqueta: t.e,
    desde: t.d,
    palabra: t.w,
    precio_con_iva: t.p,
    ahorro_por_unidad: t.au,
    ahorro_en_el_minimo: t.am,
    descuento_pct: t.pc,
    realza: t.r === 1,
  };
}
