/**
 * Sucursales Kepler (código '00'..'05' → nombre). Fuente canónica única para el
 * filtro del monitor Tienda y la asignación de sucursal en admin de usuarios.
 * Debe coincidir con el mapa `BRANCHES` del poller
 * (database/importers/kepler/live-tickets-poller.js). CEDIS (00) no vende al público.
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
];

/** Nombre de sucursal por código (fallback = el propio código). */
export function branchName(code?: string | null): string {
  if (!code) return '';
  return STORE_BRANCHES.find((b) => b.code === code)?.name ?? code;
}
