// [MCP.3.14] El vendedor ve UN pedido aunque lo surtan varias sucursales de su zona. Sólo cuando
// surten dos o más, se le dice en qué va cada una (David, 2026-10-26).
import type { OrderGroupPart } from '../portal/portal.service';

export type TonoSucursal = 'ok' | 'info' | 'warn' | 'bad' | 'muted';

export interface EstadoSucursal {
  /** Nombre corto de la sucursal (PH, LPA…); el nombre o el folio si no tiene. */
  short: string;
  etiqueta: string;
  tono: TonoSucursal;
}

/** En qué va UNA parte: lo que pasó con el pedido manda sobre el surtido. */
export function estadoDeParte(p: Pick<OrderGroupPart, 'status' | 'pick'>): Omit<EstadoSucursal, 'short'> {
  if (p.status === 'cancelled') return { etiqueta: 'Cancelado', tono: 'bad' };
  if (p.status === 'fulfilled') return { etiqueta: 'Entregado', tono: 'ok' };
  switch (p.pick) {
    case 'completo': return { etiqueta: 'Surtido', tono: 'ok' };
    case 'con_faltantes': return { etiqueta: 'Surtido con faltantes', tono: 'warn' };
    case 'surtiendo': return { etiqueta: 'Surtiendo', tono: 'info' };
    case 'por_surtir': return { etiqueta: 'Por surtir', tono: 'muted' };
    // Sin dato del surtido: se dice, no se pinta como «por surtir».
    default: return { etiqueta: 'Sin dato de surtido', tono: 'muted' };
  }
}

/** Estado por sucursal, la principal primero. Vacío si el pedido surte en UNA sola sucursal. */
export function sucursalesDelPedido(o: { group_parts?: OrderGroupPart[] | null }): EstadoSucursal[] {
  const partes = o.group_parts ?? [];
  if (partes.length < 2) return [];
  return partes.map((p) => ({
    short: p.warehouse_short || p.warehouse_name || p.code,
    ...estadoDeParte(p),
  }));
}

/** Una línea para leer de corrido: «LPA Surtido · PH Por surtir». */
export const textoSucursales = (ss: EstadoSucursal[]): string =>
  ss.map((s) => `${s.short} ${s.etiqueta}`).join(' · ');
