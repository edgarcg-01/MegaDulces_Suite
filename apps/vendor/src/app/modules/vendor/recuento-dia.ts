import type { SellerDayMissedCustomer, SellerDayOrder, SellerDayRecap, SellerDayVisits } from '@megadulces/contracts';
import { NO_SALE_OPTIONS } from './visit-protocol';

/**
 * `[MCP.19]` Las frases del recuento del día, sin Angular (se prueban solas). `propio` = lo lee el
 * vendedor de sí mismo («levantaste»); si no, su supervisor («levantó»).
 */

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
export const dinero = (n: number | string | null | undefined): string => pesos.format(Number(n) || 0);

const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`;

/** «Levantaste 7 pedidos» · «Todavía no levantas pedidos hoy». */
export function fraseLevantado(r: SellerDayRecap, propio: boolean): string {
  const hoy = r.date === r.today;
  if (!r.orders.count) {
    if (propio) return hoy ? 'Todavía no levantas pedidos hoy.' : 'No levantaste pedidos ese día.';
    return hoy ? 'Todavía no levanta pedidos hoy.' : 'No levantó pedidos ese día.';
  }
  return `${propio ? 'Levantaste' : 'Levantó'} ${plural(r.orders.count, 'pedido', 'pedidos')}`;
}

const MOTIVO = new Map<string, string>(NO_SALE_OPTIONS.map((o) => [o.key, o.label.toLowerCase()]));
const textoMotivo = (k: string): string => (k === 'sin_motivo' ? 'sin motivo' : MOTIVO.get(k) ?? k);

/** «Visitaste 9 de los 12 clientes de tu ruta y 1 fuera de ella» · sin ruta: «Sin ruta asignada · visitaste 3 clientes». */
export function fraseVisitas(v: SellerDayVisits, propio: boolean): string {
  const visito = propio ? 'Visitaste' : 'Visitó';
  if (!v.route_customers) {
    return `Sin ruta asignada · ${visito.toLowerCase()} ${plural(v.visited, 'cliente', 'clientes')}`;
  }
  const fuera = v.off_route ? ` y ${v.off_route} fuera de ella` : '';
  return `${visito} ${v.visited_on_route} de ${plural(v.route_customers, 'cliente', 'clientes')} de ${propio ? 'tu' : 'su'} ruta${fuera}`;
}

/** «7 con pedido · 2 sin venta (1 estaba cerrado, 1 sin motivo) · 1 visita sin cerrar». */
export function fraseResultadoVisitas(v: SellerDayVisits): string {
  const partes = [`${v.with_order} con pedido`];
  if (v.without_order) {
    const motivos = v.no_sale_reasons.map((m) => `${m.count} ${textoMotivo(m.reason)}`).join(', ');
    partes.push(`${v.without_order} sin venta${motivos ? ` (${motivos})` : ''}`);
  }
  if (v.open) partes.push(plural(v.open, 'visita sin cerrar', 'visitas sin cerrar'));
  return partes.join(' · ');
}

/** Por qué un cliente de la ruta no tiene visita, en palabras de la calle. */
export function estadoCliente(c: SellerDayMissedCustomer, propio: boolean): string {
  switch (c.state) {
    case 'no_paso': return propio ? 'No pasaste' : 'No pasó';
    case 'se_fue_sin_abrir': return propio ? 'Pasaste y no lo abriste' : 'Pasó y no lo abrió';
    case 'pendiente': return 'Por visitar';
    case 'sin_ubicacion': return 'Sin visita · el cliente no tiene ubicación';
    case 'sin_gps': return 'Sin visita · sin GPS ese día';
    default: return 'Sin visita';
  }
}

/** Una fila del bloque «Cómo van al surtir»: sólo las que tienen algo. */
export interface FilaSurtido {
  clave: 'completo' | 'con_faltantes' | 'surtiendo' | 'sin_surtir' | 'sin_dato' | 'cobrados' | 'entregados';
  texto: string;
  n: number;
  detalle: string;
  icono: string;
  tono: 'ok' | 'warn' | 'info' | 'muted';
}

export function filasSurtido(r: SellerDayRecap): FilaSurtido[] {
  const p = r.picking;
  if (!p) return [];
  const filas: FilaSurtido[] = [
    { clave: 'completo', texto: 'Surtidos completos', n: p.completo, detalle: '', icono: 'pi-check-circle', tono: 'ok' },
    { clave: 'con_faltantes', texto: 'Surtidos con faltantes', n: p.con_faltantes, detalle: p.removed_total > 0 ? `se quitaron ${dinero(p.removed_total)}` : '', icono: 'pi-exclamation-circle', tono: 'warn' },
    { clave: 'surtiendo', texto: 'Los están surtiendo', n: p.surtiendo, detalle: '', icono: 'pi-clock', tono: 'info' },
    { clave: 'sin_surtir', texto: 'Esperan al surtidor', n: p.sin_surtir, detalle: '', icono: 'pi-inbox', tono: 'muted' },
    { clave: 'sin_dato', texto: 'Sin dato del surtido', n: p.sin_dato, detalle: 'no se pudo leer', icono: 'pi-question-circle', tono: 'muted' },
    { clave: 'cobrados', texto: 'Cobrados en Kepler', n: p.charged + p.charged_to_confirm, detalle: p.charged_to_confirm ? `${p.charged_to_confirm} por confirmar` : '', icono: 'pi-wallet', tono: 'ok' },
    { clave: 'entregados', texto: 'Entregados', n: p.delivered, detalle: '', icono: 'pi-truck', tono: 'ok' },
  ];
  return filas.filter((f) => f.n > 0);
}

/**
 * `[MCP.21]` El surtido en una línea, para «Pedidos»: «1 surtido completo · 1 con faltantes (−$40.00) · 1 espera al
 * surtidor». Sólo los estados del surtido, que se excluyen entre sí y suman los pedidos del día; cobrados y entregados
 * se cruzan con ellos y van en el detalle.
 */
export function resumenSurtido(r: SellerDayRecap): string {
  const p = r.picking;
  if (!p) return '';
  const partes = [
    p.completo ? plural(p.completo, 'surtido completo', 'surtidos completos') : '',
    p.con_faltantes ? `${p.con_faltantes} con faltantes${p.removed_total > 0 ? ` (−${dinero(p.removed_total)})` : ''}` : '',
    p.surtiendo ? `${p.surtiendo} surtiéndose` : '',
    p.sin_surtir ? plural(p.sin_surtir, 'espera al surtidor', 'esperan al surtidor') : '',
    p.sin_dato ? `${p.sin_dato} sin dato del surtido` : '',
  ];
  return partes.filter(Boolean).join(' · ');
}

/** Los pedidos detrás de una fila de surtido (el desglose: cada número abre los suyos). */
export function pedidosDeFila(r: SellerDayRecap, clave: FilaSurtido['clave']): SellerDayOrder[] {
  const ls = r.orders_list;
  if (clave === 'cobrados') return ls.filter((o) => o.charge !== null);
  if (clave === 'entregados') return ls.filter((o) => o.delivered);
  return ls.filter((o) => o.pick === clave);
}

/** ¿Hay algo pendiente que mostrar? (Lo del celular sin enviar lo dice la pantalla del vendedor aparte.) */
export function hayPendiente(r: SellerDayRecap, conClientes: boolean): boolean {
  return !!(r.pending.drafts.length || r.pending.awaiting_approval.length || r.cancelled.length
    || (conClientes && r.visits?.not_visited.length));
}

/** «Hoy» · «Lunes 9 de noviembre». */
export function tituloDelDia(r: SellerDayRecap): string {
  if (r.date === r.today) return 'Hoy';
  const [y, m, d] = r.date.split('-').map(Number);
  const t = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return t.charAt(0).toUpperCase() + t.slice(1);
}
