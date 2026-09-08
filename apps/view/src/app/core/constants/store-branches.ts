/**
 * Sucursales **Kepler** (código '00'..'06' → nombre). Debe coincidir con el mapa
 * `BRANCHES` del poller (database/importers/kepler/live-tickets-poller.js), que
 * es lo que alimenta el monitor de Tienda. CEDIS (00) no vende al público.
 *
 * ⚠️ **No es la red completa.** Para cualquier módulo que no dependa del poller
 * —recepción, compras, alta de usuarios— usar `NETWORK_BRANCHES`, que incluye
 * las sucursales de Wincaja. Ver `WINCAJA_BRANCHES` abajo.
 */
export interface StoreBranch {
  code: string;
  name: string;
}

export const STORE_BRANCHES: StoreBranch[] = [
  { code: '00', name: 'CEDIS' },
  { code: '01', name: 'Padre Hidalgo' },
  { code: '02', name: 'La Piedad Abastos' },
  { code: '03', name: '8 Esquinas' },
  { code: '04', name: 'Yurécuaro' },
  { code: '05', name: 'Zamora Centro' },
  { code: '06', name: 'Canindo' },
];

/**
 * `[RE.23]` Sucursales que corren **Wincaja** y no tienen código Kepler. No
 * están en `STORE_BRANCHES` a propósito: el monitor de Tienda se alimenta del
 * poller de tickets de Kepler y para éstas no hay datos, así que ofrecerlas ahí
 * sería un filtro que siempre devuelve vacío.
 *
 * Sí son sucursales de la red —Morelia Abastos compra $89.7M al año y vende
 * $125M— y por eso entran a `NETWORK_BRANCHES`, que es lo que deben usar los
 * módulos alimentados por los feeds de compras/recepción.
 *
 * El código es el de 2 dígitos, no el `MD-30` de `commercial.warehouses.code`:
 * es lo que emiten los feeds y lo único que matchea. Ver `branchKeySql` en
 * platform-core.
 */
export const WINCAJA_BRANCHES: StoreBranch[] = [
  { code: '30', name: 'Morelia Abastos' },
  { code: '32', name: 'Morelia Madero' },
];

/** Las 9 sucursales de la red, sin importar qué punto de venta corran. */
export const NETWORK_BRANCHES: StoreBranch[] = [...STORE_BRANCHES, ...WINCAJA_BRANCHES];

/**
 * `[TDA.Wincaja]` Sucursales con **monitor de ventas EN VIVO** en `/tienda/live`.
 *
 * Hasta 2026-09-08 eran sólo las Kepler (`STORE_BRANCHES`), porque el monitor se alimentaba de un
 * único poller (el de `md.kdm1`). Desde que existe la réplica cruda continua de Wincaja
 * (`:5433/wincaja`, ~2 min) hay un segundo poller (`live-tickets-poller-wincaja.js`) que trae las
 * tiendas Wincaja que venden al público: Morelia Abastos (`30`) y Morelia Madero (`32`).
 *
 * NO están todas las de `WINCAJA_BRANCHES`: el CEDIS `00` es bodegón (no vende), y las rutas no
 * tienen POS de mostrador. Sólo las dos que el poller cubre.
 *
 * ⚠️ Transición en curso: Madero (`32`) está migrando su POS a Kepler (`md_07` → sucursal `07`).
 * Cuando el cutover complete, su venta llegará por el poller de Kepler como `07` y hay que SACAR
 * `32` de acá y del poller Wincaja — si no, el mismo ticket entraría por las dos fuentes con dos
 * códigos distintos. Mientras `32` siga vendiendo en Wincaja, va acá.
 */
export const LIVE_MONITOR_WINCAJA: StoreBranch[] = [
  { code: '30', name: 'Morelia Abastos' },
  { code: '32', name: 'Morelia Madero' },
];

/** Lo que el dropdown de `/tienda/live` ofrece: las Kepler + las Wincaja con poller en vivo. */
export const LIVE_MONITOR_BRANCHES: StoreBranch[] = [...STORE_BRANCHES, ...LIVE_MONITOR_WINCAJA];

/** Nombre de sucursal por código (fallback = el propio código). */
export function branchName(code?: string | null): string {
  if (!code) return '';
  return NETWORK_BRANCHES.find((b) => b.code === code)?.name ?? code;
}
