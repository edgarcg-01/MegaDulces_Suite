/**
 * `[MCP.21]` Cómo va cada cliente de «Mi ruta»: lo que dice su renglón sin tener que abrirlo.
 * Puro (sin Angular): se prueba solo en `ruta-estado.spec.ts`.
 *
 * Medido en prod el 2026-11-11 (30 días, 780 visitas): 54 % terminó con pedido, 6 % con «no pidió»
 * y 40 % se abrió y nunca se cerró. Abrir al cliente ya registra la llegada, pero no dice si pidió:
 * por eso «Visitado» es un estado aparte y no se pinta como hecho. Y ningún cliente visitado tenía
 * orden de visita (475 de 475): el círculo de la izquierda mostraba «·» en todos.
 */
import type { HomeCustomer, HomePendingOrder } from './vendor.service';
import type { Order } from '../portal/portal.service';
import { motivoNoVenta } from './supervisor-equipo';
import { toMxDateKey } from '../../core/utils/mx-date';

export type ClaveEstado = 'pedido' | 'no_pidio' | 'visitado' | 'sin_visita';

export interface EstadoCliente {
  clave: ClaveEstado;
  /** Lo que se lee en el renglón. */
  texto: string;
  /** Icono del círculo; `null` = sin visita (va su orden de visita, si tiene). */
  icono: string | null;
}

type ClienteParaEstado = Pick<HomeCustomer, 'ordered_today' | 'visited_today' | 'no_sale_reason_today'>;

/**
 * Lo que pasó hoy con el cliente, del más fuerte al más débil: si pidió, eso manda aunque antes se
 * haya marcado «no pidió». `montoHoy` = lo que le levantó hoy esta vendedora, ya con formato; `null`
 * si el pedido de hoy no es suyo (un pedido del portal, otro vendedor).
 */
export function estadoDelCliente(c: ClienteParaEstado, montoHoy: string | null): EstadoCliente {
  if (c.ordered_today) {
    return { clave: 'pedido', texto: montoHoy ? `Pedido hoy ${montoHoy}` : 'Pedido hoy', icono: 'pi-check' };
  }
  if (c.no_sale_reason_today) {
    const motivo = motivoNoVenta(c.no_sale_reason_today);
    return { clave: 'no_pidio', texto: motivo ? `No pidió · ${motivo}` : 'No pidió', icono: 'pi-ban' };
  }
  if (c.visited_today) {
    return { clave: 'visitado', texto: 'Visitado, sin cerrar', icono: 'pi-map-marker' };
  }
  return { clave: 'sin_visita', texto: 'Sin visita', icono: null };
}

/** Lo levantado hoy por cliente (sin borradores ni cancelados). Un pedido agrupado ya viene sumado. */
export function ventaDeHoyPorCliente(pedidos: readonly Pick<Order, 'customer_id' | 'status' | 'total'>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of pedidos) {
    if (o.status === 'draft' || o.status === 'cancelled') continue;
    const n = Number(o.total);
    if (!Number.isFinite(n)) continue;
    out.set(o.customer_id, (out.get(o.customer_id) ?? 0) + n);
  }
  return out;
}

type Pendiente = Pick<HomePendingOrder, 'id' | 'total' | 'created_at' | 'is_preventa' | 'group_id'>;

/**
 * Pedidos de días anteriores que siguen por entregar (sin preventas, que tienen su propia etiqueta).
 * Los de hoy no cuentan aquí: ya los dice «Pedido hoy», y contarlos dos veces era el «1 por entregar»
 * pegado al mismo pedido. Un pedido agrupado cuenta una vez.
 */
export function anterioresPorEntregar(pendientes: readonly Pendiente[], hoy: string): number {
  const grupos = new Set<string>();
  for (const o of pendientes) {
    if (o.is_preventa) continue;
    // Como Date: con el texto ISO, toMxDateKey corta en la «T» y daría el día UTC (un pedido de las 8 p. m. caería mañana).
    if (toMxDateKey(new Date(o.created_at)) === hoy) continue;
    grupos.add(o.group_id ?? o.id);
  }
  return grupos.size;
}

/** El monto de las preventas pendientes, sólo de ellas (antes se sumaban también los pedidos del vendedor). */
export function montoPreventa(pendientes: readonly Pendiente[]): number {
  return pendientes.filter((o) => o.is_preventa).reduce((s, o) => s + (Number(o.total) || 0), 0);
}
