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

/** Nombre de sucursal por código (fallback = el propio código). */
export function branchName(code?: string | null): string {
  if (!code) return '';
  return NETWORK_BRANCHES.find((b) => b.code === code)?.name ?? code;
}
