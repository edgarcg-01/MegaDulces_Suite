/**
 * `[VEC.1]` Tipo de ruta de venta — la definición ÚNICA, compartida por back y front.
 *
 * ── Por qué vive acá y no junto a su consumidor ─────────────────────────────────────────
 * ADR-052 / ADR-056: el tipo de procedencia nació el 02-sep en el backend y **a los tres días
 * ya estaba copiado a mano en el frontend**. Una etiqueta duplicada no falla — diverge, y el
 * día que alguien agregue un tipo, una de las dos pantallas lo muestra como clave pelada.
 *
 * Espejo exacto del CHECK de la migración `20261006130000_route_kind`. Si acá se agrega un
 * valor sin tocar el CHECK, `test-newdb-vecinal-flow.js` bloque `[1]` se pone rojo.
 *
 * ── Qué significa cada uno ──────────────────────────────────────────────────────────────
 * Los cinco salen del catálogo de vendedores de Kepler (`kepler_ods.kduv`), no de una lluvia
 * de ideas: `1Vnnn` vecinal · `1Dnnn` camión · `10Mnn` telemarketing · mayoreo · `1000n` piso.
 *
 * ⛔ **Kepler NO publica el tipo en ningún campo** (`kduv.c4`–`c14` vienen vacías en los 9
 * códigos probados), y las dos reglas obvias para derivarlo fallan: la letra `V` del código
 * incluye a `2V004` = TELEMARKETING MORELIA, y filtrar por el nombre "RUTA VECINAL" pierde
 * Morelia entera. Por eso el tipo se **declara** en `trade.catalogs.route_kind`.
 */

export type RouteKind = 'vecinal' | 'camion' | 'telemarketing' | 'mayoreo' | 'piso';

export const ROUTE_KINDS: readonly RouteKind[] = [
  'vecinal',
  'camion',
  'telemarketing',
  'mayoreo',
  'piso',
] as const;

/** Etiqueta de pantalla. Fuente única: un tipo nuevo no sale como `'camion'` pelado. */
export const ROUTE_KIND_LABEL: Record<RouteKind, string> = {
  vecinal: 'Vecinal',
  camion: 'Camión',
  telemarketing: 'Telemarketing',
  mayoreo: 'Mayoreo',
  piso: 'Piso',
};

/**
 * Lo que se muestra cuando NADIE declaró el tipo.
 *
 * ⚠️ No dice "Otro" ni "N/D": es una **ausencia con nombre**, y la pantalla tiene que poder
 * distinguirla de un tipo real. Un `route_kind` en NULL significa que la ruta existe y nadie
 * dijo qué es — no que sea de un sexto tipo.
 */
export const ROUTE_KIND_SIN_DECLARAR = 'Sin declarar';

export function routeKindLabel(k: string | null | undefined): string {
  return k && k in ROUTE_KIND_LABEL ? ROUTE_KIND_LABEL[k as RouteKind] : ROUTE_KIND_SIN_DECLARAR;
}

/**
 * Por qué un pedido no tiene tipo de ruta. **NULL no alcanza**: cada motivo tiene un dueño
 * distinto, y si los dos se ven igual nadie sabe a quién llamar (ADR-056).
 */
export type RouteKindMotivo =
  /** El cliente no tiene `sales_route`. Lo arregla quien captura al cliente. */
  | 'cliente_sin_ruta'
  /** La ruta existe pero nadie declaró su tipo. Lo arregla Dirección (`[VEC.1]`). */
  | 'ruta_sin_declarar';

export const ROUTE_KIND_MOTIVO_LABEL: Record<RouteKindMotivo, string> = {
  cliente_sin_ruta: 'El cliente no tiene ruta asignada',
  ruta_sin_declarar: 'Nadie declaró de qué tipo es esta ruta',
};
